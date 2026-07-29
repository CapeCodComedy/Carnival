/* Create checkout — the ONE place a hard hold is taken (spec §3.2 steps 3-4).
   Atomic claim first; Stripe session only if the claim wins; release on any
   failure after the claim. Hard hold TTL (35 min) ≥ session lifetime (30 min):
   the §5 law, enforced by constants that live in house.json. */
const store = require("./lib/store");
const { HOUSE, seat, priceCart } = require("./lib/house");
const { stripe } = require("./lib/stripe-adapter");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "POST" };
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, body: "bad json" }; }
  const { holder, seats, accessible } = body;
  if (!holder || !Array.isArray(seats) || !seats.length) return resp(400, { err: "holder+seats required" });
  if (seats.length > HOUSE.maxPerOrder) return resp(400, { err: `max ${HOUSE.maxPerOrder} per order` });

  /* wheelchair spaces only purchasable through the accessible (terms-gated) flow */
  for (const id of seats) {
    const s = seat(id);
    if (!s) return resp(400, { err: `unknown seat ${id}` });
    if (s.wc && !accessible) return resp(400, { err: "wheelchair spaces book through the accessible flow" });
  }

  const priced = priceCart(seats, !!accessible);
  if (!priced.ok) return resp(400, { err: priced.err });

  /* accessible flow may include the paired companion seat: release its
     console hold just-in-time so the atomic claim can take it */
  if (accessible) {
    const companions = seats.filter(id => !seat(id).wc);
    if (companions.length) await store.adminRelease(companions);
  }

  /* THE claim — hard hold, all seats or none */
  const claim = await store.claim(holder, seats, HOUSE.hardHoldSec);
  if (!claim.ok) {
    if (accessible) { // restore companion hold if the claim lost
      for (const id of seats.filter(id => !seat(id).wc)) await store.adminHold([id], "companion");
    }
    return resp(409, { err: "seat taken", seat: claim.seat });
  }

  const siteUrl = process.env.SITE_URL || "";
  const zoneName = HOUSE.zones[priced.zone];
  try {
    const line_items = seats.map(id => ({
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: (seat(id).wc || accessible) ? HOUSE.wheelchair.price * 100 : HOUSE.prices[seat(id).zone] * 100,
        product_data: { name: `${zoneName} — Seat ${id}${seat(id).wc ? " (wheelchair space)" : ""}` },
      },
    }));
    if (priced.feeCents > 0) line_items.push({
      quantity: seats.length,
      price_data: {
        currency: "usd",
        unit_amount: Math.round(priced.feeCents / seats.length),
        product_data: { name: "Card processing fee (passed through at cost — the 1140A Corporation keeps none of it)" },
      },
    });

    const session = await stripe.createSession({
      mode: "payment",
      line_items,
      expires_at: Math.floor(Date.now() / 1000) + HOUSE.stripeSessionSec,
      success_url: `${siteUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/?canceled=1`,
      metadata: { seats: seats.join(","), holder, accessible: accessible ? "1" : "0" },
    });

    await store.putOrder(session.id, {
      holder, seats, zone: priced.zone, accessible: !!accessible,
      totalCents: priced.totalCents, feeCents: priced.feeCents,
      status: "pending", created: Date.now(), payment_intent: session.payment_intent || null,
    });
    return resp(200, { url: session.url, sid: session.id });
  } catch (e) {
    await store.release(holder, seats);            // never leave orphaned holds on failure
    if (accessible) for (const id of seats.filter(id => !seat(id).wc)) await store.adminHold([id], "companion");
    return resp(502, { err: "payment session failed — seats released", detail: String(e.message || e).slice(0, 200) });
  }
};
const resp = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

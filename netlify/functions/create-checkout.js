/* Create checkout, the ONE place a hard hold is taken (spec §3.2 steps 3-4).
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
  /* station codes (radio buy, v3.15): a valid code waives the card fee, order tags the station */
  const STATION_CODES = new Set(["Y101", "FRANK", "PIXY"]);
  const _raw = String(body.code || "").trim().toUpperCase();
  const station = STATION_CODES.has(_raw) ? _raw : null;
  /* org fundraiser codes (v3.18): pure tracking, price untouched, fee untouched.
     v3.51: every seat pays the half; orgCodesEnabled=false in house.json closes the offer. */
  const ORG_CODES = new Set((HOUSE.orgCodes || []).map(c => String(c).toUpperCase()));
  const org = (HOUSE.orgCodesEnabled !== false && !station && ORG_CODES.has(_raw)) ? _raw : null;
  const src = String(body.src || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) || null;
  /* tee add-on (v3.30): bundle-priced merch line that exists only inside a ticket purchase */
  const MERCH = HOUSE.merch || {};
  let tee = null;
  if (body.tee && MERCH.teeBundleCents) {
    const _q = parseInt(body.tee.qty, 10) || 0;
    const _size = String(body.tee.size || "").toUpperCase();
    if (_q > 0 && _q <= 10 && (MERCH.teeSizes || []).includes(_size)) tee = { qty: _q, size: _size };
  }
  if (seats.length > HOUSE.maxPerOrder) return resp(400, { err: `max ${HOUSE.maxPerOrder} per order` });

  /* wheelchair spaces only purchasable through the accessible (terms-gated) flow */
  for (const id of seats) {
    const s = seat(id);
    if (!s) return resp(400, { err: `unknown seat ${id}` });
    if (s.wc && !accessible) return resp(400, { err: "wheelchair spaces book through the accessible flow" });
  }

  const priced = priceCart(seats, !!accessible);
  if (!priced.ok) return resp(400, { err: priced.err });

  /* org eligibility + owed (half the ticket price per eligible seat, v3.27;
     v3.51: the 160-seat room: HOUSE and SPLASH both pay the half;
     the accessible flow stays out) */
  const ORG_TIERS = new Set(["house", "splash"]);
  const ORG_SHARE = HOUSE.orgShare || 0.5;
  let orgEligible = 0, orgOwedCents = 0; const _tc = {};
  if (org && !accessible) for (const id of seats) {
    const s = seat(id);
    if (!s.wc && ORG_TIERS.has(s.zone)) {
      orgEligible++; _tc[s.zone] = (_tc[s.zone] || 0) + 1;
      orgOwedCents += Math.round(HOUSE.prices[s.zone] * 100 * ORG_SHARE);
    }
  }
  const orgTiers = org ? Object.entries(_tc).map(([z, n]) => z + ":" + n).join(",") : "";
  const orgOwed = org ? (orgOwedCents / 100).toFixed(2) : "";

  /* accessible flow may include the paired companion seat: release its
     console hold just-in-time so the atomic claim can take it */
  if (accessible) {
    const companions = seats.filter(id => !seat(id).wc);
    if (companions.length) await store.adminRelease(companions);
  }

  /* THE claim, hard hold, all seats or none */
  const claim = await store.claim(holder, seats, HOUSE.hardHoldSec);
  if (!claim.ok) {
    if (accessible) { // restore companion hold if the claim lost
      for (const id of seats.filter(id => !seat(id).wc)) await store.adminHold([id], "companion");
    }
    return resp(409, { err: "seat taken", seat: claim.seat });
  }

  const siteUrl = process.env.SITE_URL || "";
  try {
    /* v3.55: mixed orders, each line item carries its own kind's name */
    const line_items = seats.map(id => ({
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: (seat(id).wc || accessible) ? HOUSE.wheelchair.price * 100 : HOUSE.prices[seat(id).zone] * 100,
        product_data: { name: `${HOUSE.zones[seat(id).zone]}, unreserved admission${seat(id).wc ? " (wheelchair space)" : ""}` },
      },
    }));
    const feeCents = priced.feeCents;   /* v3.28: station codes are tee + attribution only, fee charged normally */
    if (feeCents > 0) line_items.push({
      quantity: seats.length,   /* v3.59: $3 per ticket, the standing law */
      price_data: {
        currency: "usd",
        unit_amount: Math.round(feeCents / seats.length),
        product_data: { name: "Card processing fee, $3 per ticket (the 1140A Corporation keeps none of it)" },
      },
    });

    if (tee) line_items.push({
      quantity: tee.qty,
      price_data: {
        currency: "usd",
        unit_amount: MERCH.teeBundleCents,
        product_data: { name: `${MERCH.teeName || "Show tee"}, size ${tee.size} (ticket-bundle price), claimed at will-call on show night` },
      },
    });

    const session = await stripe.createSession({
      mode: "payment",
      line_items,
      expires_at: Math.floor(Date.now() / 1000) + HOUSE.stripeSessionSec,
      success_url: `${siteUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/?canceled=1`,
      metadata: { seats: seats.join(","), holder, accessible: accessible ? "1" : "0", station: station || "", org: org || "", org_eligible: String(orgEligible), org_tiers: orgTiers, org_owed: orgOwed, src: src || "", tee_qty: tee ? String(tee.qty) : "", tee_size: tee ? tee.size : "" },
      payment_intent_data: { metadata: { seats: seats.join(","), holder, station: station || "", org: org || "", org_eligible: String(orgEligible), org_tiers: orgTiers, org_owed: orgOwed, src: src || "", tee_qty: tee ? String(tee.qty) : "", tee_size: tee ? tee.size : "" } },
    });

    await store.putOrder(session.id, {
      holder, seats, zone: priced.zone, accessible: !!accessible,
      totalCents: priced.ticketCents + feeCents + (tee ? tee.qty * MERCH.teeBundleCents : 0), feeCents, station,
      org, orgEligible, orgTiers, orgOwedCents, src, tee,
      status: "pending", created: Date.now(), payment_intent: session.payment_intent || null,
    });
    return resp(200, { url: session.url, sid: session.id });
  } catch (e) {
    await store.release(holder, seats);            // never leave orphaned holds on failure
    if (accessible) for (const id of seats.filter(id => !seat(id).wc)) await store.adminHold([id], "companion");
    return resp(502, { err: "payment session failed, seats released", detail: String(e.message || e).slice(0, 200) });
  }
};
const resp = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

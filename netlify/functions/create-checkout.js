/* Create checkout, the ONE place a hard hold is taken (spec §3.2 steps 3-4).
   Atomic claim first; Stripe session only if the claim wins; release on any
   failure after the claim. Hard hold TTL (35 min) ≥ session lifetime (30 min):
   the §5 law, enforced by constants that live in house.json. */
const store = require("./lib/store");
const codes = require("./lib/codes");
const { HOUSE, seat, priceCart } = require("./lib/house");
const { stripe } = require("./lib/stripe-adapter");

/* free-ticket pool (v3.75): atomic take from a capped counter; -1 = pool spent */
const LUA_POOL_TAKE = `
local key = 'free:' .. ARGV[1]
local limit = tonumber(ARGV[2])
local want = tonumber(ARGV[3])
local used = tonumber(redis.call('GET', key) or '0')
if used + want > limit then return -1 end
redis.call('INCRBY', key, want)
return limit - used - want
`;
const LUA_POOL_BACK = `redis.call('DECRBY', 'free:' .. ARGV[1], tonumber(ARGV[2])) return 1`;

/* single-use codes (v3.77): a code that works for exactly ONE checkout, ever.
   Burn is atomic at checkout creation; an expired unpaid session un-burns it
   (webhook), a completed payment keeps it burned for good. */
const LUA_ONCE_TAKE = `
local key = 'once:' .. ARGV[1]
if tonumber(redis.call('GET', key) or '0') >= 1 then return -1 end
redis.call('INCR', key)
return 0
`;
const LUA_ONCE_BACK = `redis.call('DEL', 'once:' .. ARGV[1]) return 1`;

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
  /* discount codes (v3.69): the first price-changing code, data-driven from
     house.json. CARNIVAL: 20% off HOUSE for the comics' own email lists.
     Station and org codes win the field if they match; the accessible flow
     is never discounted; the fee stays $3 per ticket, the standing law. */
  const DISCOUNTS = HOUSE.discounts || {};
  const disc = (!station && !org && DISCOUNTS[_raw] && DISCOUNTS[_raw].enabled !== false) ? { code: _raw, off: DISCOUNTS[_raw].off || 0, tiers: new Set(DISCOUNTS[_raw].tiers || []), once: !!DISCOUNTS[_raw].once, maxSeats: DISCOUNTS[_raw].maxSeats || 0 } : null;
  /* v3.77: single-use codes are tier-locked and size-locked, server-enforced */
  if (disc && disc.once) {
    if (accessible) return resp(400, { err: "That code does not combine with the accessible flow. Book the accessible seats plain, they are already the low price." });
    if (disc.maxSeats && seats.length > disc.maxSeats) return resp(400, { err: "That code covers one ticket, or two, no more." });
    for (const id of seats) {
      const s = seat(id);
      if (!s || s.wc || !disc.tiers.has(s.zone)) return resp(400, { err: "That code covers Splash Zone and Premium tickets only. Take the others out of the order to use it." });
    }
  }
  /* free-ticket codes (v3.75): MIDCAPE grants a capped pool of free GENERAL
     tickets, self-serve, real QR vouchers, no will-call. Free seats pay no
     ticket price and no fee. A cart that ends at $0 never goes to Stripe:
     it finalizes on the spot and lands straight on the ticket page. */
  const FREECODES = HOUSE.freeCodes || {};
  const freeCfg = (!station && !org && !disc && FREECODES[_raw] && FREECODES[_raw].enabled !== false) ? { code: _raw, tier: FREECODES[_raw].tier, limit: FREECODES[_raw].limit || 0 } : null;
  const isFreeSeat = (id) => { const s = seat(id); return !!(freeCfg && !s.wc && !accessible && s.zone === freeCfg.tier); };
  const unitCents = (id) => {
    const s = seat(id);
    if (s.wc || accessible) return HOUSE.wheelchair.price * 100;
    if (isFreeSeat(id)) return 0;
    const full = HOUSE.prices[s.zone] * 100;
    return (disc && disc.tiers.has(s.zone)) ? Math.round(full * (1 - disc.off)) : full;
  };
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
  const ORG_TIERS = new Set(["house", "splash", "general"]);   /* v3.71: every seat in the house pays the half */
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

  /* v3.75: take from the free pool BEFORE claiming; hand it back on any failure */
  const freeSeatIds = seats.filter(isFreeSeat);
  if (freeCfg && freeSeatIds.length) {
    const left = await store._driver.eval(LUA_POOL_TAKE, [freeCfg.code, freeCfg.limit, freeSeatIds.length]);
    if (Number(left) < 0) return resp(409, { err: "That code has been fully claimed. Tickets remain at their regular prices." });
  }
  /* v3.77: burn a single-use code atomically; -1 means someone already used it */
  if (disc && disc.once) {
    const t = await store._driver.eval(LUA_ONCE_TAKE, [disc.code]);
    if (Number(t) < 0) return resp(409, { err: "That code has already been used. Each one works exactly once." });
  }
  const poolBack = async () => {
    if (freeCfg && freeSeatIds.length) { try { await store._driver.eval(LUA_POOL_BACK, [freeCfg.code, freeSeatIds.length]); } catch (e) {} }
    if (disc && disc.once) { try { await store._driver.eval(LUA_ONCE_BACK, [disc.code]); } catch (e) {} }
  };

  /* THE claim, hard hold, all seats or none */
  const claim = await store.claim(holder, seats, HOUSE.hardHoldSec);
  if (!claim.ok) {
    await poolBack();
    if (accessible) { // restore companion hold if the claim lost
      for (const id of seats.filter(id => !seat(id).wc)) await store.adminHold([id], "companion");
    }
    return resp(409, { err: "seat taken", seat: claim.seat });
  }

  const siteUrl = process.env.SITE_URL || "";
  const ticketCentsFinal = seats.reduce((a, id) => a + unitCents(id), 0);
  const feeCents = priced.feeCents - freeSeatIds.length * Math.round(HOUSE.fee * 100);   /* free seats pay no fee */
  const totalDue = ticketCentsFinal + feeCents + (tee ? tee.qty * MERCH.teeBundleCents : 0);

  /* pure-free order: nothing to charge, so no Stripe at all. Finalize on the
     spot, mint real door codes, and send the buyer straight to the ticket
     page: the voucher, no will-call. */
  if (totalDue === 0) {
    const fin = await store.finalize(holder, seats);
    if (!fin.ok) { await poolBack(); await store.release(holder, seats); return resp(409, { err: "seat taken", seat: fin.seat }); }
    const sid = "free_" + holder;
    const issued = {};
    for (const id of seats) issued[id] = codes.gen();
    await store.putOrder(sid, { holder, seats, zone: priced.zone, free: freeCfg ? freeCfg.code : "", status: "sold", codes: issued, soldAt: Date.now() });
    for (const [seatId, code] of Object.entries(issued)) await store.putOrder("code_" + code, { seat: seatId, sid });
    return resp(200, { url: `${siteUrl}/success.html?sid=${encodeURIComponent(sid)}`, sid });
  }

  try {
    /* v3.55: mixed orders, each line item carries its own kind's name.
       v3.69: discounted seats carry the code on the line, so the receipt
       says out loud why the price is lower. */
    const line_items = seats.map(id => {
      const s = seat(id);
      const cents = unitCents(id);
      const discounted = disc && !s.wc && !accessible && disc.tiers.has(s.zone);
      const freeSeat = isFreeSeat(id);
      return {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: cents,
          product_data: { name: `${HOUSE.zones[s.zone]}, unreserved admission${s.wc ? " (wheelchair space)" : ""}${freeSeat ? ` (code ${freeCfg.code}, free)` : discounted ? ` (code ${disc.code}, ${Math.round(disc.off * 100)}% off)` : ""}` },
        },
      };
    });
    const savedCents = priced.ticketCents - ticketCentsFinal;
    const feePaying = seats.length - freeSeatIds.length;   /* v3.75: free seats pay no fee */
    if (feeCents > 0 && feePaying > 0) line_items.push({
      quantity: feePaying,   /* v3.59: $3 per ticket, the standing law */
      price_data: {
        currency: "usd",
        unit_amount: Math.round(feeCents / feePaying),
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
      metadata: { seats: seats.join(","), holder, accessible: accessible ? "1" : "0", station: station || "", org: org || "", org_eligible: String(orgEligible), org_tiers: orgTiers, org_owed: orgOwed, discount: disc ? disc.code : "", discount_saved: disc ? (savedCents / 100).toFixed(2) : "", free: freeCfg ? freeCfg.code : "", free_seats: freeSeatIds.length ? String(freeSeatIds.length) : "", src: src || "", tee_qty: tee ? String(tee.qty) : "", tee_size: tee ? tee.size : "" },
      payment_intent_data: { metadata: { seats: seats.join(","), holder, station: station || "", org: org || "", org_eligible: String(orgEligible), org_tiers: orgTiers, org_owed: orgOwed, discount: disc ? disc.code : "", discount_saved: disc ? (savedCents / 100).toFixed(2) : "", free: freeCfg ? freeCfg.code : "", free_seats: freeSeatIds.length ? String(freeSeatIds.length) : "", src: src || "", tee_qty: tee ? String(tee.qty) : "", tee_size: tee ? tee.size : "" } },
    });

    await store.putOrder(session.id, {
      holder, seats, zone: priced.zone, accessible: !!accessible,
      totalCents: ticketCentsFinal + feeCents + (tee ? tee.qty * MERCH.teeBundleCents : 0), feeCents, station,
      org, orgEligible, orgTiers, orgOwedCents, discount: disc ? disc.code : null, savedCents: disc ? savedCents : 0, free: freeCfg ? freeCfg.code : null, freeSeats: freeSeatIds.length || 0, once: (disc && disc.once) ? disc.code : null, src, tee,
      status: "pending", created: Date.now(), payment_intent: session.payment_intent || null,
    });
    return resp(200, { url: session.url, sid: session.id });
  } catch (e) {
    await poolBack();
    await store.release(holder, seats);            // never leave orphaned holds on failure
    if (accessible) for (const id of seats.filter(id => !seat(id).wc)) await store.adminHold([id], "companion");
    return resp(502, { err: "payment session failed, seats released", detail: String(e.message || e).slice(0, 200) });
  }
};
const resp = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

/* Stripe webhook, the ONE place a sale is finalized (spec §3.2 step 6).
   Signature-verified, idempotent, re-verify-then-sell, with the REQUIRED
   auto-refund path when a conflict slips through (spec §5.2). */
const store = require("./lib/store");
const codes = require("./lib/codes");
const { stripe } = require("./lib/stripe-adapter");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "POST" };
  let evt;
  try {
    evt = stripe.constructEvent(event.body, event.headers["stripe-signature"] || event.headers["Stripe-Signature"]);
  } catch (e) {
    return { statusCode: 400, body: "bad signature" };
  }

  /* idempotency latch: Stripe retries deliveries; process each event once */
  const fresh = await store.onceEvent(evt.id);
  if (!fresh) return ok({ dedup: true });

  const obj = evt.data && evt.data.object || {};

  if (evt.type === "checkout.session.completed") {
    const order = await store.getOrder(obj.id);
    if (!order) return ok({ warn: "unknown session", sid: obj.id });

    const fin = await store.finalize(order.holder, order.seats);
    if (!fin.ok) {
      /* §5.2: the failure that must never reach a buyer, refund automatically */
      try { await stripe.refund(obj.payment_intent); } catch (e) { /* surface below regardless */ }
      order.status = "refunded_conflict";
      order.conflictSeat = fin.seat;
      await store.putOrder(obj.id, order);
      console.error("CONFLICT-REFUND", obj.id, fin.seat);
      return ok({ conflict: fin.seat, refunded: true });
    }

    order.status = "sold";
    order.payment_intent = obj.payment_intent || order.payment_intent;
    order.buyer = {
      email: (obj.customer_details && obj.customer_details.email) || null,
      name: (obj.customer_details && obj.customer_details.name) || null,
    };
    order.codes = Object.fromEntries(order.seats.map(id => [id, codes.gen()]));
    order.soldAt = Date.now();
    /* v3.79: live per-code sales tally, so the console cupboard can show what
       each word produced (orders, tickets, and ticket dollars net of the fee
       and any tee) without a Stripe export. Payout codes read straight off it. */
    if (order.discount) {
      const ticketCents = Math.max(0, (order.totalCents || 0) - (order.feeCents || 0) - (order.teeCents || 0));
      try {
        await store._driver.eval(`
redis.call('INCR', 'disc:cnt:' .. ARGV[1])
redis.call('INCRBY', 'disc:tix:' .. ARGV[1], tonumber(ARGV[2]))
redis.call('INCRBY', 'disc:cents:' .. ARGV[1], tonumber(ARGV[3]))
return 1`, [order.discount, order.seats.length, ticketCents]);
      } catch (e) {}
    }
    await store.putOrder(obj.id, order);
    if (order.payment_intent) await store.putOrder("pi_" + order.payment_intent, { ref: obj.id });
    for (const [seatId, code] of Object.entries(order.codes))     // door-scan index
      await store.putOrder("code_" + code, { seat: seatId, sid: obj.id });
    return ok({ sold: order.seats });
  }

  if (evt.type === "checkout.session.expired") {
    const order = await store.getOrder(obj.id);
    if (order && order.status === "pending") {
      await store.release(order.holder, order.seats);
      /* v3.77: an abandoned cart gives back what it borrowed. A mixed free-code
         cart returns its free tickets to the pool; a single-use code un-burns. */
      if (order.free && order.freeSeats) {
        try { await store._driver.eval(`redis.call('DECRBY', 'free:' .. ARGV[1], tonumber(ARGV[2])) return 1`, [order.free, order.freeSeats]); } catch (e) {}
      }
      if (order.once) {
        try { await store._driver.eval(`redis.call('DEL', 'once:' .. ARGV[1]) return 1`, [order.once]); } catch (e) {}
      }
      order.status = "expired";
      await store.putOrder(obj.id, order);
    }
    return ok({ released: true });
  }

  if (evt.type === "charge.refunded") {
    const ref = await store.getOrder("pi_" + obj.payment_intent);
    const order = ref && (await store.getOrder(ref.ref));
    if (order && order.status === "sold") {
      await store.unsell(order.seats);            // refunded seats re-open (default policy)
      order.status = "refunded";
      await store.putOrder(ref.ref, order);
    }
    return ok({ reopened: true });
  }

  return ok({ ignored: evt.type });
};
const ok = obj => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

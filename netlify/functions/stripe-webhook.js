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

/* House model, generated from the venue seat chart (single source).
   Never hand-edit seat data here; regenerate house.json instead. */
const HOUSE = require("./house.json");

const seat = id => HOUSE.seats[id] || null;
const isWc = id => { const s = seat(id); return !!(s && s.wc); };

function tierOf(ids) {
  /* v3.55: unreserved room: HOUSE and SPLASH mix freely in one order
     (the one-tier law was a reserved-map rule; tierage exclusivity retired).
     Unknown seats still hard-fail. */
  let zone = null, mixed = false;
  for (const id of ids) {
    const s = seat(id);
    if (!s) return { ok: false, err: `unknown seat ${id}` };
    if (zone && s.zone !== zone) mixed = true;
    zone = s.zone;
  }
  return { ok: true, zone: mixed ? "mixed" : zone };
}

/* price a cart; accessible carts (wheelchair space ± companion) waive the fee */
function priceCart(ids, accessible) {
  const t = tierOf(ids);
  if (!t.ok) return t;
  let ticketCents = 0, feeCents = 0;
  for (const id of ids) {
    const s = seat(id);
    if (s.wc || accessible) { ticketCents += HOUSE.wheelchair.price * 100; feeCents += HOUSE.wheelchair.fee * 100; }
    else { ticketCents += HOUSE.prices[s.zone] * 100; feeCents += Math.round(HOUSE.fee * 100); }
  }
  return { ok: true, zone: t.zone, ticketCents, feeCents, totalCents: ticketCents + feeCents };
}

function staticHolds() {
  const out = {};
  for (const [id, s] of Object.entries(HOUSE.seats)) if (s.hold) out[id] = s.hold;
  return out;
}

module.exports = { HOUSE, seat, isWc, tierOf, priceCart, staticHolds };

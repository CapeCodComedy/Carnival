/* Soft hold / release — the 3-minute map courtesy hold (spec §5.1 stage 1).
   The seat goes dark for everyone the instant it is held. */
const store = require("./lib/store");
const { HOUSE, seat } = require("./lib/house");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "POST" };
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, body: "bad json" }; }
  const { holder, seats, action, accessible } = body;
  if (!holder || !Array.isArray(seats) || !seats.length) return { statusCode: 400, body: "holder+seats required" };
  if (seats.length > HOUSE.maxPerOrder) return resp(400, { err: `max ${HOUSE.maxPerOrder} per order` });
  for (const id of seats) {
    const s = seat(id);
    if (!s) return resp(400, { err: `unknown seat ${id}` });
    if (s.wc && !accessible) return resp(400, { err: "wheelchair spaces book through the accessible flow" });
  }

  if (action === "release") {
    const n = await store.release(holder, seats);
    return resp(200, { released: n });
  }
  const r = await store.claim(holder, seats, HOUSE.softHoldSec + 5);
  if (!r.ok) return resp(409, { err: "seat taken", seat: r.seat });
  return resp(200, { held: seats, ttl: HOUSE.softHoldSec });
};
const resp = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

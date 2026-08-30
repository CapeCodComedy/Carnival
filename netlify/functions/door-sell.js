/* Door selling (v3.81): the will-call desk mints real, scannable, PAID-CASH
   tickets on the spot, gated by the same door word as the scanner.
   FAIL-CLOSED: unlike the scanner (which stays open so a deploy never bricks
   the door), selling refuses to exist until DOOR_TOKEN is set. Money is cash
   in the till; no card, no fee. Units come off the same live store as every
   online sale, so nothing can oversell. */
const store = require("./lib/store");
const codes = require("./lib/codes");
const { HOUSE } = require("./lib/house");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return resp(405, { err: "POST" });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return resp(400, { err: "bad json" }); }

  const DOOR = process.env.DOOR_TOKEN || "";
  if (!DOOR) return resp(403, { err: "Door selling is locked until DOOR_TOKEN is set on the server." });
  if (String(body.door || "").trim() !== DOOR) return resp(401, { err: "Door word missing or wrong." });

  const kind = String(body.kind || "");
  if (!HOUSE.zones[kind]) return resp(400, { err: "unknown kind" });
  const qty = Math.max(1, Math.min(10, parseInt(body.qty, 10) || 1));
  const name = String(body.name || "").trim().replace(/\s+/g, " ").slice(0, 60) || "DOOR SALE";

  /* pick open units from the top of the number line, away from online buyers */
  const s = await store.state();
  const taken = new Set([...s.sold, ...s.held, ...Object.keys(s.adminHolds)]);
  const prefix = kind === "house" ? "H-" : kind === "splash" ? "S-" : "GA-";
  let total = 0;
  for (const st of Object.values(HOUSE.seats)) if (!st.wc && st.zone === kind) total++;
  const ids = [];
  for (let i = total; i >= 1 && ids.length < qty; i--) {
    const id = prefix + i;
    if (!taken.has(id)) ids.push(id);
  }
  if (ids.length < qty) return resp(409, { err: `Only ${ids.length} open in ${HOUSE.zones[kind]}. Sell another tier or check with Max.` });

  const holder = "DOOR-" + Date.now();
  const c = await store.claim(holder, ids, 60);
  if (!c.ok) return resp(409, { err: "A unit slipped into a cart mid-sale; press MINT again.", seat: c.seat });
  await store.finalize(holder, ids);

  const rand = () => { const A = "235689ACDEFHJKMNPRTUVWXY"; let o = ""; const b = require("crypto").randomBytes(10); for (const x of b) o += A[x % A.length]; return o; };
  const sid = "door_" + rand();
  const issued = Object.fromEntries(ids.map(id => [id, codes.gen()]));
  const cents = Math.round((HOUSE.prices[kind] || 0) * 100) * qty;
  await store.putOrder(sid, {
    seats: ids, zone: kind, status: "sold", codes: issued, doorSale: true,
    buyer: { name, email: null }, note: "PAID CASH AT THE DOOR",
    totalCents: cents, feeCents: 0, soldAt: Date.now(),
  });
  for (const [seatId, code] of Object.entries(issued))
    await store.putOrder("code_" + code, { seat: seatId, sid });

  return resp(200, { sid, seats: ids, codes: issued, totalCents: cents, url: `/success.html?sid=${encodeURIComponent(sid)}` });
};
const resp = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(obj) });

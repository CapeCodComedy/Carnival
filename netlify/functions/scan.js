/* Door scan, server-side single-scan enforcement across every door device.
   First scan of a valid code returns the seat and latches it; every later
   scan reports when it was first used. Checksum rejects tampered codes
   before the store is even asked. */
const store = require("./lib/store");
const codes = require("./lib/codes");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "POST" };
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, body: "bad json" }; }
  /* door word: crew-only gate, separate from the owner's ADMIN_TOKEN.
     Unset DOOR_TOKEN = open (so a deploy never bricks the door); set it and every scan must carry it. */
  const DOOR = process.env.DOOR_TOKEN || "";
  if (DOOR && String(body.door || "").trim() !== DOOR)
    return resp({ verdict: "LOCKED", why: "door word missing or wrong, enter it at the top of the scanner" });
  const code = String(body.code || "").trim().toUpperCase();
  if (!codes.valid(code)) return resp({ verdict: "VOID", why: "fails checksum, copied or mistyped" });
  const rec = await store.getOrder("code_" + code);
  if (!rec) return resp({ verdict: "VOID", why: "code not issued by this box office" });
  /* a refunded order's tickets die with it, the seat went back on sale */
  const order = rec.sid ? await store.getOrder(rec.sid) : null;
  if (order && String(order.status || "").startsWith("refunded"))
    return resp({ verdict: "VOID", seat: rec.seat, why: "order was refunded, this ticket is no longer live" });
  const first = await store.onceEvent("scan_" + code, 7776000);
  if (!first) return resp({ verdict: "ALREADY IN", seat: rec.seat });
  return resp({ verdict: "VALID", seat: rec.seat });
};
const resp = obj => ({ statusCode: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(obj) });

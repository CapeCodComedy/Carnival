/* Singlet waitlist, one entry per email, latest choice wins.
   Doubles as a demand poll: joining signals singlet appetite,
   the pick signals the draw. Read via admin-api action "waitlist". */
const store = require("./lib/store");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return resp(405, { err: "POST" });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return resp(400, { err: "bad json" }); }
  if (body.hp) return resp(200, { ok: true });                 // honeypot: bots think they won
  const email = String(body.email || "").trim().toLowerCase();
  const choice = String(body.choice || "");
  if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return resp(400, { err: "real email required" });
  if (!["sagalow", "cannon", "either"].includes(choice)) return resp(400, { err: "pick a corner" });
  const tier = body.tier === undefined ? "any" : String(body.tier);          // old clients send none, that's ANY
  if (!["any", "orch", "t1", "t2", "balc"].includes(tier)) return resp(400, { err: "pick a real section" });
  await store.waitlistPut(email, choice, tier);
  return resp(200, { ok: true });
};
const resp = (c, o) => ({ statusCode: c, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(o) });

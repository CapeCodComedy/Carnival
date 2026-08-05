/* Console API — token-authed. The console reads the SAME store the map
   reads, so it can never drift from the map (spec §8.2). */
const store = require("./lib/store");
const codes = require("./lib/codes");
const { HOUSE, staticHolds } = require("./lib/house");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "POST" };
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, body: "bad json" }; }
  const token = event.headers["x-admin-token"] || body.token;
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN)
    return { statusCode: 401, body: JSON.stringify({ err: "bad token" }) };

  const { action, seats, category } = body;

  if (action === "seed") {
    /* one-time (idempotent): push the house's static holds into the live store */
    const holds = staticHolds();
    const byCat = {};
    for (const [id, cat] of Object.entries(holds)) (byCat[cat] ||= []).push(id);
    /* wheelchair spaces are NOT seeded as holds — they stay claimable, but
       only through the accessible flow (enforced in claim/create-checkout) */
    const out = {};
    for (const [cat, ids] of Object.entries(byCat)) { await store.adminHold(ids, cat); out[cat] = ids.length; }
    return ok({ seeded: out });
  }

  if (action === "state") {
    const s = await store.state();
    return ok(s);
  }

  if (action === "ledger") {
    /* prove the closing identity from the LIVE store (spec §2.2) */
    const s = await store.state();
    const zones = { orch: { phys: 0 }, t1: { phys: 0 }, t2: { phys: 0 }, balc: { phys: 0 } };
    let wc = 0;
    for (const [id, seat] of Object.entries(HOUSE.seats)) {
      if (seat.wc) { wc++; continue; }
      zones[seat.zone].phys++;
    }
    const catCount = k => Object.entries(s.adminHolds).filter(([id, c]) => !HOUSE.seats[id].wc && (k ? c === k : true)).length;
    const held = catCount(null);
    const sold = s.sold.filter(id => !HOUSE.seats[id].wc).length;
    const buyerHeld = s.held.length;
    const physical = Object.values(zones).reduce((a, z) => a + z.phys, 0);
    return ok({
      physical, wheelchairUnits: wc, consoleHeld: held, sold, buyerHolding: buyerHeld,
      open: physical - held - sold - buyerHeld,
      identity: { total: physical + wc, expected: 653, closes: physical + wc === 653 },
      byCategory: Object.fromEntries(["sponsor","comp","marketing","companion","volunteer","charity"].map(c => [c, catCount(c)])),
    });
  }

  if (action === "hold")    { const r = await store.adminHold(seats || [], category || "house"); return ok(r); }
  if (action === "release") {
    if (body.force){   // support tool: clears ANY hold (admin or stuck buyer) — never a sold seat
      let n = 0;
      for (const id of seats || []) n += Number(await store._driver.eval(
        `return redis.call('HDEL','h:held', ARGV[1])`, [id]));
      return ok({ released: n, forced: true });
    }
    const n = await store.adminRelease(seats || []); return ok({ released: n });
  }
  if (action === "unsell")  { const n = await store.unsell(seats || []); return ok({ reopened: n }); }
  if (action === "purge")   { const n = await store.purgeExpired(); return ok({ purged: n }); }

  if (action === "marksold") {
    /* comp/manual issuance: claim then finalize under a COMP holder */
    const holder = "COMP-" + Date.now();
    const c = await store.claim(holder, seats || [], 60);
    if (!c.ok) return ok({ err: "not claimable", seat: c.seat });
    await store.finalize(holder, seats);
    const issued = Object.fromEntries((seats || []).map(id => [id, codes.gen()]));
    await store.putOrder("comp_" + holder, { holder, seats, status: "sold", codes: issued, comp: true, soldAt: Date.now() });
    for (const [seatId, code] of Object.entries(issued))          // door-scan index — comps scan like any sale
      await store.putOrder("code_" + code, { seat: seatId, sid: "comp_" + holder });
    return ok({ sold: seats, codes: issued });
  }

  if (action === "waitlist") {
    /* singlet demand poll: per-corner + per-section tallies + entries, newest first.
       Rows are "choice|tier|ts"; legacy rows "choice|ts" read as tier ANY. */
    const all = await store.waitlistAll();
    const t = { sagalow: 0, cannon: 0, either: 0 };
    const blank = () => ({ orch: 0, t1: 0, t2: 0, balc: 0, any: 0 });
    const sections = blank();
    const cross = { sagalow: blank(), cannon: blank(), either: blank() };
    const entries = Object.entries(all).map(([email, v]) => {
      const p = String(v).split("|");
      const choice = p[0], rawTier = p.length >= 3 ? p[1] : "any", ts = Number(p[p.length - 1]);
      const tier = sections[rawTier] !== undefined ? rawTier : "any";
      if (t[choice] !== undefined) t[choice] += 1;
      sections[tier] += 1;
      if (cross[choice]) cross[choice][tier] += 1;
      return { email, choice, tier, ts };
    }).sort((a, b) => b.ts - a.ts);
    return ok({ total: entries.length, ...t, sections, cross, entries });
  }

  if (action === "manifest") {
    /* door list: every sold seat with its code (scans orders) — Phase-1 scale is fine */
    const s = await store.state();
    return ok({ note: "codes live in order records; export via 'orders' action in Phase 2", sold: s.sold });
  }

  return { statusCode: 400, body: JSON.stringify({ err: "unknown action" }) };
};
const ok = obj => ({ statusCode: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(obj) });

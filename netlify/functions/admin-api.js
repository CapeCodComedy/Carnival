/* Console API, token-authed. The console reads the SAME store the map
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
    /* wheelchair spaces are NOT seeded as holds, they stay claimable, but
       only through the accessible flow (enforced in claim/create-checkout) */
    const out = {};
    for (const [cat, ids] of Object.entries(byCat)) { await store.adminHold(ids, cat); out[cat] = ids.length; }
    return ok({ seeded: out });
  }

  if (action === "state") {
    /* v3.62: the live store plus the room's shape, so the console carries no
       hardcoded caps: expand the Splash Zone or launch THE CHEAP SEATS by
       regenerating house.json and the console follows on its own. */
    const s = await store.state();
    const meta = { fee: HOUSE.fee, maxPerOrder: HOUSE.maxPerOrder, zones: {} };
    for (const [z, name] of Object.entries(HOUSE.zones))
      meta.zones[z] = { name, price: HOUSE.prices[z] || 0, units: 0 };
    for (const st of Object.values(HOUSE.seats))
      if (!st.wc && meta.zones[st.zone]) meta.zones[st.zone].units++;
    return ok({ ...s, meta });
  }

  if (action === "ledger") {
    /* prove the closing identity from the LIVE store (spec §2.2).
       v3.62: zone buckets come from house.json, never hardcoded. Ids the
       current room does not know (sold or held on the old reserved chart)
       are counted as reserved-era rows, not treated as errors: those are
       real tickets and they scan at the door like any other. */
    const s = await store.state();
    const zones = {};
    for (const z of Object.keys(HOUSE.zones)) zones[z] = { units: 0, sold: 0, inCart: 0, held: 0 };
    let wc = 0, physical = 0;
    for (const st of Object.values(HOUSE.seats)) {
      if (st.wc) { wc++; continue; }
      if (zones[st.zone]) { zones[st.zone].units++; physical++; }
    }
    const eraSold = [], eraHeld = [];
    let sold = 0, buyerHolding = 0, consoleHeld = 0;
    const byCategory = {};
    for (const id of s.sold) {
      const st = HOUSE.seats[id];
      if (!st) { eraSold.push(id); continue; }
      if (st.wc) continue;
      zones[st.zone].sold++; sold++;
    }
    for (const id of s.held) {
      const st = HOUSE.seats[id];
      if (st && !st.wc && zones[st.zone]) { zones[st.zone].inCart++; buyerHolding++; }
    }
    for (const [id, cat] of Object.entries(s.adminHolds)) {
      const st = HOUSE.seats[id];
      if (!st) { eraHeld.push(id); continue; }
      if (st.wc) continue;
      zones[st.zone].held++; consoleHeld++;
      byCategory[cat] = (byCategory[cat] || 0) + 1;
    }
    const open = physical - consoleHeld - sold - buyerHolding;
    return ok({
      physical, wheelchairUnits: wc, consoleHeld, sold, buyerHolding, open, zones,
      identity: {
        total: physical + wc, expected: Object.keys(HOUSE.seats).length,
        closes: open + consoleHeld + sold + buyerHolding === physical
             && physical + wc === Object.keys(HOUSE.seats).length,
      },
      reservedEra: { sold: eraSold.length, held: eraHeld.length, soldIds: eraSold, heldIds: eraHeld },
      byCategory,
    });
  }

  if (action === "hold")    { const r = await store.adminHold(seats || [], category || "house"); return ok(r); }
  if (action === "release") {
    if (body.force){   // support tool: clears ANY hold (admin or stuck buyer), never a sold seat
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
    for (const [seatId, code] of Object.entries(issued))          // door-scan index, comps scan like any sale
      await store.putOrder("code_" + code, { seat: seatId, sid: "comp_" + holder });
    return ok({ sold: seats, codes: issued, sid: "comp_" + holder });   // sid → /success.html?sid=… is the printable ticket
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
    /* door list: every sold seat with its code (scans orders): Phase-1 scale is fine */
    const s = await store.state();
    return ok({ note: "codes live in order records; export via 'orders' action in Phase 2", sold: s.sold });
  }

  return { statusCode: 400, body: JSON.stringify({ err: "unknown action" }) };
};
const ok = obj => ({ statusCode: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(obj) });

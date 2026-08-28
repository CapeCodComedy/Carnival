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

  if (action === "guest") {
    /* THE GUEST BOOK (v3.77): named tickets for comps, winners, crew, and
       will-call holds. Two kinds: a zone kind eats real sellable units
       (top of the number line, like comps always did); kind "reserved" mints
       off-book RS- ids that live outside the sale entirely, for chairs that
       were never in the online count (taped-off rows, will-call pairs).
       Every guest ticket scans at the door like any sale. */
    const name = String(body.name || "").trim().replace(/\s+/g, " ").slice(0, 60);
    const email = String(body.email || "").trim().toLowerCase().slice(0, 120) || null;
    /* v3.80: a phone number (digits only, leading 1 dropped) is a lookup key
       at /mytickets, for guests who have no email */
    let phone = String(body.phone || "").replace(/\D/g, "").slice(0, 15);
    if (phone.length === 11 && phone[0] === "1") phone = phone.slice(1);
    phone = phone.length >= 7 ? phone : null;
    const label = String(body.label || "").trim().slice(0, 60) || null;
    const note = String(body.note || "").trim().slice(0, 80) || null;
    const kind = String(body.kind || "");
    const qty = Math.max(1, Math.min(10, parseInt(body.qty, 10) || 1));
    if (!name) return ok({ err: "a guest name is required" });
    if (kind !== "reserved" && !HOUSE.zones[kind]) return ok({ err: "unknown kind" });

    let ids = [];
    if (kind === "reserved") {
      /* off-book ids from a counter; skip numbers carrying the ill-omen digit */
      while (ids.length < qty) {
        const n = Number(await store._driver.eval(`return redis.call('INCR', 'guest:rs')`, ["_"]));
        if (!String(n).includes("4")) ids.push("RS-" + n);
      }
    } else {
      const s = await store.state();
      const taken = new Set([...s.sold, ...s.held, ...Object.keys(s.adminHolds)]);
      const prefix = kind === "house" ? "H-" : kind === "splash" ? "S-" : "GA-";
      let total = 0;
      for (const st of Object.values(HOUSE.seats)) if (!st.wc && st.zone === kind) total++;
      for (let i = total; i >= 1 && ids.length < qty; i--) {
        const id = prefix + i;
        if (!taken.has(id)) ids.push(id);
      }
      if (ids.length < qty) return ok({ err: `only ${ids.length} open units in ${HOUSE.zones[kind]}` });
      const holder = "GUEST-" + Date.now();
      const c = await store.claim(holder, ids, 60);
      if (!c.ok) return ok({ err: "not claimable", seat: c.seat });
      await store.finalize(holder, ids);
    }

    const rand = () => { const A = "235689ACDEFHJKMNPRTUVWXY"; let o = ""; const b = require("crypto").randomBytes(10); for (const x of b) o += A[x % A.length]; return o; };
    const sid = "guest_" + rand();
    const issued = Object.fromEntries(ids.map(id => [id, codes.gen()]));
    await store.putOrder(sid, {
      seats: ids, zone: kind, status: "sold", codes: issued, comp: true, guest: true,
      buyer: { name, email }, phone, label, note, soldAt: Date.now(),
    });
    for (const [seatId, code] of Object.entries(issued))
      await store.putOrder("code_" + code, { seat: seatId, sid });
    return ok({ sid, seats: ids, codes: issued });
  }

  if (action === "guests") {
    /* the whole guest book, for the console list and the one-press print run */
    const sids = (await store._driver.eval(`
local keys = redis.call('KEYS', 'order:guest_*')
local out = {}
for i = 1, #keys do out[#out + 1] = string.sub(keys[i], 7) end
return out
`, ["_"])) || [];
    const guests = [];
    for (const sid of sids) {
      const o = await store.getOrder(sid);
      if (o && o.guest) guests.push({
        sid, name: (o.buyer && o.buyer.name) || "", email: (o.buyer && o.buyer.email) || null,
        phone: o.phone || null,
        label: o.label || null, note: o.note || null, kind: o.zone, seats: o.seats || [],
        codes: o.codes || {}, soldAt: o.soldAt || 0, voided: String(o.status || "").startsWith("refunded"),
      });
    }
    guests.sort((a, b) => (b.soldAt || 0) - (a.soldAt || 0));
    return ok({ guests });
  }

  if (action === "guestvoid") {
    /* undo a mistaken guest entry: reopen any real units and kill the codes */
    const o = await store.getOrder(String(body.sid || ""));
    if (!o || !o.guest) return ok({ err: "no such guest order" });
    if (String(o.status || "").startsWith("refunded")) return ok({ err: "already void" });
    const real = (o.seats || []).filter(id => !id.startsWith("RS-"));
    if (real.length) await store.unsell(real);
    o.status = "refunded_guestvoid";
    await store.putOrder(String(body.sid), o);
    return ok({ voided: body.sid, reopened: real.length });
  }

  if (action === "codes") {
    /* the code cupboard: every live code word with its live state, for the
       owner's eyes only; the public site sees only hashes */
    const out = [];
    /* v3.79: every discount word carries its live tally (orders, tickets, and
       ticket dollars net of fee and tee), so payout codes read straight here */
    const tally = async (w) => {
      const r = await store._driver.eval(`
return {redis.call('GET', 'disc:cnt:' .. ARGV[1]) or '0',
        redis.call('GET', 'disc:tix:' .. ARGV[1]) or '0',
        redis.call('GET', 'disc:cents:' .. ARGV[1]) or '0'}`, [w]);
      const [cnt, tix, cents] = (r || []).map(Number);
      return cnt ? ` · ${cnt} order${cnt === 1 ? "" : "s"}, ${tix} ticket${tix === 1 ? "" : "s"}, $${(cents / 100).toFixed(2)} in` : " · no sales yet";
    };
    for (const [w, d] of Object.entries(HOUSE.discounts || {})) {
      if (!d || d.enabled === false) continue;
      if (d.once) {
        const used = Number(await store._driver.eval(`return redis.call('GET', 'once:' .. ARGV[1]) or '0'`, [w])) || 0;
        out.push({ word: w, kind: "single-use 50%", state: (used >= 1 ? "USED" : "unused") + (await tally(w)) });
      } else if (d.prices) {
        const words = Object.entries(d.prices).map(([z, p]) => `${HOUSE.zones[z] || z} $${p}`).join(" / ");
        out.push({ word: w, kind: words, state: "open" + (await tally(w)) });
      } else out.push({ word: w, kind: `${Math.round((d.off || 0) * 100)}% off`, state: "open" + (await tally(w)) });
    }
    for (const [w, f] of Object.entries(HOUSE.freeCodes || {})) {
      if (!f || f.enabled === false) continue;
      const used = Number(await store._driver.eval(`return redis.call('GET', 'free:' .. ARGV[1]) or '0'`, [w])) || 0;
      out.push({ word: w, kind: `free ${HOUSE.zones[f.tier] || f.tier}`, state: `${Math.max(0, (f.limit || 0) - used)} of ${f.limit} left` });
    }
    for (const w of ["Y101", "FRANK", "PIXY"]) out.push({ word: w, kind: "station, fee waived + tee", state: "open" });
    for (const w of (HOUSE.orgCodesEnabled !== false ? HOUSE.orgCodes || [] : [])) out.push({ word: w, kind: "org, half to them", state: "open" });
    return ok({ codes: out });
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

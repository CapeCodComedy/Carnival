/* Store-layer proofs, per spec §13 step 1: run BEFORE any UI exists.
   Uses local Redis with the exact Lua that runs on Upstash. */
process.env.REDIS_URL = "redis://127.0.0.1:6379";
const S = require("../netlify/functions/lib/store");

const assert = (name, cond) => { console.log((cond ? "PASS" : "FAIL *** ") + " · " + name); if (!cond) process.exitCode = 1; };

(async () => {
  await S._driver._raw.flushdb();

  /* 1 — the race: two buyers, same seat, same instant → exactly one winner */
  const [a, b] = await Promise.all([S.claim("buyerA", ["C-101"], 60), S.claim("buyerB", ["C-101"], 60)]);
  assert("race on one seat: exactly one winner", (a.ok ? 1 : 0) + (b.ok ? 1 : 0) === 1);

  /* 2 — group all-or-nothing: B holds H-2; A wants [H-1, H-2] → A gets NOTHING */
  await S.claim("buyerB", ["H-2"], 60);
  const g = await S.claim("buyerA", ["H-1", "H-2"], 60);
  const st = await S.state();
  assert("group claim blocked by one taken seat", !g.ok && g.seat === "H-2");
  assert("group claim wrote nothing (H-1 still open)", !st.held.includes("H-1"));

  /* 3 — same-holder re-claim extends (soft hold -> hard hold) */
  const r1 = await S.claim("buyerC", ["D-5"], 5);
  const r2 = await S.claim("buyerC", ["D-5"], 2100);
  assert("same holder can extend own hold", r1.ok && r2.ok);

  /* 4 — expiry self-heals: expired hold is claimable by another buyer */
  await S.claim("buyerD", ["E-7"], 1);            // 1-second hold
  await new Promise(r => setTimeout(r, 1200));
  const e2 = await S.claim("buyerE", ["E-7"], 60);
  assert("expired hold claimable by next buyer", e2.ok);

  /* 5 — finalize: sells only what this holder holds; conflict sells nothing */
  await S.claim("buyerF", ["F-1", "F-3"], 60);
  const f1 = await S.finalize("buyerF", ["F-1", "F-3"]);
  const f2 = await S.finalize("buyerG", ["F-1"]);          // not his seat
  assert("finalize sells holder's seats", f1.ok);
  assert("finalize rejects non-holder (conflict -> refund path)", !f2.ok && f2.seat === "F-1");

  /* 6 — finalize is idempotent (Stripe retries webhooks) */
  const f3 = await S.finalize("buyerF", ["F-1", "F-3"]);
  assert("finalize retry is idempotent", f3.ok);

  /* 7 — post-expiry finalize still lands IF nobody else took the seat (belt) */
  await S.claim("buyerH", ["G-9"], 1);
  await new Promise(r => setTimeout(r, 1200));
  const f4 = await S.finalize("buyerH", ["G-9"]);
  assert("expired-but-untaken hold still finalizes (buyer paid; seat free)", f4.ok);

  /* 8 — but if someone ELSE claimed it after expiry, finalize conflicts */
  await S.claim("buyerI", ["G-11"], 1);
  await new Promise(r => setTimeout(r, 1200));
  await S.claim("buyerJ", ["G-11"], 60);
  const f5 = await S.finalize("buyerI", ["G-11"]);
  assert("expired-and-retaken hold conflicts (auto-refund path fires)", !f5.ok);

  /* 9 — admin holds: forever, categoried, invisible-to-expiry; releasable */
  await S.adminHold(["TA-108"], "comp");
  const c1 = await S.claim("buyerK", ["TA-108"], 60);
  const st2 = await S.state();
  assert("admin hold blocks buyers", !c1.ok);
  assert("admin hold carries category", st2.adminHolds["TA-108"] === "comp");
  await S.adminRelease(["TA-108"]);
  const c2 = await S.claim("buyerK", ["TA-108"], 60);
  assert("admin release re-opens seat", c2.ok);

  /* 10 — unsell (refund) re-opens */
  await S.unsell(["F-1"]);
  const c3 = await S.claim("buyerL", ["F-1"], 60);
  assert("refunded seat is claimable again", c3.ok);

  /* 11 — webhook idempotency latch */
  const first = await S.onceEvent("evt_123");
  const second = await S.onceEvent("evt_123");
  assert("event latch: first passes, retry blocked", first === true && second === false);

  /* 12 — brute concurrency: 20 buyers × same 3 seats, exactly one winner */
  await S._driver._raw.flushdb();
  const attempts = await Promise.all(
    Array.from({ length: 20 }, (_, i) => S.claim("racer" + i, ["J-1", "J-3", "J-5"], 60)));
  const winners = attempts.filter(x => x.ok).length;
  assert("20-way group race: exactly one winner", winners === 1);

  console.log("\nstore-layer proofs complete.");
  process.exit(process.exitCode || 0);
})().catch(e => { console.error("HARNESS ERROR", e); process.exit(1); });

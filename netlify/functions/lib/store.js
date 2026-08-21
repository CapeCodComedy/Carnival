/* =============================================================
   SEAT STORE, the one place a seat can be claimed or sold.
   Spec §4: single conditional write, group-atomic via Lua.
   Values are dependency-free strings:  holder|expiresMs[|category]
   Keys:  h:held  h:sold  (hashes seatId -> value)
          order:<sessionId>  (JSON order record)
          evt:<stripeEventId> (webhook idempotency, NX+EX)
   The SAME Lua runs on local Redis (tests) and Upstash (prod),
   so the semantics proven in tests are the semantics in prod.
   ============================================================= */

const ADMIN = "ADMIN";
const FOREVER = 9999999999999;

/* ---- Lua scripts (atomic; no cjson so they run anywhere) ---- */

/* CLAIM: ARGV = holder, expMs, nowMs, seat1..N
   All seats must be claimable (open, expired-held, or held by SAME holder)
   or nothing is written. Returns {1} or {0, blockedSeat}. */
const LUA_CLAIM = `
local holder = ARGV[1]
local exp = ARGV[2]
local now = tonumber(ARGV[3])
for i = 4, #ARGV do
  local seat = ARGV[i]
  if redis.call('HEXISTS', 'h:sold', seat) == 1 then return {0, seat} end
  local v = redis.call('HGET', 'h:held', seat)
  if v then
    local p = string.find(v, '|')
    local h = string.sub(v, 1, p - 1)
    local rest = string.sub(v, p + 1)
    local p2 = string.find(rest, '|')
    local e = tonumber(p2 and string.sub(rest, 1, p2 - 1) or rest)
    if h ~= holder and e > now then return {0, seat} end
  end
end
for i = 4, #ARGV do
  redis.call('HSET', 'h:held', ARGV[i], holder .. '|' .. exp)
end
return {1}
`;

/* RELEASE: ARGV = holder, seat1..N, deletes only if held by this holder */
const LUA_RELEASE = `
local holder = ARGV[1]
local n = 0
for i = 2, #ARGV do
  local v = redis.call('HGET', 'h:held', ARGV[i])
  if v and string.sub(v, 1, string.len(holder) + 1) == holder .. '|' then
    redis.call('HDEL', 'h:held', ARGV[i]); n = n + 1
  end
end
return n
`;

/* FINALIZE: ARGV = holder, tsMs, seat1..N
   Marks held-by-this-holder seats SOLD. Idempotent: seats already sold
   to this holder pass. Any seat sold to another holder, or held live by
   another holder, is a conflict: nothing is written. Returns {1} or {0,seat}. */
const LUA_FINALIZE = `
local holder = ARGV[1]
local ts = ARGV[2]
for i = 3, #ARGV do
  local seat = ARGV[i]
  local s = redis.call('HGET', 'h:sold', seat)
  if s then
    if string.sub(s, 1, string.len(holder) + 1) ~= holder .. '|' then return {0, seat} end
  else
    local v = redis.call('HGET', 'h:held', seat)
    if not v then return {0, seat} end
    if string.sub(v, 1, string.len(holder) + 1) ~= holder .. '|' then return {0, seat} end
  end
end
for i = 3, #ARGV do
  local seat = ARGV[i]
  if redis.call('HEXISTS', 'h:sold', seat) == 0 then
    redis.call('HDEL', 'h:held', seat)
    redis.call('HSET', 'h:sold', seat, holder .. '|' .. ts)
  end
end
return {1}
`;

/* UNSELL: ARGV = seat1..N, refunds/console; returns count re-opened */
const LUA_UNSELL = `
local n = 0
for i = 1, #ARGV do
  if redis.call('HDEL', 'h:sold', ARGV[i]) == 1 then n = n + 1 end
end
return n
`;

/* PURGE expired holds (housekeeping; lazily correct anyway): ARGV = nowMs */
const LUA_PURGE = `
local now = tonumber(ARGV[1])
local all = redis.call('HGETALL', 'h:held')
local n = 0
for i = 1, #all, 2 do
  local v = all[i + 1]
  local p = string.find(v, '|')
  local rest = string.sub(v, p + 1)
  local p2 = string.find(rest, '|')
  local e = tonumber(p2 and string.sub(rest, 1, p2 - 1) or rest)
  if e <= now then redis.call('HDEL', 'h:held', all[i]); n = n + 1 end
end
return n
`;

/* ---------------- driver: Upstash (prod) or ioredis (tests) ---------------- */
function makeDriver() {
  if (process.env.UPSTASH_REDIS_REST_URL) {
    const { Redis } = require("@upstash/redis");
    const r = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    return {
      eval: (script, args) => r.eval(script, [], args.map(String)),
      hgetall: (k) => r.hgetall(k).then(o => o || {}),
      get: (k) => r.get(k),
      set: (k, v) => r.set(k, typeof v === "string" ? v : JSON.stringify(v)),
      setnx_ex: (k, v, ex) => r.set(k, v, { nx: true, ex }).then(res => res === "OK"),
      del: (k) => r.del(k),
    };
  }
  /* local/test driver */
  const IORedis = require("ioredis");
  const r = new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379");
  return {
    eval: (script, args) => r.eval(script, 0, ...args.map(String)),
    hgetall: (k) => r.hgetall(k),
    get: (k) => r.get(k),
    set: (k, v) => r.set(k, typeof v === "string" ? v : JSON.stringify(v)),
    setnx_ex: (k, v, ex) => r.set(k, v, "EX", ex, "NX").then(res => res === "OK"),
    del: (k) => r.del(k),
    _raw: r,
  };
}

const d = makeDriver();

/* ---------------- public store API ---------------- */
const parseVal = v => {
  const [holder, exp, category] = String(v).split("|");
  return { holder, exp: Number(exp), category: category || null };
};

async function claim(holder, seats, ttlSec) {
  const now = Date.now();
  const res = await d.eval(LUA_CLAIM, [holder, now + ttlSec * 1000, now, ...seats]);
  return Array.isArray(res) && Number(res[0]) === 1 ? { ok: true } : { ok: false, seat: res && res[1] };
}
async function release(holder, seats) {
  return d.eval(LUA_RELEASE, [holder, ...seats]);
}
async function finalize(holder, seats) {
  const res = await d.eval(LUA_FINALIZE, [holder, Date.now(), ...seats]);
  return Array.isArray(res) && Number(res[0]) === 1 ? { ok: true } : { ok: false, seat: res && res[1] };
}
async function unsell(seats) { return d.eval(LUA_UNSELL, seats); }
async function purgeExpired() { return d.eval(LUA_PURGE, [Date.now()]); }

/* console holds are ADMIN-held seats with a category and no expiry */
async function adminHold(seats, category) {
  const now = Date.now();
  // ADMIN claims may take over expired holds but never sold seats
  const res = await d.eval(LUA_CLAIM, [ADMIN, FOREVER, now, ...seats]);
  if (!(Array.isArray(res) && Number(res[0]) === 1)) return { ok: false, seat: res && res[1] };
  // annotate category (separate small writes are fine post-claim)
  for (const s of seats) await d.eval(
    `redis.call('HSET','h:held', ARGV[1], ARGV[2]); return 1`,
    [s, `${ADMIN}|${FOREVER}|${category}`]);
  return { ok: true };
}
async function adminRelease(seats) {
  return d.eval(LUA_RELEASE, [ADMIN, ...seats]);
}

/* full state for map + console */
async function state() {
  const now = Date.now();
  const [heldRaw, soldRaw] = await Promise.all([d.hgetall("h:held"), d.hgetall("h:sold")]);
  const held = [], adminHolds = {};
  for (const [seat, v] of Object.entries(heldRaw || {})) {
    const p = parseVal(v);
    if (p.exp <= now) continue;                    // lazily-expired: open
    if (p.holder === ADMIN) adminHolds[seat] = p.category || "house";
    else held.push(seat);
  }
  const sold = Object.keys(soldRaw || {});
  return { held, adminHolds, sold, ts: now };
}

/* order records + webhook idempotency */
const orderKey = sid => `order:${sid}`;
async function putOrder(sid, obj) { return d.set(orderKey(sid), JSON.stringify(obj)); }
async function getOrder(sid) {
  const v = await d.get(orderKey(sid));
  if (!v) return null;
  return typeof v === "string" ? JSON.parse(v) : v;
}
async function onceEvent(eventId, exSec = 86400) { return d.setnx_ex(`evt:${eventId}`, "1", exSec); }

/* singlet waitlist: hash email -> "choice|tier|ts"; one entry per email, latest wins.
   Legacy rows are "choice|ts", readers treat the missing tier as "any". */
async function waitlistPut(email, choice, tier) {
  return d.eval(`redis.call('HSET','wl:entries', ARGV[1], ARGV[2]) return 1`, [email, choice + "|" + (tier || "any") + "|" + Date.now()]);
}
async function waitlistAll() {
  const flat = await d.eval(`return redis.call('HGETALL','wl:entries')`, ["_"]);
  const out = {};
  for (let i = 0; i < (flat || []).length; i += 2) out[flat[i]] = flat[i + 1];
  return out;
}

module.exports = { claim, release, finalize, unsell, purgeExpired, adminHold, adminRelease,
                   state, putOrder, getOrder, onceEvent, waitlistPut, waitlistAll, ADMIN, _driver: d };

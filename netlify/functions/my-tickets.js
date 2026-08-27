/* Find-my-tickets (v3.76): the rescue for buyers who closed the ticket page.
   The webhook has stored buyer email + name on every completed order since
   launch, so this lookup works retroactively. Input: an email address.
   Output: ticket-PAGE links only, never the codes themselves; the success
   page remains the single surface that renders QR tickets.
   Scale note: the whole order book is small (a one-night box office), so a
   single Lua pass over order keys is cheaper and simpler than an index. */
const store = require("./lib/store");

const LUA_FIND = `
local q = string.lower(ARGV[1])
local needle = '"email":"' .. q .. '"'
local keys = redis.call('KEYS', 'order:*')
local out = {}
for i = 1, #keys do
  local k = keys[i]
  if string.sub(k, 1, 11) ~= 'order:code_' and string.sub(k, 1, 9) ~= 'order:pi_' then
    local v = redis.call('GET', k)
    if v and string.find(string.lower(v), needle, 1, true) and string.find(v, '"status":"sold"', 1, true) then
      out[#out + 1] = string.sub(k, 7)
    end
  end
end
return out
`;

/* v3.77: guest tickets (comps, winners, crew) can be found by the NAME they
   were issued under, since some guests have no email on file. Name lookup
   matches GUEST orders only; paid orders stay email-only on purpose, because
   a name is guessable and a paid ticket is money. */
const LUA_FIND_NAME = `
local needle = '"namekey":"' .. string.lower(ARGV[1]) .. '"'
local keys = redis.call('KEYS', 'order:guest_*')
local out = {}
for i = 1, #keys do
  local v = redis.call('GET', keys[i])
  if v and string.find(v, needle, 1, true) and string.find(v, '"status":"sold"', 1, true) then
    out[#out + 1] = string.sub(keys[i], 7)
  end
end
return out
`;

exports.handler = async (event) => {
  const q = String((event.queryStringParameters || {}).email || "").trim();
  const isEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(q);
  const nameKey = q.toLowerCase().replace(/\s+/g, " ");
  const isName = !isEmail && /^[a-z][a-z .'-]{1,59}$/.test(nameKey);
  if (!q || q.length > 120 || (!isEmail && !isName))
    return resp(400, { err: "type the email you bought with, or the full name your tickets were issued under" });

  const sids = (await store._driver.eval(isEmail ? LUA_FIND : LUA_FIND_NAME, [isEmail ? q.toLowerCase() : nameKey])) || [];
  const orders = [];
  for (const sid of sids) {
    const o = await store.getOrder(sid);
    if (o && o.status === "sold" && Array.isArray(o.seats))
      orders.push({ sid, tickets: o.seats.length, when: o.soldAt || null });
  }
  orders.sort((a, b) => (b.when || 0) - (a.when || 0));
  return resp(200, { found: orders.length, orders });
};
const resp = (code, obj) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(obj),
});

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

exports.handler = async (event) => {
  const email = String((event.queryStringParameters || {}).email || "").trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 120)
    return resp(400, { err: "a valid email address is required" });

  const sids = (await store._driver.eval(LUA_FIND, [email])) || [];
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

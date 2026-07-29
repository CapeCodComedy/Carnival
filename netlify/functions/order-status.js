/* Success-page endpoint: what did this session buy? Non-sensitive only. */
const store = require("./lib/store");
exports.handler = async (event) => {
  const sid = (event.queryStringParameters || {}).sid;
  if (!sid) return { statusCode: 400, body: "sid required" };
  const o = await store.getOrder(sid);
  if (!o) return { statusCode: 404, body: JSON.stringify({ err: "unknown session" }) };
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify({
      status: o.status, seats: o.seats, zone: o.zone, totalCents: o.totalCents,
      feeCents: o.feeCents, codes: o.codes || null, accessible: !!o.accessible,
    }),
  };
};

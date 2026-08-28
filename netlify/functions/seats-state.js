/* Public seat state, the map's only source of truth (spec §3.2 step 1).
   Buyer-blind: console holds and buyer holds and sold all collapse into
   "unavailable"; which is which is the console's business.
   CDN-cached ~8s so a radio-spike of viewers costs ~1 origin hit per
   interval, not one per person (free-tier economics, walls-first item). */
const store = require("./lib/store");
const { HOUSE } = require("./lib/house");
const crypto = require("crypto");

exports.handler = async () => {
  const s = await store.state();
  const unavailable = [...new Set([...s.sold, ...s.held, ...Object.keys(s.adminHolds)])];
  /* v3.69: discount codes ride hashed, so the code words never appear in this
     public payload; the client hashes what the buyer types and matches. */
  const discounts = {};
  for (const [code, d] of Object.entries(HOUSE.discounts || {}))
    if (d && d.enabled !== false) {
      const entry = { off: d.off || 0, tiers: d.tiers || [] };
      /* v3.78: fixed per-tier code prices ride as plain numbers (no words) */
      if (d.prices) entry.prices = d.prices;
      /* v3.77: single-use codes also carry their live burned state, so the page
         can say "already used" before a doomed checkout. Hashed like the rest. */
      if (d.once) {
        const used = Number(await store._driver.eval(`return redis.call('GET', 'once:' .. ARGV[1]) or '0'`, [code])) || 0;
        entry.once = true; entry.maxSeats = d.maxSeats || 2; entry.left = used >= 1 ? 0 : 1;
      }
      discounts[crypto.createHash("sha256").update(String(code).toUpperCase()).digest("hex")] = entry;
    }
  /* free-ticket codes (v3.75): same hashed ride; "left" is the live pool so the
     page can clamp before a doomed checkout. */
  const freeCodes = {};
  for (const [code, f] of Object.entries(HOUSE.freeCodes || {}))
    if (f && f.enabled !== false) {
      const used = Number(await store._driver.eval(`return redis.call('GET', 'free:' .. ARGV[1]) or '0'`, [code])) || 0;
      freeCodes[crypto.createHash("sha256").update(String(code).toUpperCase()).digest("hex")] =
        { tier: f.tier, left: Math.max(0, (f.limit || 0) - used) };
    }
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Netlify-CDN-Cache-Control": "public, s-maxage=8, stale-while-revalidate=30",
    },
    body: JSON.stringify({ unavailable, sold: s.sold.length, ts: s.ts, orgCodes: (HOUSE.orgCodesEnabled !== false ? HOUSE.orgCodes : []) || [], orgShare: HOUSE.orgShare || 0.5, orgColors: HOUSE.orgColors || {}, merch: HOUSE.merch || null, discounts, freeCodes }),
  };
};

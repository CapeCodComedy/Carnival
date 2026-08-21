/* Public seat state, the map's only source of truth (spec §3.2 step 1).
   Buyer-blind: console holds and buyer holds and sold all collapse into
   "unavailable"; which is which is the console's business.
   CDN-cached ~8s so a radio-spike of viewers costs ~1 origin hit per
   interval, not one per person (free-tier economics, walls-first item). */
const store = require("./lib/store");
const { HOUSE } = require("./lib/house");

exports.handler = async () => {
  const s = await store.state();
  const unavailable = [...new Set([...s.sold, ...s.held, ...Object.keys(s.adminHolds)])];
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Netlify-CDN-Cache-Control": "public, s-maxage=8, stale-while-revalidate=30",
    },
    body: JSON.stringify({ unavailable, sold: s.sold.length, ts: s.ts, orgCodes: (HOUSE.orgCodesEnabled !== false ? HOUSE.orgCodes : []) || [], orgShare: HOUSE.orgShare || 0.5, orgColors: HOUSE.orgColors || {}, merch: HOUSE.merch || null }),
  };
};

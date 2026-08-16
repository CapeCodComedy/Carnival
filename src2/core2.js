/* ==================================================================
   CARNIVAL BOX OFFICE v2 — shared core (buyer + console)
   All-reserved, all-Stripe. The map IS the box office (spec §0).
   Seat state comes ONLY from /api/seats-state — never guessed locally.
   ================================================================== */
const CONFIG = {
  event: {
    org: "THE 1140A CORPORATION PRESENTS",
    title: 'THE CAPE COD <span class="amp">COMEDY CARNIVAL</span>',
    plainTitle: "The Cape Cod Comedy Carnival",
    when: "SAT 29 AUG 2026 · 7:00 PM · TILDEN ARTS CENTER",
    venue: "Tilden Arts Center, Cape Cod Community College",
    address: "2240 Iyannough Rd (Rte 132), West Barnstable, MA 02668",
    contactEmail: "info@1140A.com",
    url: "https://1140a.com"
  },
  prices: { orch: 88, t1: 66, t2: 55, balc: 28 },     // ticket price per zone (owner-locked)
  fee: 3.00,                                           // flat per-seat card-processing pass-through (spec §9)
  wheelchair: { price: 33, fee: 0 },                   // accessible flow: standard T2 price, fee waived
  currency: "$",
  maxPerOrder: 10,
  zones: {
    orch: { name: "ORCHESTRA", desc: "Rows TA, TB & C — the pit rows, right on the stage" },
    t1:   { name: "TIER 1",    desc: "Rows D–J — heart of the house" },
    t2:   { name: "TIER 2",    desc: "Rows K–Q — the cross-aisle back half" },
    balc: { name: "BALCONY",   desc: "Rows AA–EE — the high view" }
  },
  softHoldSec: 180,        // 3-minute courtesy hold while a buyer decides
  pollMs: 8000,            // map repaint cadence (matches CDN cache window)
  api: "/api",
  gate: { enabled: false, password: "pitrow" }   // THE SWITCH — false = public
};

/* ---------- house layout (venue chart — geometry only; state lives server-side) ---------- */
/*{{LAYOUT}}*/

/* zone + wheelchair lookup derived from the layout walk */
const seatZone = {}, WC_IDS = new Set();
LAYOUT.forEach(R => {
  const put = (row, n) => {
    const id = `${row}-${n}`;
    seatZone[id] = R.zone;
    if (typeof n === "string") WC_IDS.add(id);
  };
  (Array.isArray(R.l) ? R.l : []).forEach(n => put(R.row, n));
  (R.c || []).forEach(n => put(R.row, n));
  (Array.isArray(R.r) ? R.r : []).forEach(n => put(R.row, n));
  if (R.ext) R.ext.seats.forEach(n => put(R.ext.row, n));
});

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const money = n => CONFIG.currency + (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toFixed(2));
function holdWords(msLeft){
  const m = Math.ceil(msLeft / 60000);
  if (msLeft <= 0) return "expired";
  if (m <= 1) return "under a minute";
  return m + " min";
}
if (typeof CanvasRenderingContext2D !== "undefined" && !CanvasRenderingContext2D.prototype.roundRect){
  CanvasRenderingContext2D.prototype.roundRect = function(x,y,w,h,r){
    r = Math.min(r, w/2, h/2);
    this.moveTo(x+r,y); this.arcTo(x+w,y,x+w,y+h,r); this.arcTo(x+w,y+h,x,y+h,r);
    this.arcTo(x,y+h,x,y,r); this.arcTo(x,y,x+w,y,r); this.closePath(); return this;
  };
}
let toastT = null;
function toast(msg){
  const t = $("#toast"); if (!t) return;
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 3800);
}

/* ---------- seat-map renderer (geometry from the venue chart) ---------- */
/*{{MAPGEO}}*/

  /* ---------- paint (v2: all-reserved; state injected, never guessed) ---------- */
  const HOLD_COLORS = { sponsor:"#e6c069", comp:"#8fd9c9", marketing:"#f5b445", companion:"#7f96d9",
                        volunteer:"#7fb069", charity:"#c07fb0", wheelchair:"#7f96d9", house:"#8d8fa3" };

  function update(view){
    /* view: { unavailable:Set, selected:Set, cats?:Object(id->category), buyerHeld?:Set } */
    const isBuyer = opts.mode === "buyer";
    seatEls.forEach((els, id) => {
      const zone = seatZone[id];
      els.g.classList.remove("sold","blocked","sel");
      if (els.isWC){
        /* wheelchair space: bookable via accessible flow unless sold/held */
        const gone = view.unavailable.has(id);
        els.shape.setAttribute("fill", gone ? "var(--sold)" : "var(--held)");
        els.shape.setAttribute("stroke", gone ? "#4a4e63" : "#7f96d9");
        els.g.classList.add("wc");
        els.g.setAttribute("aria-label", gone ? `Wheelchair space — unavailable` : `Wheelchair space — tap for accessible booking`);
        return;
      }
      const sel = view.selected && view.selected.has(id);
      if (sel){
        els.g.classList.add("sel");
        els.shape.setAttribute("fill", "var(--glow)");
        els.shape.setAttribute("stroke-width", "0");
        els.label.setAttribute("opacity", .95);
        els.g.setAttribute("aria-label", `Seat ${id} — in your stub`);
        return;
      }
      els.label.setAttribute("opacity", 0);
      if (view.unavailable.has(id)){
        els.g.classList.add(isBuyer ? "sold" : "blocked");
        els.shape.setAttribute("fill", isBuyer ? "var(--sold)" : (view.cats && view.cats[id] ? "var(--held)" : "var(--sold)"));
        if (!isBuyer && view.cats && view.cats[id]){
          els.shape.setAttribute("stroke", HOLD_COLORS[view.cats[id]] || HOLD_COLORS.house);
          els.shape.setAttribute("stroke-width", "1.7");
        } else if (!isBuyer && view.buyerHeld && view.buyerHeld.has(id)){
          els.shape.setAttribute("stroke", "#ffffff");
          els.shape.setAttribute("stroke-width", "1.4");
        } else els.shape.setAttribute("stroke-width", "0");
        els.g.setAttribute("aria-label", `Seat ${id} — sold`);
        return;
      }
      /* open */
      els.shape.setAttribute("fill", "var(--bone)");
      els.g.setAttribute("aria-label", `Seat ${id}, ${CONFIG.zones[zone].name} — available, ${money(CONFIG.prices[zone])}`);
      if (zone === "orch"){ els.shape.setAttribute("stroke", "var(--gilt)"); els.shape.setAttribute("stroke-width", "1.5"); }
      else els.shape.setAttribute("stroke-width", "0");
    });
  }
  return { update, seatEls };
}

/* ================= OWNER CONSOLE (v2 — live store) ================= */
let TOKEN = null, map = null, tool = "inspect", lastState = { unavailable: new Set(), cats: {}, buyerHeld: new Set(), soldSet: new Set() };

const call = (action, extra) => fetch(CONFIG.api + "/admin-api", {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-admin-token": TOKEN },
  body: JSON.stringify({ action, ...(extra || {}) })
}).then(async r => ({ ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) }));

(function gate(){
  const g = $("#gate"), site = $("#site");
  g.hidden = false;
  const tryPw = async () => {
    TOKEN = $("#gatePw").value.trim();
    const r = await call("state");
    if (!r.ok){ $("#gateErr").textContent = r.status === 401 ? "Bad token." : "Backend unreachable — deployed with functions?"; return; }
    g.hidden = true; site.style.visibility = "visible"; boot(r.data);
  };
  $("#gateGo").addEventListener("click", tryPw);
  $("#gatePw").addEventListener("keydown", e => { if (e.key === "Enter") tryPw(); });
})();

function boot(initial){
  $$(".tab[data-pane]").forEach(t => t.addEventListener("click", () => {
    $$(".tab[data-pane]").forEach(x => x.classList.toggle("on", x === t));
    $$(".pane").forEach(p => p.classList.toggle("on", p.id === "pane-" + t.dataset.pane));
  }));
  const tools = { inspect:"INSPECT", house:"BLOCK (house)", sponsor:"MARK SPONSOR", marketing:"MARK MARKETING",
                  release:"RELEASE TO SALE", marksold:"MARK SOLD (comp)", unsell:"UNDO SOLD" };
  Object.entries(tools).forEach(([k, v], i) => {
    const b = document.createElement("button");
    b.className = "tab" + (i === 0 ? " on" : ""); b.textContent = v;
    b.addEventListener("click", () => { tool = k; $$("#toolTools .tab").forEach(x => x.classList.toggle("on", x === b)); });
    $("#toolTools").appendChild(b);
  });
  map = buildSeatMap($("#adminMap"), { mode: "admin", getShow: () => "all", onSeat });
  buildActions();
  apply(initial);
  setInterval(refresh, 6000);
  $("#wlBtn").addEventListener("click", async () => {
  $("#wlBox").textContent = "counting…";
  const r = await call("waitlist");
  if (!r.ok){ $("#wlBox").textContent = "error: " + JSON.stringify(r.data); return; }
  const d = r.data;
  const fmtSec = s => `orch ${s.orch} · t1 ${s.t1} · t2 ${s.t2} · balc ${s.balc} · any ${s.any}`;
  const lines = [`total in line: ${d.total}`, `SAGALOW ${d.sagalow} · CANNON ${d.cannon} · EITHER ${d.either}`];
  if (d.sections) lines.push(`sections — ${fmtSec(d.sections)}`);
  if (d.cross) ["sagalow", "cannon", "either"].forEach(k => { if (d[k]) lines.push(`${k.toUpperCase().padEnd(8)} ${fmtSec(d.cross[k])}`); });
  lines.push("");
  (d.entries || []).slice(0, 12).forEach(e => lines.push(`${new Date(e.ts).toLocaleString()}  ${e.choice.toUpperCase().padEnd(8)} ${String(e.tier || "any").toUpperCase().padEnd(5)} ${e.email}`));
  if ((d.entries || []).length > 12) lines.push(`… and ${d.entries.length - 12} more`);
  $("#wlBox").textContent = lines.join("\n");
});
$("#proveBtn").addEventListener("click", async () => {
    const r = await call("ledger");
    $("#ledgerBox").textContent = JSON.stringify(r.data, null, 1);
  });
}

async function refresh(){ const r = await call("state"); if (r.ok) apply(r.data); }
function apply(s){
  const cats = s.adminHolds || {};
  const buyerHeld = new Set(s.held || []);
  const soldSet = new Set(s.sold || []);
  const unavailable = new Set([...soldSet, ...buyerHeld, ...Object.keys(cats)]);
  lastState = { unavailable, cats, buyerHeld, soldSet };
  map.update(lastState);
  const heldN = Object.keys(cats).filter(id => !WC_IDS.has(id)).length;
  $("#countChip").textContent = `${soldSet.size} SOLD · ${buyerHeld.size} IN CARTS · ${heldN} HELD`;
  const zoneSold = { orch: 0, t1: 0, t2: 0, balc: 0 }; let rev = 0;
  soldSet.forEach(id => { const z = seatZone[id]; if (z && !WC_IDS.has(id)){ zoneSold[z]++; rev += CONFIG.prices[z]; } });
  $("#statTiles").innerHTML = `
    <div class="stat money"><b>${money(rev)}</b><span>Ticket revenue (est · Stripe is truth)</span></div>
    <div class="stat"><b>${soldSet.size}</b><span>Seats sold</span></div>
    <div class="stat"><b>${zoneSold.orch}</b><span>Orchestra</span></div>
    <div class="stat"><b>${zoneSold.t1}</b><span>Tier 1</span></div>
    <div class="stat"><b>${zoneSold.t2}</b><span>Tier 2</span></div>
    <div class="stat"><b>${zoneSold.balc}</b><span>Balcony</span></div>`;
}

const WHAT = { sponsor:"SPONSOR block", comp:"HOUSE COMP — the owner's personal hold (Mom's seat)",
  marketing:"MARKETING / giveaway hold", companion:"WHEELCHAIR COMPANION — pairs with a row-K space",
  volunteer:"VOLUNTEER hold", charity:"MARKETING & CHARITY hold (balcony wing)", house:"generic house hold" };

async function onSeat(id){
  const { cats, buyerHeld, soldSet } = lastState;
  if (tool === "inspect"){
    if (WC_IDS.has(id)) return msg(`${id} — wheelchair space (${soldSet.has(id) ? "BOOKED" : "open for accessible booking"})`);
    if (cats[id]) return msg(`${id} — HELD: ${WHAT[cats[id]] || cats[id]}`);
    if (soldSet.has(id)) return msg(`${id} — SOLD (live store; Stripe has the payment)`);
    if (buyerHeld.has(id)) return msg(`${id} — in a buyer's cart right now (hold expires on its own)`);
    return msg(`${id} — OPEN · ${CONFIG.zones[seatZone[id]].name} · ${money(CONFIG.prices[seatZone[id]])}`);
  }
  let r;
  if (tool === "release")  r = await call("release", { seats: [id] });
  else if (tool === "unsell") r = await call("unsell", { seats: [id] });
  else if (tool === "marksold") {
    r = await call("marksold", { seats: [id] });
    if (r.ok && r.data.sid){
      $("#seatMsg").innerHTML = `${id} — COMP issued. <a href="/success.html?sid=${encodeURIComponent(r.data.sid)}" target="_blank" style="color:var(--glow)">OPEN THE TICKET</a> — print it (Ctrl+P) or copy that page's address to forward it.`;
      refresh(); return;
    }
  }
  else r = await call("hold", { seats: [id], category: tool });
  msg(r.ok ? `${id} — ${tool} done.` : `${id} — failed: ${r.data.err || r.status}`);
  refresh();
}
const msg = t => { $("#seatMsg").textContent = t; };

function buildActions(){
  const A = $("#actionList");
  const add = (title, sub, label, fn) => {
    const d = document.createElement("div");
    d.className = "action";
    d.innerHTML = `<div class="a-info"><b>${title}</b><span>${sub}</span></div>`;
    const b = document.createElement("button");
    b.className = "btn primary"; b.textContent = label;
    b.addEventListener("click", async () => { await fn(); refresh(); });
    d.appendChild(b);
    A.appendChild(d);
  };
  add("Initialize house holds — run once at setup",
      "Seeds sponsor 12, house comp TA-108, marketing 16, companion 4, volunteer 6, charity 20 into the live store. Idempotent — safe to press twice.",
      "Seed the house", async () => { const r = await call("seed"); toast(r.ok ? "House holds seeded." : "Seed failed."); });
  const bulk = (cat, label, sub) => add(label, sub, "Release all " + cat, async () => {
    const ids = Object.entries(lastState.cats).filter(([, c]) => c === cat).map(([id]) => id);
    if (!ids.length) return toast("None held in that category.");
    await call("release", { seats: ids }); toast(`${ids.length} ${cat} seats released to sale.`);
  });
  bulk("sponsor", "Sponsor block — the twelve", "TA/TB 110–115. No sponsor landed? Release to sale.");
  bulk("marketing", "Marketing seats — all sixteen", "Fast sales? Release them — the show doesn't need the advertising.");
  bulk("charity", "Balcony charity block — the twenty", "DD/EE evens 10–28 behind the booth.");
  bulk("volunteer", "Volunteer seats — the six", "K-101–105 + K-110.");
  add("Purge expired holds", "Housekeeping — clears lapsed cart-holds early (they self-heal anyway).",
      "Purge", async () => { const r = await call("purge"); toast(`Purged ${r.data.purged ?? 0}.`); });
}

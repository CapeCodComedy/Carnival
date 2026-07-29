/* ================= BUYER BOX OFFICE LOGIC (v2 — all-Stripe) ================= */

/* ---------- gate ---------- */
(function gate(){
  const g = $("#gate"), site = $("#site");
  const open = () => { g.hidden = true; site.style.visibility = "visible"; boot(); };
  if (!CONFIG.gate.enabled){
    $("#modeChip").textContent = "ON SALE NOW"; $("#modeChip").classList.remove("warn"); $("#modeChip").classList.add("live");
    setTimeout(open, 0); return;   // after this script finishes initializing — never mid-parse
  }
  g.hidden = false;
  const tryPw = () => {
    if ($("#gatePw").value === CONFIG.gate.password) open();
    else { $("#gateErr").textContent = "Not tonight's password."; $("#gatePw").select(); }
  };
  $("#gateGo").addEventListener("click", tryPw);
  $("#gatePw").addEventListener("keydown", e => { if (e.key === "Enter") tryPw(); });
})();

/* ---------- state ---------- */
const HOLDER = "b_" + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now());
let unavailable = new Set();          // from the server — the only truth
const selected = new Set();           // my held seats (also appear server-side as held)
let map = null, pollT = null, holdTimer = null, holdEndsAt = null, paying = false;

const api = (path, body) => fetch(CONFIG.api + path, body ? {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
} : undefined).then(async r => ({ ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) }));

function boot(){
  $("#orgName").textContent = CONFIG.event.org;
  $("#evTitle").innerHTML = CONFIG.event.title;
  $("#evWhen").textContent = CONFIG.event.when + " · WEST BARNSTABLE, CAPE COD";
  ["#mailPlain2","#mailPlain3"].forEach(id => { const n = $(id); if (n) n.textContent = CONFIG.event.contactEmail; });
  const M = CONFIG.event.contactEmail, EV = CONFIG.event.plainTitle + " (Sat Aug 29)";
  $("#mailGroups").href = `mailto:${M}?subject=${encodeURIComponent("GROUP · " + EV)}&body=${encodeURIComponent("Name:\nParty size (eleven or more):\nSeating section you fancy:\nPhone:\n\nWe'll confirm a block together before anything is charged.")}`;
  $("#mailWheel").href  = `mailto:${M}?subject=${encodeURIComponent("WHEELCHAIR & ASSISTANCE · " + EV)}`;
  $("#mailAsl").href    = `mailto:${M}?subject=${encodeURIComponent("ASL INTERPRETER · " + EV)}`;

  map = buildSeatMap($("#map"), { mode: "buyer", getShow: () => "all", onSeat: onSeatClick });
  refreshState(true);
  pollT = setInterval(() => { if (!document.hidden) refreshState(); }, CONFIG.pollMs + Math.floor(Math.random() * 1500));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshState(); });
  if (new URLSearchParams(location.search).get("canceled"))
    toast("No charge — your seats release back to the house in a few minutes.");
}

async function refreshState(first){
  try {
    const r = await fetch(CONFIG.api + "/seats-state", { cache: "no-store" });
    const s = await r.json();
    unavailable = new Set(s.unavailable || []);
    selected.forEach(id => unavailable.delete(id));   // my own holds render as mine, not as gone
    paint();
    $("#liveNote").textContent = `Live map · ${s.sold} seats sold · refreshes automatically`;
  } catch (e) {
    if (first) toast("Can't reach the box office — check your connection and refresh.");
  }
}
const paint = () => map && map.update({ unavailable, selected });

/* ---------- selection (soft holds — real server holds, spec §5.1) ---------- */
async function onSeatClick(id){
  if (paying) return;
  if (WC_IDS.has(id)){ openTerms(id); return; }
  if (selected.has(id)){
    selected.delete(id); paint(); renderCart();
    api("/claim-seats", { holder: HOLDER, seats: [id], action: "release" });
    return;
  }
  if (unavailable.has(id)){ toast("Gone — that one's spoken for."); return; }
  if (selected.size >= CONFIG.maxPerOrder){
    toast("Orders cap at ten seats — for a bigger crew, use the Groups line below."); return;
  }
  const zone = seatZone[id];
  const existingZone = selected.size ? seatZone[[...selected][0]] : null;
  if (existingZone && existingZone !== zone){
    toast(`One section per checkout — finish your ${CONFIG.zones[existingZone].name} seats first (or clear the stub), then come back for ${CONFIG.zones[zone].name}.`);
    return;
  }
  const r = await api("/claim-seats", { holder: HOLDER, seats: [id], action: "hold" });
  if (!r.ok){
    toast(r.status === 409 ? "Someone just took that one — pick another." : (r.data.err || "Couldn't hold that seat."));
    refreshState(); return;
  }
  selected.add(id);
  bumpHold(); paint(); renderCart();
}

/* ---------- hold countdown (words only — house rule) ---------- */
function bumpHold(){
  holdEndsAt = Date.now() + CONFIG.softHoldSec * 1000;
  if (!holdTimer) holdTimer = setInterval(tickHold, 900);
  $("#holdRow").hidden = false;
  tickHold();
}
function tickHold(){
  const left = holdEndsAt - Date.now();
  if (left <= 0){
    clearInterval(holdTimer); holdTimer = null; $("#holdRow").hidden = true;
    if (selected.size && !paying){
      api("/claim-seats", { holder: HOLDER, seats: [...selected], action: "release" });
      selected.clear(); paint(); renderCart();
      toast("Hold expired — seats released back to the house. No harm done.");
    }
    return;
  }
  $("#holdClock").textContent = holdWords(left);
  $("#holdBar").style.width = (100 * left / (CONFIG.softHoldSec * 1000)).toFixed(1) + "%";
}

/* ---------- cart + fee transparency (spec §9: itemized, labeled, framed) ---------- */
function renderCart(){
  const list = $("#cartList"); list.innerHTML = "";
  const ids = [...selected].sort();
  let tickets = 0;
  ids.forEach(id => {
    const zone = seatZone[id];
    const p = CONFIG.prices[zone];
    tickets += p;
    const li = document.createElement("li");
    li.innerHTML = `<span>Seat ${id}<span class="tag">${CONFIG.zones[zone].name} · reserved</span></span>
      <span>${money(p)} <button aria-label="Remove ${id}" data-id="${id}">✕</button></span>`;
    list.appendChild(li);
  });
  list.querySelectorAll("button").forEach(b => b.addEventListener("click", () => onSeatClick(b.dataset.id)));
  const fee = ids.length * CONFIG.fee;
  $("#cartEmpty").style.display = ids.length ? "none" : "block";
  $("#totals").innerHTML = ids.length ? `
    <div><span>Tickets</span><span>${money(tickets)}</span></div>
    <div><span>Card processing fee — passed through at cost, we keep none of it</span><span>${money(fee)}</span></div>
    <div class="grand"><span>Total</span><span>${money(tickets + fee)}</span></div>` : "";
  $("#checkoutBtn").disabled = !ids.length;
  const mb = $("#miniBar");
  if (ids.length){ mb.classList.add("on"); $("#mbCount").textContent = "the stub"; $("#mbTotal").textContent = money(tickets + fee); }
  else mb.classList.remove("on");
  if (!ids.length && holdTimer){ clearInterval(holdTimer); holdTimer = null; $("#holdRow").hidden = true; }
}

/* ---------- checkout (hard hold + Stripe happen server-side) ---------- */
async function checkout(accessibleSeats){
  const seats = accessibleSeats || [...selected];
  if (!seats.length) return;
  paying = true;
  $("#checkoutBtn").disabled = true;
  $("#checkoutBtn").textContent = "Locking your seats…";
  const r = await api("/create-checkout", { holder: HOLDER, seats, accessible: !!accessibleSeats });
  if (!r.ok){
    paying = false;
    $("#checkoutBtn").textContent = "Pay & lock seats";
    $("#checkoutBtn").disabled = !selected.size;
    if (r.status === 409){
      toast(`Seat ${r.data.seat} was just taken — it's out of your stub; the rest are still yours.`);
      selected.delete(r.data.seat); refreshState(); renderCart();
    } else toast(r.data.err || "Payment page failed to open — nothing charged, seats released.");
    return;
  }
  location.href = r.data.url;
}
$("#checkoutBtn").addEventListener("click", () => checkout());
$("#mbGo").addEventListener("click", () => checkout());

/* ---------- accessible booking (terms-gated, $33 + $0 fee) ---------- */
let pendingWc = null;
function openTerms(spaceId){
  if (unavailable.has(spaceId)){ toast("That space is already booked — email us and we'll make room."); return; }
  pendingWc = spaceId;
  const comp = { "K-WA": "K-15", "K-WB": "K-5", "K-WC": "K-106", "K-WD": "K-14" }[spaceId];
  const compOpen = comp && !unavailable.has(comp);
  $("#wcChoiceBox").innerHTML = `
    <div class="pay-summary" style="margin:0">
      <div><span>Wheelchair space ${spaceId.split("-")[1].slice(1)} · row K</span><span>${money(CONFIG.wheelchair.price)} · card fee waived</span></div>
      ${compOpen ? `<div style="margin-top:4px"><label class="switch" style="font-size:12.5px"><input type="checkbox" id="wcComp" checked> Add companion seat ${comp}</label><span>${money(CONFIG.wheelchair.price)} · fee waived</span></div>`
                 : `<div><span style="color:var(--dim)">The paired companion seat is taken — email us and we'll seat a companion nearby.</span><span></span></div>`}
    </div>`;
  const sc = $("#termsScroll");
  sc.scrollTop = 0;
  $("#agreeBtn").disabled = true;
  $("#scrollHint").style.opacity = 1;
  $("#scrollHint").textContent = "▼ scroll to the very end to wake the agree button ▼";
  $("#termsModal").classList.add("open"); $("#veil").classList.add("open");
  requestAnimationFrame(() => requestAnimationFrame(termsEval));
}
function termsEval(){
  if (!$("#termsModal").classList.contains("open")) return;
  const el = $("#termsScroll");
  const fitsWhole = el.scrollHeight - el.clientHeight <= 6;
  const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 6;
  if (fitsWhole || atEnd){
    $("#agreeBtn").disabled = false;
    $("#scrollHint").style.opacity = .35;
    $("#scrollHint").textContent = fitsWhole ? "— the full terms fit your screen · agree is awake —" : "— read to the end · agree is awake —";
  }
}
$("#termsScroll").addEventListener("scroll", termsEval);
window.addEventListener("resize", termsEval);
$("#agreeBtn").addEventListener("click", () => {
  if (!pendingWc) return;
  const comp = { "K-WA": "K-15", "K-WB": "K-5", "K-WC": "K-106", "K-WD": "K-14" }[pendingWc];
  const seats = [pendingWc];
  if ($("#wcComp") && $("#wcComp").checked && comp) seats.push(comp);
  closeOverlays();
  toast("Opening secure payment for your accessible booking…");
  checkout(seats);
});
$("#openAccessible").addEventListener("click", () => {
  const open = ["K-WA","K-WB","K-WC","K-WD"].find(id => !unavailable.has(id));
  if (!open){ toast("All wheelchair spaces are booked — email us and we'll make room."); return; }
  openTerms(open);
});

/* ---------- panels / overlays ---------- */
$$(".cat-btn").forEach(b => b.addEventListener("click", () => {
  const id = "cat-" + b.dataset.cat;
  $$(".cat-panel").forEach(p => p.classList.toggle("open", p.id === id ? !p.classList.contains("open") : false));
}));
function closeOverlays(){ $("#veil").classList.remove("open"); $$(".modal").forEach(m => m.classList.remove("open")); }
$("#veil").addEventListener("click", closeOverlays);
$$("[data-close]").forEach(b => b.addEventListener("click", closeOverlays));
document.addEventListener("keydown", e => { if (e.key === "Escape") closeOverlays(); });

/* release my holds if I close the tab without paying */
window.addEventListener("pagehide", () => {
  if (selected.size && !paying && navigator.sendBeacon)
    navigator.sendBeacon(CONFIG.api + "/claim-seats",
      new Blob([JSON.stringify({ holder: HOLDER, seats: [...selected], action: "release" })], { type: "application/json" }));
});

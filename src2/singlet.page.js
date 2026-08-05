/* Solo-set page — live look at the room + the waiting list. No selling here:
   seats are view-only; clicks route to the list. SINGLET is injected at build. */
(function(){
  const S = window.SINGLET;                       // { name: "SAGALOW", choice: "sagalow" }
  $("#soloName").textContent = S.name;
  document.title = S.name + " Solo — The Cape Cod Comedy Carnival";

  /* section pick — feeds the demand poll; ANY is the default */
  const TIER_NAMES = { orch: "ORCHESTRA", t1: "TIER 1", t2: "TIER 2", balc: "BALCONY" };
  let tier = "any";
  $$(".wl-tier").forEach(b => b.addEventListener("click", () => {
    tier = b.dataset.tier;
    $$(".wl-tier").forEach(x => x.classList.toggle("on", x === b));
  }));

  let unavailable = new Set();
  let map = null;

  function paint(){ map && map.update({ unavailable, selected: new Set() }); }

  async function refreshState(){
    try {
      const r = await fetch(CONFIG.api + "/seats-state", { cache: "no-store" });
      const s = await r.json();
      unavailable = new Set(s.unavailable || []);
      paint();
      $("#liveNote").textContent = "Live map · refreshes automatically · solo tickets not on sale yet";
    } catch(e){}
  }

  map = buildSeatMap($("#map"), { mode: "buyer", getShow: () => "all",
    onSeat: () => toast("Solo-set seats aren't on sale yet — get in line above and you'll hear first.") });
  refreshState();
  setInterval(() => { if (!document.hidden) refreshState(); }, CONFIG.pollMs + 1500);

  $("#wlGo").addEventListener("click", async () => {
    const email = $("#wlEmail").value.trim();
    const msg = $("#wlMsg");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)){ msg.style.color = "#e08a7a"; msg.textContent = "That email doesn't look right."; return; }
    $("#wlGo").disabled = true;
    try {
      const r = await fetch("/api/waitlist", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, choice: S.choice, tier, hp: $("#wlHp").value }) });
      if (r.ok){ msg.style.color = "#a6c99a"; msg.textContent = "You're in line for " + S.name + " solo" + (tier !== "any" ? " — " + TIER_NAMES[tier] : "") + ". You'll hear the moment the window opens."; $("#wlEmail").value = ""; }
      else { const d = await r.json().catch(() => ({})); msg.style.color = "#e08a7a"; msg.textContent = d.err || "Something hiccuped — try again."; }
    } catch(e){ msg.style.color = "#e08a7a"; msg.textContent = "Can't reach the box office — check your connection."; }
    $("#wlGo").disabled = false;
  });
})();

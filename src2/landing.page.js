/* Landing page — one hot button + the singlet waitlist. Self-contained. */
(function(){
  const $ = s => document.querySelector(s);
  let choice = null;
  const picks = [...document.querySelectorAll(".wl-pick")];
  picks.forEach(b => b.addEventListener("click", () => {
    choice = b.dataset.choice;
    picks.forEach(x => { x.style.background = "transparent"; x.style.color = "var(--bone)"; x.style.borderColor = "#31365f"; });
    b.style.background = "var(--glow)"; b.style.color = "#171a2b"; b.style.borderColor = "var(--glow)";
    $("#wlMsg").textContent = "";
  }));

  $("#wlGo").addEventListener("click", async () => {
    const email = $("#wlEmail").value.trim();
    const msg = $("#wlMsg");
    if (!choice){ msg.style.color = "#e08a7a"; msg.textContent = "Pick a corner first — SAGALOW, CANNON, or EITHER ONE."; return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)){ msg.style.color = "#e08a7a"; msg.textContent = "That email doesn't look right."; return; }
    $("#wlGo").disabled = true; $("#wlGo").textContent = "…";
    try {
      const r = await fetch("/api/waitlist", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, choice, hp: $("#wlHp").value }) });
      if (r.ok){ msg.style.color = "#a6c99a"; msg.textContent = "You're in line. One email when the singlet window opens — that's the whole deal."; $("#wlEmail").value = ""; }
      else { const d = await r.json().catch(() => ({})); msg.style.color = "#e08a7a"; msg.textContent = d.err || "Something hiccuped — try again."; }
    } catch(e){ msg.style.color = "#e08a7a"; msg.textContent = "Can't reach the box office — check your connection."; }
    $("#wlGo").disabled = false; $("#wlGo").textContent = "JOIN THE WAITLIST";
  });
})();

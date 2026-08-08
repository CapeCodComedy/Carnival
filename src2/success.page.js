/* Success page — renders the tickets for a completed session. */
["#mailPlain","#mailPlain2"].forEach(id => { const n = document.querySelector(id); if (n) n.textContent = "info@1140A.com"; });
const sid = new URLSearchParams(location.search).get("session_id") || new URLSearchParams(location.search).get("sid");
let tries = 0;

function drawQR(canvas, text){
  const holder = document.createElement("div");
  holder.style.position = "absolute"; holder.style.left = "-9999px";
  document.body.appendChild(holder);
  let grid = null, n = 0;
  try {
    const q = new QRCode(holder, { text, width: 128, height: 128, correctLevel: QRCode.CorrectLevel.H });
    const inner = q._oQRCode; n = inner.getModuleCount(); grid = (r,c) => inner.isDark(r,c);
  } catch(e){}
  if (!grid){ const img = holder.querySelector("canvas"); if (img){ canvas.width=128; canvas.height=128; canvas.getContext("2d").drawImage(img,0,0);} holder.remove(); return; }
  const PAD = 2, cell = 6, size = (n + PAD*2) * cell;
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0,0,size,size);
  ctx.fillStyle = "#111319";
  for (let r=0;r<n;r++) for (let c=0;c<n;c++) if (grid(r,c)) ctx.fillRect((c+PAD)*cell, (r+PAD)*cell, cell, cell);
  holder.remove();
}

async function poll(){
  if (!sid){ show("lost"); return; }
  try {
    const r = await fetch("/api/order-status?sid=" + encodeURIComponent(sid), { cache: "no-store" });
    if (r.status === 404){ if (++tries > 10) show("lost"); else setTimeout(poll, 2000); return; }
    const o = await r.json();
    if (o.status === "sold"){ render(o); return; }
    if (o.status === "refunded_conflict"){
      document.querySelector("#pending h2").textContent = "That seat slipped away — you have NOT been charged";
      document.querySelector("#pending .sub").innerHTML = "In a rare photo-finish someone else completed payment on the same seat first. <b>Your payment has been automatically refunded in full.</b> Head back to the map — plenty of good chairs left.";
      return;
    }
    if (++tries > 20){ show("lost"); return; }
    setTimeout(poll, 2000);
  } catch(e){ if (++tries > 10) show("lost"); else setTimeout(poll, 2500); }
}
function show(id){ ["pending","done","lost"].forEach(x => document.getElementById(x).style.display = x === id ? "" : "none"); }
function render(o){
  show("done");
  const box = document.getElementById("tixList");
  (o.seats || []).forEach(id => {
    const code = o.codes ? o.codes[id] : "";
    const div = document.createElement("div");
    div.className = "ticket";
    div.innerHTML = `<div class="qr"><canvas></canvas></div>
      <div class="t-info">
        <span class="t-type">THE CAPE COD COMEDY CARNIVAL${o.accessible ? " · ACCESSIBLE" : ""}</span>
        <b>SEAT ${id}</b>
        <span>${code}</span><br>
        <span style="color:#6f6552">SAT 29 AUG · 7:00 PM · TILDEN ARTS CENTER</span>
      </div>`;
    box.appendChild(div);
    drawQR(div.querySelector("canvas"), code);
  });
  if (o.totalCents == null){   // house comp — issued from the booth, no charge, no fee line
    document.getElementById("recap").innerHTML =
      `<div class="grand" style="border-color:var(--bone)"><span>COMPLIMENTARY — issued by the box office</span><span>$0.00</span></div>`;
    return;
  }
  const tickets = (o.totalCents - o.feeCents) / 100, fee = o.feeCents / 100;
  document.getElementById("recap").innerHTML =
    `<div><span>Tickets</span><span>$${tickets.toFixed(2)}</span></div>
     <div><span>Card processing fee (pass-through)</span><span>$${fee.toFixed(2)}</span></div>
     <div class="grand" style="border-color:var(--bone)"><span>Total paid</span><span>$${(o.totalCents/100).toFixed(2)}</span></div>`;
}
poll();

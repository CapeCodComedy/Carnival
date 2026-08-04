/* Local harness: serves site/ and mounts the REAL Netlify function handlers
   at /api/* — same code paths as production, local Redis behind them, mock
   Stripe in front. Also exposes /test/pay and /test/abandon which deliver
   SIGNED webhook events to the real webhook handler (signature code = prod). */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { signPayload } = require("../netlify/functions/lib/stripe-adapter");

const FN = name => require("../netlify/functions/" + name);
const functions = {
  "seats-state": FN("seats-state"), "claim-seats": FN("claim-seats"),
  "create-checkout": FN("create-checkout"), "stripe-webhook": FN("stripe-webhook"),
  "order-status": FN("order-status"), "admin-api": FN("admin-api"), "scan": FN("scan"),
  "waitlist": FN("waitlist"),
};

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png" };

async function deliverWebhook(type, sid, payment_intent){
  const payload = JSON.stringify({ id: "evt_" + Math.random().toString(36).slice(2), type,
    data: { object: { id: sid, payment_intent: payment_intent || ("pi_mock_" + sid.slice(-8)),
      customer_details: { email: "buyer@test.local", name: "Test Buyer" } } } });
  const sig = signPayload(payload);
  return functions["stripe-webhook"].handler({ httpMethod: "POST", body: payload, headers: { "stripe-signature": sig } });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  let body = "";
  req.on("data", c => body += c);
  await new Promise(r => req.on("end", r));

  /* test-only endpoints: simulate Stripe completing / expiring a session */
  if (url.pathname === "/test/pay" || url.pathname === "/test/abandon"){
    const sid = url.searchParams.get("sid");
    const out = await deliverWebhook(url.pathname === "/test/pay" ? "checkout.session.completed" : "checkout.session.expired", sid);
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(out.body); return;
  }
  if (url.pathname === "/test/refund"){
    const pi = url.searchParams.get("pi");
    const out = await deliverWebhook("charge.refunded", "x", pi);
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(out.body); return;
  }

  if (url.pathname.startsWith("/api/")){
    const fn = functions[url.pathname.slice(5)];
    if (!fn){ res.writeHead(404); res.end("no fn"); return; }
    const out = await fn.handler({
      httpMethod: req.method, body,
      headers: Object.fromEntries(Object.entries(req.headers)),
      queryStringParameters: Object.fromEntries(url.searchParams.entries()),
    });
    res.writeHead(out.statusCode, out.headers || {}); res.end(out.body); return;
  }

  /* mock Stripe checkout page */
  if (url.pathname === "/mock-pay.html"){
    const sid = url.searchParams.get("sid");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><html><body style="font-family:sans-serif;background:#635bff;color:#fff;display:grid;place-items:center;height:100vh;margin:0">
      <div style="text-align:center"><h1>MOCK STRIPE CHECKOUT</h1><p>session ${sid}</p>
      <button id=pay style="font-size:22px;padding:14px 28px">PAY NOW</button>
      <button id=ab style="font-size:14px;padding:10px">abandon</button></div>
      <script>
        document.getElementById('pay').onclick = async () => { await fetch('/test/pay?sid=${sid}'); location.href='/success.html?session_id=${sid}'; };
        document.getElementById('ab').onclick  = async () => { await fetch('/test/abandon?sid=${sid}'); location.href='/?canceled=1'; };
      </script></body></html>`);
    return;
  }

  /* static site */
  let p = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.join(__dirname, "..", "site", p);
  if (fs.existsSync(file) && fs.statSync(file).isFile()){
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "text/plain" });
    res.end(fs.readFileSync(file)); return;
  }
  res.writeHead(404); res.end("not found");
});
server.listen(8899, () => console.log("harness on http://127.0.0.1:8899 (mock Stripe, local Redis, REAL function handlers)"));

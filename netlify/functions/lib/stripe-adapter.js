/* Stripe adapter — real SDK when STRIPE_SECRET_KEY is a real key,
   a faithful local mock when it is "mock" (tests/harness only).
   Webhook SIGNATURE VERIFICATION is real crypto in BOTH modes: the mock
   signs payloads exactly the way Stripe does (t=...,v1=HMAC-SHA256),
   so the verification code path exercised in tests is the production path. */
const crypto = require("crypto");

const SECRET = process.env.STRIPE_SECRET_KEY || "mock";
const WH_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "whsec_mock";

function verifySignature(rawBody, sigHeader, secret) {
  const parts = Object.fromEntries(String(sigHeader || "").split(",").map(p => p.split("=")));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) throw new Error("bad signature header");
  const expected = crypto.createHmac("sha256", secret.replace(/^whsec_/, ""))
    .update(`${t}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(v1);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("signature mismatch");
  return JSON.parse(rawBody);
}
/* test helper: sign a payload the way Stripe would */
function signPayload(rawBody, secret = WH_SECRET) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac("sha256", secret.replace(/^whsec_/, "")).update(`${t}.${rawBody}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

function makeStripe() {
  if (SECRET !== "mock" && /^r?k_|^sk_/.test(SECRET)) {
    const Stripe = require("stripe");
    const s = new Stripe(SECRET);
    return {
      mode: "real",
      createSession: (params) => s.checkout.sessions.create(params),
      refund: (paymentIntent) => s.refunds.create({ payment_intent: paymentIntent }),
      constructEvent: (raw, sig) => s.webhooks.constructEvent(raw, sig, WH_SECRET),
    };
  }
  /* ---- mock mode ---- */
  return {
    mode: "mock",
    createSession: async (params) => {
      const id = "cs_mock_" + crypto.randomBytes(8).toString("hex");
      return { id, url: `/mock-pay.html?sid=${id}`, expires_at: Math.floor(Date.now() / 1000) + 1800,
               payment_intent: "pi_mock_" + id.slice(-8), metadata: params.metadata };
    },
    refund: async (paymentIntent) => ({ id: "re_mock", payment_intent: paymentIntent, status: "succeeded" }),
    constructEvent: (raw, sig) => verifySignature(raw, sig, WH_SECRET),
  };
}

module.exports = { stripe: makeStripe(), signPayload, WH_SECRET };

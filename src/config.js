const path = require("path");
const env = process.env;

const port = Number(env.PORT) || 3000;
const cfg = {
  prod: env.NODE_ENV === "production",
  port,
  siteName: env.SITE_NAME || "Holdline3FA",
  publicUrl: (env.PUBLIC_URL || "http://localhost:" + port).replace(/\/$/, ""),
  dbPath: env.DATABASE_PATH || path.join(__dirname, "..", "data", "holdline.db"),
  provider: ["mock", "http"].includes(env.PROVIDER) ? env.PROVIDER : "mock",
  stripeKey: env.STRIPE_SECRET_KEY || "",
  stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || "",
  currency: "NGN",
  // Naira per 1 US dollar. Only used to convert the starter price list the first time the database is created.
  usdRate: Number(env.USD_RATE) > 0 ? Number(env.USD_RATE) : 1346,
  allowDemoTopup: env.ALLOW_DEMO_TOPUP === "1",
  sessionDays: 14,
  // Set TRUST_PROXY=1 when the site sits behind a proxy or host that sets X-Forwarded-For (most hosts do).
  trustProxy: env.TRUST_PROXY === "1",
};

if (cfg.prod && cfg.provider === "mock") {
  console.warn("[warn] PROVIDER=mock: numbers and codes are simulated. Set PROVIDER=http and fill in src/providers/http.js to sell real numbers.");
}
if (cfg.prod && cfg.allowDemoTopup) {
  console.warn("[warn] ALLOW_DEMO_TOPUP=1: anyone can add free credit. Turn this off before going live.");
}
if (cfg.stripeKey && !cfg.stripeWebhookSecret) {
  console.warn("[warn] STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is missing. Paid top-ups will not be credited.");
}

module.exports = cfg;

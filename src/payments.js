const crypto = require("crypto");
const cfg = require("./config");
const { db, tx } = require("./db");
const { creditUser } = require("./orders");
const { readBody } = require("./mini");
const { HttpError } = require("./util");

const MIN_CENTS = 100000; // N1,000 in kobo
const MAX_CENTS = 50000000; // N500,000 in kobo

function topupMode() {
  if (cfg.stripeKey) return "stripe";
  if (cfg.allowDemoTopup) return "demo";
  return "none";
}

/** Flatten nested objects into Stripe's form encoding: a[b][c]=1 */
function form(obj, prefix = "", out = []) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v && typeof v === "object") form(v, key, out);
    else out.push(encodeURIComponent(key) + "=" + encodeURIComponent(v));
  }
  return out;
}

/** Start a top-up. Returns { url } to redirect to (Stripe Checkout) or { credited: true } (demo mode). */
async function startTopup(user, amountCents) {
  if (!Number.isInteger(amountCents) || amountCents < MIN_CENTS || amountCents > MAX_CENTS) {
    throw new HttpError(400, `Choose an amount between \u20a6${(MIN_CENTS / 100).toLocaleString("en-NG")} and \u20a6${(MAX_CENTS / 100).toLocaleString("en-NG")}.`);
  }
  if (cfg.stripeKey) {
    const body = form({
      mode: "payment",
      line_items: { 0: { quantity: 1, price_data: { currency: "ngn", unit_amount: amountCents, product_data: { name: `${cfg.siteName} credit` } } } },
      client_reference_id: String(user.id),
      metadata: { user_id: String(user.id) },
      customer_email: user.email,
      success_url: cfg.publicUrl + "/?topup=success",
      cancel_url: cfg.publicUrl + "/?topup=cancelled",
    }).join("&");
    let data;
    try {
      const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: { Authorization: "Bearer " + cfg.stripeKey, "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(15000),
      });
      data = await res.json();
      if (!res.ok || !data.url) throw new Error((data.error && data.error.message) || "HTTP " + res.status);
    } catch (e) {
      console.error("[stripe] checkout failed:", e.message);
      throw new HttpError(502, "Could not start the payment. Please try again.");
    }
    return { url: data.url };
  }
  if (cfg.allowDemoTopup) {
    creditUser(user.id, amountCents, "demo_topup", null);
    return { credited: true };
  }
  throw new HttpError(503, "Card payments are not set up yet.");
}

/** Verify Stripe's "Stripe-Signature" header: t=<unix>,v1=<hmac sha256 of "t.body">. */
function verifyStripeSignature(raw, header, secret, toleranceSec = 300) {
  let t = null;
  const sigs = [];
  String(header || "").split(",").forEach((part) => {
    const i = part.indexOf("=");
    if (i < 0) return;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    if (k === "v1") sigs.push(v);
  });
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  const expected = crypto.createHmac("sha256", secret).update(t + ".").update(raw).digest();
  return sigs.some((s) => {
    const got = Buffer.from(s, "hex");
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
}

/** Stripe webhook: credits the wallet once per paid Checkout session. */
async function stripeWebhook(req, res) {
  if (!cfg.stripeWebhookSecret) return res.status(503).json({ error: "Webhook not configured." });
  const raw = await readBody(req, 1024 * 1024);
  if (!verifyStripeSignature(raw, req.headers["stripe-signature"], cfg.stripeWebhookSecret)) {
    return res.status(400).json({ error: "Bad signature." });
  }
  let event;
  try { event = JSON.parse(raw.toString("utf8")); } catch (_) { return res.status(400).json({ error: "Bad payload." }); }

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const s = event.data && event.data.object;
    if (s && s.payment_status === "paid" && Number.isInteger(s.amount_total) && s.amount_total > 0 && s.currency === "ngn") {
      const userId = Number(s.metadata && s.metadata.user_id);
      if (db.prepare("SELECT 1 FROM users WHERE id = ?").get(userId)) {
        try {
          tx(() => {
            // session id is the primary key, so a repeated webhook can never credit twice
            db.prepare("INSERT INTO payments (session_id, user_id, amount_cents, created_at) VALUES (?, ?, ?, ?)").run(s.id, userId, s.amount_total, Date.now());
            db.prepare("UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?").run(s.amount_total, userId);
            db.prepare("INSERT INTO ledger (user_id, delta_cents, reason, ref, created_at) VALUES (?, ?, 'stripe_topup', ?, ?)").run(userId, s.amount_total, s.id, Date.now());
          });
        } catch (e) {
          if (!String(e.message).includes("UNIQUE")) {
            console.error("[stripe] credit failed:", e.message);
            return res.status(500).json({ error: "Could not credit." });
          }
        }
      }
    }
  }
  res.json({ received: true });
}

module.exports = { topupMode, startTopup, stripeWebhook, verifyStripeSignature, MIN_CENTS, MAX_CENTS };

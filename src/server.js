const path = require("path");
const cfg = require("./config");
require("./db");
const { App, jsonBody, serveStatic, rateLimit, securityHeaders } = require("./mini");
const auth = require("./auth");
const payments = require("./payments");
const orders = require("./orders");
const { HttpError } = require("./util");

const app = new App({ trustProxy: cfg.trustProxy });

app.use(securityHeaders({ prod: cfg.prod }));

// Stripe needs the untouched request body to verify its signature, so the JSON parser skips this path.
app.post("/api/stripe/webhook", payments.stripeWebhook);

app.use("/api", rateLimit({ windowMs: 60 * 1000, limit: 300, message: "Too many requests. Slow down." }));
app.use(jsonBody(20 * 1024, "/api/stripe/webhook"));
app.use(auth.attachUser);
app.use("/api", auth.sameOrigin);
app.use("/api", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.use("/api/admin", require("./routes-admin"));
app.use("/api", require("./routes-api"));
app.use("/api", (_req, _res, next) => next(new HttpError(404, "Not found.")));

// The admin page is only served to signed-in admins.
app.get("/admin", (req, res) => {
  if (!req.user || req.user.role !== "admin") return res.redirect("/?login=admin");
  res.sendFile(path.join(__dirname, "..", "views", "admin.html"));
});

app.use(serveStatic(path.join(__dirname, "..", "public"), { maxAge: cfg.prod ? 3600 : 0 }));

// Error handler (four arguments).
app.use((err, _req, res, _next) => {
  const status = err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? "Something went wrong. Please try again." : err.message });
});

/** First start on a host with no shell: create the admin from ADMIN_EMAIL / ADMIN_PASSWORD if that account does not exist yet. */
async function bootstrapAdmin() {
  const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || "");
  if (!email || !password) return;
  const { db } = require("./db");
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) return;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || password.length < 10) {
    console.warn("[warn] ADMIN_EMAIL/ADMIN_PASSWORD ignored: need a valid email and a password of at least 10 characters.");
    return;
  }
  db.prepare("INSERT INTO users (email, pass_hash, role, created_at) VALUES (?, ?, 'admin', ?)").run(email, await auth.hashPassword(password), Date.now());
  console.log(`Created admin ${email}. You can now delete ADMIN_PASSWORD from your host settings.`);
}

if (require.main === module) {
  bootstrapAdmin().catch((e) => console.error("[bootstrapAdmin]", e.message));
  orders.startWorker();
  app.listen(cfg.port, () => console.log(`${cfg.siteName} running on ${cfg.publicUrl} (port ${cfg.port}, provider: ${cfg.provider})`));
}

module.exports = app;

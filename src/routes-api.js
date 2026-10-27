const { Router, rateLimit } = require("./mini");
const cfg = require("./config");
const { db, tx, getSettings } = require("./db");
const auth = require("./auth");
const orders = require("./orders");
const payments = require("./payments");
const { HttpError, wrap, int, str, bool } = require("./util");

const router = new Router();

const limiter = (windowMs, limit, message) => rateLimit({ windowMs, limit, message });
const authLimiter = limiter(60 * 1000, 10, "Too many attempts. Wait a minute and try again.");
const orderLimiter = limiter(60 * 1000, 20, "Too many orders too quickly. Wait a moment.");

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

router.get("/me", (req, res) => res.json({ user: auth.publicUser(req.user) }));

router.post("/auth/register", authLimiter, wrap(async (req, res) => {
  const settings = getSettings();
  if (!settings.signupsOpen) throw new HttpError(403, "New sign-ups are closed right now.");
  const email = str(req.body.email, { min: 3, max: 254, label: "email" }).toLowerCase();
  const password = str(req.body.password, { min: 10, max: 128, label: "password" });
  if (!EMAIL.test(email)) throw new HttpError(400, "Enter a valid email address.");
  if (!bool(req.body.acceptTerms)) throw new HttpError(400, "Please accept the terms to continue.");
  const hash = await auth.hashPassword(password);
  let userId;
  try {
    userId = tx(() => {
      const r = db.prepare("INSERT INTO users (email, pass_hash, created_at) VALUES (?, ?, ?)").run(email, hash, Date.now());
      const id = Number(r.lastInsertRowid);
      if (settings.welcomeCreditCents > 0) {
        db.prepare("UPDATE users SET balance_cents = ? WHERE id = ?").run(settings.welcomeCreditCents, id);
        db.prepare("INSERT INTO ledger (user_id, delta_cents, reason, created_at) VALUES (?, ?, 'welcome', ?)").run(id, settings.welcomeCreditCents, Date.now());
      }
      return id;
    });
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) throw new HttpError(409, "An account with that email already exists. Try logging in.");
    throw e;
  }
  auth.createSession(res, userId);
  const user = db.prepare("SELECT id, email, role, balance_cents FROM users WHERE id = ?").get(userId);
  res.status(201).json({ user: auth.publicUser(user) });
}));

router.post("/auth/login", authLimiter, wrap(async (req, res) => {
  const email = str(req.body.email, { min: 3, max: 254, label: "email" }).toLowerCase();
  const password = str(req.body.password, { min: 1, max: 128, label: "password" });
  const row = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!row) { await auth.burnTime(password); throw new HttpError(401, "Wrong email or password."); }
  const ok = await auth.verifyPassword(password, row.pass_hash);
  if (!ok) throw new HttpError(401, "Wrong email or password.");
  if (row.disabled) throw new HttpError(403, "This account is disabled.");
  auth.createSession(res, row.id);
  res.json({ user: auth.publicUser(row) });
}));

router.post("/auth/logout", (req, res) => {
  auth.destroySession(req, res);
  res.json({ ok: true });
});

router.get("/catalog", (_req, res) => {
  const settings = getSettings();
  const services = db.prepare("SELECT id, name, base_cents FROM services WHERE enabled = 1 ORDER BY name").all();
  const countries = db.prepare("SELECT mult FROM countries WHERE enabled = 1").all();
  const minMult = countries.length ? Math.min(...countries.map((c) => c.mult)) : 1;
  res.json({
    siteName: cfg.siteName,
    currency: cfg.currency,
    banner: settings.banner,
    maintenance: settings.maintenance,
    holdMinutes: settings.holdMinutes,
    signupsOpen: settings.signupsOpen,
    topupMode: payments.topupMode(),
    topupMin: payments.MIN_CENTS,
    services: services.map((s) => ({ id: s.id, name: s.name, from_cents: Math.max(100, Math.ceil(s.base_cents * minMult / 100 - 1e-9) * 100) })),
  });
});

router.get("/catalog/:id/countries", wrap(async (req, res) => {
  res.json({ countries: await orders.countryOptions(int(req.params.id, { min: 1, label: "app" })) });
}));

router.get("/orders", auth.requireAuth, (req, res) => {
  res.json({ orders: orders.listOrdersForUser(req.user.id) });
});

router.post("/orders", auth.requireAuth, orderLimiter, wrap(async (req, res) => {
  const serviceId = int(req.body.serviceId, { min: 1, label: "app" });
  const countryId = int(req.body.countryId, { min: 1, label: "country" });
  res.status(201).json({ order: await orders.placeOrder(req.user.id, serviceId, countryId) });
}));

router.post("/orders/:id/cancel", auth.requireAuth, wrap(async (req, res) => {
  res.json({ order: await orders.cancelOrder(req.user.id, int(req.params.id, { min: 1, label: "order" })) });
}));

router.post("/orders/:id/finish", auth.requireAuth, wrap(async (req, res) => {
  res.json({ order: await orders.finishOrder(req.user.id, int(req.params.id, { min: 1, label: "order" })) });
}));

router.post("/wallet/topup", auth.requireAuth, authLimiter, wrap(async (req, res) => {
  const amountCents = int(req.body.amountCents, { min: 1, max: 50000000, label: "amount" });
  res.json(await payments.startTopup(req.user, amountCents));
}));

module.exports = router;

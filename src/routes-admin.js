const { Router } = require("./mini");
const { db, tx, getSettings, setSetting } = require("./db");
const auth = require("./auth");
const orders = require("./orders");
const provider = require("./providers");
const { HttpError, wrap, int, str, bool } = require("./util");

const router = new Router();
router.use(auth.requireAdmin);

const log = (req, what) => console.log(`[admin] ${req.user.email}: ${what}`);

router.get("/overview", (_req, res) => {
  const t = db.prepare(`SELECT COUNT(*) AS orders,
      COALESCE(SUM(CASE WHEN status IN ('received','finished') THEN price_cents END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN status IN ('cancelled','expired','refunded','failed') THEN price_cents END), 0) AS refunded,
      COALESCE(SUM(status = 'waiting'), 0) AS waiting,
      COALESCE(SUM(status IN ('received','finished')), 0) AS delivered,
      COALESCE(SUM(status NOT IN ('waiting','pending')), 0) AS closed
    FROM orders`).get();
  const users = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  const topApps = db.prepare(`SELECT s.name, SUM(o.price_cents) AS cents FROM orders o JOIN services s ON s.id = o.service_id
    WHERE o.status IN ('received','finished') GROUP BY s.id ORDER BY cents DESC LIMIT 5`).all();
  res.json({ ...t, users, topApps, provider: process.env.PROVIDER || "mock" });
});

router.get("/orders", (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : "";
  const rows = db.prepare(`SELECT o.id, u.email, s.name AS service, c.name AS country, o.phone, o.price_cents, o.status, o.created_at
    FROM orders o JOIN users u ON u.id = o.user_id JOIN services s ON s.id = o.service_id JOIN countries c ON c.id = o.country_id
    ${status ? "WHERE o.status = ?" : ""} ORDER BY o.id DESC LIMIT 300`).all(...(status ? [status] : []));
  res.json({ orders: rows });
});

router.post("/orders/:id/refund", wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1, label: "order" });
  const o = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  if (!o) throw new HttpError(404, "Order not found.");
  if (o.status === "waiting" && o.provider_ref) { try { await provider.cancel(o.provider_ref); } catch (_) {} }
  if (!orders.refund(id, "refunded", "admin", ["waiting", "received"])) throw new HttpError(409, "This order cannot be refunded.");
  log(req, `refunded order ${id}`);
  res.json({ ok: true });
}));

router.get("/users", (_req, res) => {
  res.json({
    users: db.prepare(`SELECT u.id, u.email, u.role, u.balance_cents, u.disabled, u.created_at,
        (SELECT COUNT(*) FROM orders WHERE user_id = u.id) AS orders,
        (SELECT COALESCE(SUM(price_cents), 0) FROM orders WHERE user_id = u.id AND status IN ('received','finished')) AS spent_cents
      FROM users u ORDER BY u.id DESC LIMIT 500`).all(),
  });
});

router.post("/users/:id/credit", (req, res) => {
  const id = int(req.params.id, { min: 1, label: "user" });
  const cents = int(req.body.amountCents, { min: -50000000, max: 50000000, label: "amount" });
  if (cents === 0) throw new HttpError(400, "Enter an amount.");
  const note = typeof req.body.note === "string" ? req.body.note.slice(0, 80) : "";
  const user = db.prepare("SELECT id, balance_cents FROM users WHERE id = ?").get(id);
  if (!user) throw new HttpError(404, "User not found.");
  if (user.balance_cents + cents < 0) throw new HttpError(400, "That would take the balance below zero.");
  orders.creditUser(id, cents, "admin_adjust", note || null);
  log(req, `adjusted user ${id} by ${cents} kobo`);
  res.json({ ok: true });
});

router.post("/users/:id/disable", (req, res) => {
  const id = int(req.params.id, { min: 1, label: "user" });
  if (id === req.user.id) throw new HttpError(400, "You cannot disable your own account.");
  const disabled = bool(req.body.disabled) ? 1 : 0;
  tx(() => {
    db.prepare("UPDATE users SET disabled = ? WHERE id = ?").run(disabled, id);
    if (disabled) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
  });
  log(req, `${disabled ? "disabled" : "enabled"} user ${id}`);
  res.json({ ok: true });
});

// ---- catalog ----
router.get("/catalog", (_req, res) => {
  res.json({
    services: db.prepare("SELECT * FROM services ORDER BY name").all(),
    countries: db.prepare("SELECT * FROM countries ORDER BY name").all(),
  });
});

function serviceBody(b, partial) {
  const out = {};
  if (!partial || b.name !== undefined) out.name = str(b.name, { min: 1, max: 60, label: "name" });
  if (!partial || b.base_cents !== undefined) out.base_cents = int(b.base_cents, { min: 100, max: 100000000, label: "price" });
  if (b.provider_code !== undefined) out.provider_code = str(b.provider_code, { max: 80, label: "provider code" });
  if (b.enabled !== undefined) out.enabled = bool(b.enabled) ? 1 : 0;
  return out;
}
function countryBody(b, partial) {
  const out = {};
  if (!partial || b.name !== undefined) out.name = str(b.name, { min: 1, max: 60, label: "name" });
  if (!partial || b.iso !== undefined) out.iso = str(b.iso, { min: 1, max: 8, label: "country code" }).toLowerCase();
  if (!partial || b.dial !== undefined) {
    const d = str(b.dial, { min: 1, max: 8, label: "dial code" });
    out.dial = d.startsWith("+") ? d : "+" + d;
    if (!/^\+\d{1,6}$/.test(out.dial)) throw new HttpError(400, "Invalid dial code.");
  }
  if (!partial || b.mult !== undefined) {
    const m = Number(b.mult);
    if (!(m >= 0.1 && m <= 50)) throw new HttpError(400, "Price multiplier must be between 0.1 and 50.");
    out.mult = m;
  }
  if (b.stock_override !== undefined) out.stock_override = b.stock_override === null || b.stock_override === "" ? null : int(b.stock_override, { min: 0, max: 1000000, label: "stock" });
  if (b.provider_code !== undefined) out.provider_code = str(b.provider_code, { max: 80, label: "provider code" });
  if (b.enabled !== undefined) out.enabled = bool(b.enabled) ? 1 : 0;
  return out;
}
function insertRow(table, data) {
  const keys = Object.keys(data);
  try {
    return Number(db.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((k) => data[k])).lastInsertRowid);
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) throw new HttpError(409, "That name is already used.");
    throw e;
  }
}
function updateRow(table, id, data) {
  const keys = Object.keys(data);
  if (!keys.length) return;
  try {
    const r = db.prepare(`UPDATE ${table} SET ${keys.map((k) => k + " = ?").join(", ")} WHERE id = ?`).run(...keys.map((k) => data[k]), id);
    if (r.changes !== 1) throw new HttpError(404, "Not found.");
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) throw new HttpError(409, "That name is already used.");
    throw e;
  }
}

router.post("/services", (req, res) => {
  const d = serviceBody(req.body, false);
  if (d.provider_code === undefined) d.provider_code = d.name.toLowerCase();
  const id = insertRow("services", d);
  log(req, `added app ${d.name}`);
  res.status(201).json({ id });
});
router.patch("/services/:id", (req, res) => {
  updateRow("services", int(req.params.id, { min: 1 }), serviceBody(req.body, true));
  log(req, `edited app ${req.params.id}`);
  res.json({ ok: true });
});
router.delete("/services/:id", (req, res) => {
  const id = int(req.params.id, { min: 1 });
  if (db.prepare("SELECT 1 FROM orders WHERE service_id = ?").get(id)) throw new HttpError(409, "This app has orders. Switch it off instead of removing it.");
  db.prepare("DELETE FROM services WHERE id = ?").run(id);
  res.json({ ok: true });
});

router.post("/countries", (req, res) => {
  const d = countryBody(req.body, false);
  if (d.provider_code === undefined) d.provider_code = d.iso;
  const id = insertRow("countries", d);
  log(req, `added country ${d.name}`);
  res.status(201).json({ id });
});
router.patch("/countries/:id", (req, res) => {
  updateRow("countries", int(req.params.id, { min: 1 }), countryBody(req.body, true));
  log(req, `edited country ${req.params.id}`);
  res.json({ ok: true });
});
router.delete("/countries/:id", (req, res) => {
  const id = int(req.params.id, { min: 1 });
  if (db.prepare("SELECT 1 FROM orders WHERE country_id = ?").get(id)) throw new HttpError(409, "This country has orders. Switch it off instead of removing it.");
  db.prepare("DELETE FROM countries WHERE id = ?").run(id);
  res.json({ ok: true });
});

// ---- settings ----
router.get("/settings", (_req, res) => res.json({ settings: getSettings() }));
router.put("/settings", (req, res) => {
  const b = req.body;
  if (b.banner !== undefined) setSetting("banner", str(b.banner, { max: 200, label: "banner" }));
  if (b.maintenance !== undefined) setSetting("maintenance", bool(b.maintenance) ? "1" : "0");
  if (b.holdMinutes !== undefined) setSetting("hold_minutes", int(b.holdMinutes, { min: 1, max: 60, label: "hold time" }));
  if (b.welcomeCreditCents !== undefined) setSetting("welcome_credit_cents", int(b.welcomeCreditCents, { min: 0, max: 100000000, label: "welcome credit" }));
  if (b.signupsOpen !== undefined) setSetting("signups_open", bool(b.signupsOpen) ? "1" : "0");
  log(req, "updated settings");
  res.json({ settings: getSettings() });
});

module.exports = router;

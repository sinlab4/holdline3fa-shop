const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const cfg = require("./config");

fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
const db = new DatabaseSync(cfg.dbPath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  base_cents INTEGER NOT NULL CHECK (base_cents > 0),
  enabled INTEGER NOT NULL DEFAULT 1,
  provider_code TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS countries (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  iso TEXT NOT NULL,
  dial TEXT NOT NULL,
  mult REAL NOT NULL DEFAULT 1 CHECK (mult > 0),
  stock_override INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  provider_code TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  service_id INTEGER NOT NULL REFERENCES services(id),
  country_id INTEGER NOT NULL REFERENCES countries(id),
  phone TEXT,
  price_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  code TEXT,
  sms_text TEXT,
  provider_ref TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS orders_user ON orders(user_id, created_at);
CREATE INDEX IF NOT EXISTS orders_status ON orders(status);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  delta_cents INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  session_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`);

/** Run fn inside one write transaction. fn must be synchronous. */
function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch (_) {}
    throw e;
  }
}

// ---- Defaults (only inserted into an empty database) ----
const SERVICE_SEED = [
  ["WhatsApp", 42], ["Telegram", 38], ["Google", 35], ["Facebook", 30], ["Instagram", 32],
  ["X", 28], ["Discord", 25], ["TikTok", 34], ["Microsoft", 29], ["Amazon", 40],
  ["PayPal", 65], ["Uber", 36], ["Airbnb", 45], ["LinkedIn", 33], ["Signal", 31],
  ["Snapchat", 27], ["Netflix", 48], ["Spotify", 26], ["Bolt", 30], ["Binance", 70],
];
const COUNTRY_SEED = [
  ["United States", "us", "+1", 1.0], ["Canada", "ca", "+1", 1.0], ["United Kingdom", "gb", "+44", 1.25],
  ["Nigeria", "ng", "+234", 0.8], ["India", "in", "+91", 0.7], ["Germany", "de", "+49", 1.4],
  ["Brazil", "br", "+55", 0.9], ["Indonesia", "id", "+62", 0.75], ["Philippines", "ph", "+63", 0.85],
  ["Poland", "pl", "+48", 1.1],
];
const SETTINGS_SEED = { banner: "", maintenance: "0", hold_minutes: "10", welcome_credit_cents: "0", signups_open: "1" };

// All money is stored in kobo (1 naira = 100 kobo). Column names still say "cents" for historical reasons.
const nairaFromUsdCents = (usdCents) => Math.max(10, Math.ceil((usdCents * cfg.usdRate) / 100 / 10) * 10); // round up to the next 10 naira

if (db.prepare("SELECT COUNT(*) AS n FROM services").get().n === 0) {
  const ins = db.prepare("INSERT INTO services (name, base_cents, provider_code) VALUES (?, ?, ?)");
  SERVICE_SEED.forEach(([name, cents]) => ins.run(name, nairaFromUsdCents(cents) * 100, name.toLowerCase()));
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('currency', 'NGN')").run();
}
// One-time upgrade for databases created before Naira pricing: convert dollar cents to kobo.
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'currency'").get()) {
  const rate = cfg.usdRate;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE services SET base_cents = MAX(1000, ((base_cents * ? / 100 + 9) / 10) * 10 * 100)").run(rate);
    db.prepare("UPDATE users SET balance_cents = balance_cents * ?").run(rate);
    db.prepare("UPDATE orders SET price_cents = price_cents * ?").run(rate);
    db.prepare("UPDATE ledger SET delta_cents = delta_cents * ?").run(rate);
    db.prepare("UPDATE payments SET amount_cents = amount_cents * ?").run(rate);
    db.prepare("UPDATE settings SET value = CAST(CAST(value AS INTEGER) * ? AS TEXT) WHERE key = 'welcome_credit_cents'").run(rate);
    db.prepare("INSERT INTO settings (key, value) VALUES ('currency', 'NGN')").run();
    db.exec("COMMIT");
  } catch (e) { try { db.exec("ROLLBACK"); } catch (_) {} throw e; }
}
if (db.prepare("SELECT COUNT(*) AS n FROM countries").get().n === 0) {
  const ins = db.prepare("INSERT INTO countries (name, iso, dial, mult, provider_code) VALUES (?, ?, ?, ?, ?)");
  COUNTRY_SEED.forEach(([name, iso, dial, mult]) => ins.run(name, iso, dial, mult, iso));
}
const insSetting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
Object.entries(SETTINGS_SEED).forEach(([k, v]) => insSetting.run(k, v));

function getSettings() {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  const m = {};
  rows.forEach((r) => (m[r.key] = r.value));
  return {
    banner: m.banner || "",
    maintenance: m.maintenance === "1",
    holdMinutes: Math.max(1, Number(m.hold_minutes) || 10),
    welcomeCreditCents: Math.max(0, Number(m.welcome_credit_cents) || 0),
    signupsOpen: m.signups_open !== "0",
  };
}
function setSetting(key, value) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
}

module.exports = { db, tx, getSettings, setSetting };

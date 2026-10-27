const { db, tx, getSettings } = require("./db");
const provider = require("./providers");
const { HttpError } = require("./util");

const OPEN = ["pending", "waiting", "received"];

function priceCents(service, country) {
  // Prices are always whole naira (a multiple of 100 kobo), rounded up.
  return Math.max(100, Math.ceil(service.base_cents * country.mult / 100 - 1e-9) * 100);
}

function ledger(userId, delta, reason, ref) {
  db.prepare("INSERT INTO ledger (user_id, delta_cents, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)").run(userId, delta, reason, ref == null ? null : String(ref), Date.now());
}

/** Add (or remove) credit atomically and record it. */
function creditUser(userId, cents, reason, ref) {
  return tx(() => {
    db.prepare("UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?").run(cents, userId);
    ledger(userId, cents, reason, ref);
  });
}

// ---- stock ----
const stockCache = new Map(); // serviceId -> { at, map }
async function providerStock(service, countries) {
  const hit = stockCache.get(service.id);
  if (hit && Date.now() - hit.at < 30000) return hit.map;
  try {
    const map = await provider.getStock(service.provider_code, countries.map((c) => c.provider_code));
    stockCache.set(service.id, { at: Date.now(), map });
    return map;
  } catch (e) {
    console.error("[stock]", e.message);
    return {};
  }
}

/** Countries a given app can be bought in, with price and stock. */
async function countryOptions(serviceId) {
  const service = db.prepare("SELECT * FROM services WHERE id = ? AND enabled = 1").get(serviceId);
  if (!service) throw new HttpError(404, "That app is not available.");
  const countries = db.prepare("SELECT * FROM countries WHERE enabled = 1 ORDER BY name").all();
  const map = await providerStock(service, countries);
  return countries.map((c) => ({
    id: c.id, name: c.name, iso: c.iso, dial: c.dial,
    price_cents: priceCents(service, c),
    stock: c.stock_override != null ? c.stock_override : Number(map[c.provider_code]) || 0,
  }));
}

// ---- orders ----
const ORDER_SELECT = `SELECT o.id, o.user_id, s.name AS service, c.name AS country, o.phone, o.price_cents, o.status, o.code, o.sms_text,
  o.created_at, o.expires_at, o.finished_at FROM orders o JOIN services s ON s.id = o.service_id JOIN countries c ON c.id = o.country_id`;

function listOrdersForUser(userId) {
  return db.prepare(ORDER_SELECT + " WHERE o.user_id = ? ORDER BY o.id DESC LIMIT 100").all(userId);
}
function getOrder(id) {
  return db.prepare(ORDER_SELECT + " WHERE o.id = ?").get(id);
}

/** Atomically move an order to a closed status and return the money. Returns false if it was already closed. */
function refund(orderId, newStatus, reason, allowed = OPEN) {
  return tx(() => {
    const o = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
    if (!o || !allowed.includes(o.status)) return false;
    const r = db.prepare("UPDATE orders SET status = ?, finished_at = ? WHERE id = ? AND status = ?").run(newStatus, Date.now(), orderId, o.status);
    if (r.changes !== 1) return false;
    db.prepare("UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?").run(o.price_cents, o.user_id);
    ledger(o.user_id, o.price_cents, "refund:" + reason, orderId);
    return true;
  });
}

async function placeOrder(userId, serviceId, countryId) {
  const settings = getSettings();
  if (settings.maintenance) throw new HttpError(503, "Orders are paused for maintenance. Please try again soon.");
  const service = db.prepare("SELECT * FROM services WHERE id = ? AND enabled = 1").get(serviceId);
  const country = db.prepare("SELECT * FROM countries WHERE id = ? AND enabled = 1").get(countryId);
  if (!service || !country) throw new HttpError(404, "That app or country is not available.");

  const options = await countryOptions(service.id);
  const opt = options.find((o) => o.id === country.id);
  if (!opt || opt.stock <= 0) throw new HttpError(409, "Out of stock. Try another country.");
  const price = priceCents(service, country);

  // Take the money first, inside one transaction, so two quick clicks cannot overspend.
  const orderId = tx(() => {
    const u = db.prepare("SELECT balance_cents, disabled FROM users WHERE id = ?").get(userId);
    if (!u || u.disabled) throw new HttpError(403, "This account is disabled.");
    if (u.balance_cents < price) throw new HttpError(402, "Not enough credit. Add credit to continue.");
    db.prepare("UPDATE users SET balance_cents = balance_cents - ? WHERE id = ?").run(price, userId);
    const r = db.prepare("INSERT INTO orders (user_id, service_id, country_id, price_cents, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)").run(userId, service.id, country.id, price, Date.now());
    ledger(userId, -price, "order", r.lastInsertRowid);
    return Number(r.lastInsertRowid);
  });

  try {
    const n = await provider.buyNumber({ serviceCode: service.provider_code, countryCode: country.provider_code });
    const expires = Date.now() + settings.holdMinutes * 60000;
    db.prepare("UPDATE orders SET phone = ?, provider_ref = ?, status = 'waiting', expires_at = ? WHERE id = ?").run(String(n.phone), String(n.ref), expires, orderId);
  } catch (e) {
    console.error("[buyNumber]", e.message);
    refund(orderId, "failed", "provider_error");
    throw new HttpError(502, "No number is available right now. You were not charged.");
  }
  return getOrder(orderId);
}

async function cancelOrder(userId, orderId) {
  const o = db.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?").get(orderId, userId);
  if (!o) throw new HttpError(404, "Order not found.");
  if (o.status !== "waiting") throw new HttpError(409, "This order can no longer be cancelled.");
  try { await provider.cancel(o.provider_ref); } catch (e) {
    console.error("[cancel]", e.message);
    // The provider did not release the number, so we keep the order open instead of refunding money the provider kept.
    const fresh = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
    if (fresh && fresh.status === "received") throw new HttpError(409, "A code just arrived for this order.");
    throw new HttpError(409, "The number provider could not cancel this number yet. Please wait a minute and try again.");
  }
  if (!refund(orderId, "cancelled", "user_cancel", ["waiting"])) throw new HttpError(409, "This order can no longer be cancelled.");
  return getOrder(orderId);
}

async function finishOrder(userId, orderId) {
  const o = db.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?").get(orderId, userId);
  if (!o) throw new HttpError(404, "Order not found.");
  const r = db.prepare("UPDATE orders SET status = 'finished', finished_at = ? WHERE id = ? AND status = 'received'").run(Date.now(), orderId);
  if (r.changes !== 1) throw new HttpError(409, "Only orders with a code can be finished.");
  try { await provider.finish(o.provider_ref); } catch (_) {}
  return getOrder(orderId);
}

// ---- background worker: deliver codes, expire and refund ----
let running = false;
const cancelTried = new Map(); // orderId -> last time we asked the provider to cancel
async function pollOnce() {
  if (running) return;
  running = true;
  try {
    // Orders charged but never handed to the provider (e.g. crash mid-purchase).
    db.prepare("SELECT id FROM orders WHERE status = 'pending' AND created_at < ?").all(Date.now() - 120000)
      .forEach((o) => refund(o.id, "failed", "stuck_pending", ["pending"]));

    const rows = db.prepare("SELECT * FROM orders WHERE status = 'waiting'").all();
    for (const o of rows) {
      try {
        const sms = await provider.checkSms(o.provider_ref);
        if (sms && sms.code) {
          db.prepare("UPDATE orders SET status = 'received', code = ?, sms_text = ? WHERE id = ? AND status = 'waiting'").run(String(sms.code), String(sms.text || ""), o.id);
        } else if (Date.now() >= o.expires_at) {
          // Release the number with the provider first. If the provider refuses, retry every 30s for up to 30 minutes,
          // then refund the customer anyway and log it for you to chase.
          const last = cancelTried.get(o.id) || 0;
          if (Date.now() - last >= 30000) {
            cancelTried.set(o.id, Date.now());
            let released = true;
            try { await provider.cancel(o.provider_ref); } catch (e) { released = false; console.error("[expire-cancel] order", o.id, e.message); }
            if (released || Date.now() >= o.expires_at + 30 * 60000) {
              if (!released) console.error("[expire] order", o.id, "refunded but provider did not cancel; check Proxnum");
              refund(o.id, "expired", "no_sms", ["waiting"]);
              cancelTried.delete(o.id);
            }
          }
        }
      } catch (e) {
        console.error("[poll] order", o.id, e.message);
      }
    }
  } finally {
    running = false;
  }
}
function startWorker() {
  setInterval(() => pollOnce().catch((e) => console.error("[worker]", e)), 3000).unref();
}

module.exports = { priceCents, creditUser, countryOptions, listOrdersForUser, getOrder, placeOrder, cancelOrder, finishOrder, refund, startWorker, pollOnce };

const crypto = require("crypto");
const { promisify } = require("util");
const cfg = require("./config");
const { db } = require("./db");
const { HttpError } = require("./util");

const scrypt = promisify(crypto.scrypt);
const COOKIE = "hl_sid";
const SCRYPT = { N: 16384, r: 8, p: 1 };

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64, SCRYPT);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}
async function verifyPassword(pw, stored) {
  const [type, saltB64, keyB64] = String(stored).split("$");
  if (type !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const actual = await scrypt(pw, Buffer.from(saltB64, "base64"), expected.length, SCRYPT);
  return crypto.timingSafeEqual(expected, actual);
}
// Used so a login for an unknown email takes about as long as a real one.
let dummyHash = null;
async function burnTime(pw) {
  if (!dummyHash) dummyHash = await hashPassword("not-a-real-password");
  await verifyPassword(pw, dummyHash);
}

const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");

function parseCookies(header) {
  const out = {};
  String(header || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const maxAge = cfg.sessionDays * 86400;
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha(token), userId, Date.now() + maxAge * 1000);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: cfg.prod, maxAge: maxAge * 1000, path: "/" });
}
function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha(token));
  res.clearCookie(COOKIE, { path: "/" });
}

/** Adds req.user (or null) to every request. */
function attachUser(req, _res, next) {
  req.user = null;
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) {
    const row = db.prepare(
      `SELECT u.id, u.email, u.role, u.balance_cents, u.disabled
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`
    ).get(sha(token), Date.now());
    if (row && !row.disabled) req.user = row;
  }
  next();
}
const requireAuth = (req, _res, next) => (req.user ? next() : next(new HttpError(401, "Please log in.")));
const requireAdmin = (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, "Please log in."));
  if (req.user.role !== "admin") return next(new HttpError(403, "Admins only."));
  next();
};

/** Blocks cross-site state-changing requests (a second layer on top of SameSite=Lax). */
function sameOrigin(req, _res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) return next(new HttpError(403, "Cross-site request blocked."));
    } catch (_) {
      return next(new HttpError(403, "Bad origin."));
    }
  }
  next();
}

function publicUser(u) {
  return u ? { id: u.id, email: u.email, role: u.role, balance_cents: u.balance_cents } : null;
}

module.exports = { hashPassword, verifyPassword, burnTime, createSession, destroySession, attachUser, requireAuth, requireAdmin, sameOrigin, publicUser };

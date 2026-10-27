/**
 * A tiny web framework (routing, JSON bodies, static files, rate limiting, cookies) built only on Node's
 * standard library, so the project has no third-party packages to install or keep patched.
 * The API deliberately mirrors the small part of Express this project uses.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { HttpError } = require("./util");

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2",
};

function appendHeader(res, name, value) {
  const cur = res.getHeader(name);
  res.setHeader(name, cur ? [].concat(cur, value) : value);
}

function decorate(req, res, trustProxy) {
  const u = new URL(req.url, "http://localhost");
  req.path = u.pathname;
  req.query = Object.fromEntries(u.searchParams);
  req.params = {};
  req.body = {};
  const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  // With one trusted proxy in front, the last entry is the address that proxy saw.
  req.ip = trustProxy && xff.length ? xff[xff.length - 1] : req.socket.remoteAddress || "unknown";

  res.status = (n) => { res.statusCode = n; return res; };
  res.set = (k, v) => { res.setHeader(k, v); return res; };
  res.json = (obj) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(obj));
  };
  res.send = (text) => {
    if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(text);
  };
  res.redirect = (url) => { res.statusCode = 302; res.setHeader("Location", url); res.end(); };
  res.cookie = (name, value, o = {}) => {
    let c = `${name}=${encodeURIComponent(value)}; Path=${o.path || "/"}`;
    if (o.maxAge != null) c += `; Max-Age=${Math.floor(o.maxAge / 1000)}`;
    if (o.httpOnly) c += "; HttpOnly";
    if (o.secure) c += "; Secure";
    const ss = o.sameSite || "lax";
    c += `; SameSite=${ss[0].toUpperCase()}${ss.slice(1)}`;
    appendHeader(res, "Set-Cookie", c);
    return res;
  };
  res.clearCookie = (name, o = {}) => {
    appendHeader(res, "Set-Cookie", `${name}=; Path=${o.path || "/"}; Max-Age=0; HttpOnly; SameSite=Lax`);
    return res;
  };
  res.sendFile = (file) => {
    const body = fs.readFileSync(file);
    res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    res.end(body);
  };
}

class Router {
  constructor() { this.stack = []; }

  use(a, ...rest) {
    const prefix = typeof a === "string" ? a : "";
    const fns = typeof a === "string" ? rest : [a, ...rest];
    fns.forEach((fn) => this.stack.push({ kind: "use", prefix, fn }));
    return this;
  }

  _route(method, p, fns) {
    const keys = [];
    const re = new RegExp("^" + p.replace(/\/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return "/([^/]+)"; }) + "/?$");
    fns.forEach((fn) => this.stack.push({ kind: "route", method, re, keys, fn }));
    return this;
  }
  get(p, ...f) { return this._route("GET", p, f); }
  post(p, ...f) { return this._route("POST", p, f); }
  put(p, ...f) { return this._route("PUT", p, f); }
  patch(p, ...f) { return this._route("PATCH", p, f); }
  delete(p, ...f) { return this._route("DELETE", p, f); }

  handle(req, res, out) {
    let i = 0;
    const origPath = req.path;
    const next = (err) => {
      if (i >= this.stack.length) { req.path = origPath; return out(err); }
      const layer = this.stack[i++];
      if (layer.kind === "route") {
        if (layer.method !== req.method && !(req.method === "HEAD" && layer.method === "GET")) return next(err);
        const m = layer.re.exec(req.path);
        if (!m) return next(err);
        req.params = {};
        try { layer.keys.forEach((k, j) => (req.params[k] = decodeURIComponent(m[j + 1]))); } catch (_) { return next(new HttpError(400, "Bad URL.")); }
      } else if (layer.prefix && !(req.path === layer.prefix || req.path.startsWith(layer.prefix + "/"))) {
        return next(err);
      }
      const isErrorHandler = typeof layer.fn === "function" && layer.fn.length === 4;
      if (err && !isErrorHandler) return next(err);
      if (!err && isErrorHandler) return next();
      try {
        let r;
        if (layer.fn instanceof Router) {
          const saved = req.path;
          if (layer.prefix) req.path = req.path.slice(layer.prefix.length) || "/";
          layer.fn.handle(req, res, (e) => { req.path = saved; next(e); });
        } else if (isErrorHandler) {
          r = layer.fn(err, req, res, next);
        } else {
          r = layer.fn(req, res, next);
        }
        if (r && typeof r.then === "function") r.catch(next);
      } catch (e) {
        next(e);
      }
    };
    next();
  }
}

class App extends Router {
  constructor({ trustProxy = false } = {}) { super(); this.trustProxy = trustProxy; }
  callback() {
    return (req, res) => {
      decorate(req, res, this.trustProxy);
      this.handle(req, res, (err) => {
        if (res.headersSent) return res.end();
        if (err) { console.error(err); return res.status(500).json({ error: "Something went wrong." }); }
        res.status(404).json({ error: "Not found." });
      });
    };
  }
  listen(port, cb) { return http.createServer(this.callback()).listen(port, cb); }
}

// ---- middleware ----
function readBody(req, limit = 20 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, "Request too large.")); req.pause(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function jsonBody(limit = 20 * 1024, skipPath = "") {
  return async (req, _res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method) || req.path === skipPath) return next();
    const raw = await readBody(req, limit);
    if (!raw.length) { req.body = {}; return next(); }
    if (!String(req.headers["content-type"] || "").includes("application/json")) throw new HttpError(415, "Send JSON.");
    try {
      const v = JSON.parse(raw.toString("utf8"));
      req.body = v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch (_) {
      throw new HttpError(400, "Invalid request.");
    }
    next();
  };
}

function serveStatic(dir, { maxAge = 0 } = {}) {
  const root = path.resolve(dir);
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    let rel;
    try { rel = decodeURIComponent(req.path); } catch (_) { return next(); }
    if (rel.includes("\0") || rel.split("/").some((s) => s.startsWith("."))) return next();
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.join(root, rel);
    if (!file.startsWith(root + path.sep)) return next();
    for (const f of [file, file + ".html"]) {
      try {
        const st = fs.statSync(f);
        if (!st.isFile()) continue;
        res.setHeader("Content-Type", MIME[path.extname(f)] || "application/octet-stream");
        res.setHeader("Content-Length", st.size);
        res.setHeader("Cache-Control", maxAge ? `public, max-age=${maxAge}` : "no-cache");
        if (req.method === "HEAD") return res.end();
        return fs.createReadStream(f).pipe(res);
      } catch (_) { /* try the next candidate */ }
    }
    next();
  };
}

function rateLimit({ windowMs, limit, message = "Too many requests." }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    let h = hits.get(req.ip);
    if (!h || h.reset <= now) { h = { count: 0, reset: now + windowMs }; hits.set(req.ip, h); }
    h.count++;
    if (h.count > limit) {
      res.setHeader("Retry-After", Math.ceil((h.reset - now) / 1000));
      return next(new HttpError(429, message));
    }
    next();
  };
}

function securityHeaders({ prod }) {
  const csp = [
    "default-src 'self'", "script-src 'self'", "style-src 'self' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com",
    "img-src 'self' data:", "connect-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
    ...(prod ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
  return (_req, res, next) => {
    res.setHeader("Content-Security-Policy", csp);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (prod) res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    next();
  };
}

module.exports = { Router, App, jsonBody, readBody, serveStatic, rateLimit, securityHeaders };

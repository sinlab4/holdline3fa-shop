class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Express 4 does not catch rejected promises, so wrap async handlers.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function int(v, { min = 0, max = 1e9, label = "value" } = {}) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `Invalid ${label}.`);
  return n;
}

function str(v, { min = 0, max = 200, label = "value" } = {}) {
  if (typeof v !== "string") throw new HttpError(400, `Invalid ${label}.`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw new HttpError(400, `Invalid ${label}.`);
  return s;
}

const bool = (v) => v === true || v === 1 || v === "1" || v === "true";

module.exports = { HttpError, wrap, int, str, bool };

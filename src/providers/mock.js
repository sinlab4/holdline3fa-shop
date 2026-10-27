/**
 * Simulated provider for testing. Produces fictional numbers (US/CA/UK use reserved
 * fictional ranges) and "delivers" a six digit code after a short delay.
 * State is kept in memory, so orders in flight when the server restarts will time out and be refunded.
 */
const crypto = require("crypto");

const num = (name, fallback) => (Number.isFinite(Number(process.env[name])) && process.env[name] !== undefined ? Number(process.env[name]) : fallback);
const rate = () => Math.min(1, Math.max(0, num("MOCK_SUCCESS_RATE", 0.9)));
const dmin = () => Math.max(0, num("MOCK_DELAY_MIN", 4));
const dmax = () => Math.max(dmin(), num("MOCK_DELAY_MAX", 10));

const rnd = (n) => Array.from({ length: n }, () => crypto.randomInt(10)).join("");
const pick = (a) => a[crypto.randomInt(a.length)];
const NATIONAL = {
  us: () => pick(["212", "310", "415", "646", "512"]) + "55501" + rnd(2),
  ca: () => pick(["416", "604", "514"]) + "55501" + rnd(2),
  gb: () => "7700900" + rnd(3),
  ng: () => pick(["801", "803", "805", "810", "903"]) + rnd(7),
  in: () => pick(["9", "8", "7"]) + rnd(9),
  de: () => pick(["1511", "1522", "1573"]) + rnd(7),
  br: () => pick(["11", "21", "31"]) + "9" + rnd(8),
  id: () => "8" + pick(["12", "13", "21", "52"]) + rnd(8),
  ph: () => "9" + rnd(9),
  pl: () => pick(["5", "6", "7"]) + rnd(8),
};
const DIAL = { us: "+1", ca: "+1", gb: "+44", ng: "+234", in: "+91", de: "+49", br: "+55", id: "+62", ph: "+63", pl: "+48" };

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

const orders = new Map();

module.exports = {
  async getStock(serviceCode, countryCodes) {
    const out = {};
    countryCodes.forEach((c) => {
      const h = hash(serviceCode + c);
      out[c] = h % 9 === 0 ? 0 : 18 + (h % 470);
    });
    return out;
  },
  async buyNumber({ serviceCode, countryCode }) {
    const national = (NATIONAL[countryCode] || (() => rnd(9)))();
    const phone = (DIAL[countryCode] || "+0") + national;
    const ref = crypto.randomUUID();
    const delivers = Math.random() < rate();
    orders.set(ref, {
      phone,
      service: serviceCode,
      codeAt: delivers ? Date.now() + Math.round((dmin() + Math.random() * (dmax() - dmin())) * 1000) : null,
      code: rnd(6),
    });
    return { ref, phone };
  },
  async checkSms(ref) {
    const o = orders.get(ref);
    if (!o || !o.codeAt || Date.now() < o.codeAt) return null;
    return { code: o.code, text: `Your ${o.service} verification code is ${o.code}.` };
  },
  async cancel(ref) { orders.delete(ref); },
  async finish(ref) { orders.delete(ref); },
};

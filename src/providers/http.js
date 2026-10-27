/**
 * Real provider: Proxnum Reseller API (https://proxnum.com/reseller-api-docs).
 *
 * Settings (environment variables, never put the key in code):
 *   PROVIDER=http
 *   PROVIDER_API_KEY=<your Proxnum API token>
 *   PROVIDER_BASE_URL=https://proxnum.com      (optional, this is the default)
 *
 * In Admin > Catalog, each app's "provider code" must be Proxnum's service code (for example "wa", "ig")
 * and each country's "provider code" must be Proxnum's country number (for example 6). Proxnum lists both
 * on its Service Codes and Country Codes pages.
 *
 * Proxnum charges your Proxnum balance in US dollars. Your shop prices are in naira, so keep your naira
 * prices comfortably above what Proxnum charges you (see /api/v1/resell/price) plus payment fees.
 */
const BASE = (process.env.PROVIDER_BASE_URL || "https://proxnum.com").replace(/\/$/, "");
const KEY = process.env.PROVIDER_API_KEY || "";

async function call(path, { method = "GET", body, query } = {}) {
  if (!KEY) throw new Error("PROVIDER_API_KEY is not set.");
  const qs = query ? "?" + new URLSearchParams(query).toString() : "";
  const res = await fetch(BASE + "/api/v1" + path + qs, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json: json || {} };
}
const fail = (r, what) => new Error(`Proxnum ${what} failed (HTTP ${r.status}${r.json.code ? ", " + r.json.code : ""}${r.json.message ? ": " + r.json.message : ""})`);
const asCountry = (c) => (/^\d+$/.test(String(c)) ? Number(c) : String(c));

module.exports = {
  /** { [countryCode]: available count }. When Proxnum does not say (null), report 1 so the buy attempt decides. */
  async getStock(serviceCode, countryCodes) {
    const out = {};
    countryCodes.forEach((c) => (out[c] = 0));
    let r;
    try { r = await call("/prices", { query: { service: serviceCode } }); } catch (e) { console.error("[getStock]", e.message); return out; }
    if (r.status !== 200) { console.error("[getStock]", fail(r, "prices").message); return out; }
    const root = r.json.prices || r.json.data || r.json;
    countryCodes.forEach((c) => {
      const byService = root && (root[String(c)] || root[asCountry(c)]);
      const entry = byService && (byService[serviceCode] || byService);
      if (!entry || typeof entry !== "object") return;
      const a = entry.available;
      out[c] = a === null || a === undefined ? 1 : Math.max(0, Number(a) || 0);
    });
    return out;
  },
  /** Buys a number and charges your Proxnum balance. Returns { ref: activation_id, phone: "+..." }. */
  async buyNumber({ serviceCode, countryCode }) {
    const r = await call("/resell/virtual/buy", { method: "POST", body: { service: serviceCode, country: asCountry(countryCode) } });
    const a = r.json.activation;
    if (r.status >= 300 || r.json.success !== true || !a || !a.activation_id || !a.phone) throw fail(r, "buy");
    const digits = String(a.phone).replace(/\D/g, "");
    return { ref: String(a.activation_id), phone: "+" + digits };
  },
  /** { code, text } once the SMS arrives, otherwise null. */
  async checkSms(ref) {
    const r = await call(`/resell/virtual/${encodeURIComponent(ref)}/status`);
    if (r.status >= 500 || r.status === 429) throw fail(r, "status");
    const j = r.json;
    // Real replies look like {"success":true,"status":"ok","code":"74963","activation":{"code":"74963","status":"completed"}}
    const raw = j.code != null && j.code !== "" ? j.code : j.activation && j.activation.code;
    if (j.success !== false && raw != null && String(raw).trim() !== "") {
      const code = String(raw).trim();
      return { code, text: String(j.text || j.sms || `Your verification code is ${code}.`) };
    }
    return null;
  },
  /** Ask Proxnum to cancel and refund. Throws if Proxnum did NOT accept, so the shop does not refund money Proxnum kept. */
  async cancel(ref) {
    const r = await call("/resell/virtual/cancel", { method: "POST", body: { activation_id: String(ref) } });
    if (r.status >= 300 || r.json.success !== true) throw fail(r, "cancel");
  },
  /** Proxnum documents no "finish" call, so there is nothing to do. */
  async finish() {},
};

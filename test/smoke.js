// End-to-end smoke test: starts the server on a temp database and walks the main flows.
const { spawn, spawnSync } = require("child_process");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hl-"));
const port = 4100 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const env = {
  ...process.env, PORT: String(port), DATABASE_PATH: path.join(dir, "t.db"), PROVIDER: "mock", ALLOW_DEMO_TOPUP: "1",
  MOCK_SUCCESS_RATE: "1", MOCK_DELAY_MIN: "1", MOCK_DELAY_MAX: "2", NODE_ENV: "test", STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "",
};

class Client {
  constructor() { this.cookie = ""; }
  async req(method, url, body, extra = {}) {
    const res = await fetch(base + url, {
      method, redirect: "manual",
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}), ...extra },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get("set-cookie");
    if (sc) this.cookie = sc.split(";")[0];
    let json = null;
    try { json = await res.json(); } catch (_) {}
    return { status: res.status, json, headers: res.headers };
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (name) => { passed++; console.log("  ok  " + name); };

(async () => {
  const admin = spawnSync(process.execPath, ["scripts/create-admin.js", "boss@example.com", "correct horse battery"], { env, encoding: "utf8" });
  assert.strictEqual(admin.status, 0, admin.stderr);

  const server = spawn(process.execPath, ["src/server.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(base + "/api/catalog"); break; } catch (_) { await sleep(100); } }

    const anon = new Client();
    let r = await anon.req("GET", "/api/catalog");
    assert.strictEqual(r.status, 200); assert.ok(r.json.services.length >= 10); ok("catalog loads");

    r = await anon.req("POST", "/api/orders", { serviceId: 1, countryId: 1 });
    assert.strictEqual(r.status, 401); ok("anonymous cannot order");

    const u = new Client();
    r = await u.req("POST", "/api/auth/register", { email: "Buyer@Example.com", password: "short", acceptTerms: true });
    assert.strictEqual(r.status, 400); ok("short password rejected");
    r = await u.req("POST", "/api/auth/register", { email: "buyer@example.com", password: "a-long-enough-password", acceptTerms: false });
    assert.strictEqual(r.status, 400); ok("terms required");
    r = await u.req("POST", "/api/auth/register", { email: "buyer@example.com", password: "a-long-enough-password", acceptTerms: true });
    assert.strictEqual(r.status, 201); assert.strictEqual(r.json.user.balance_cents, 0); assert.strictEqual(r.json.user.role, "user"); ok("register");
    r = await new Client().req("POST", "/api/auth/register", { email: "buyer@example.com", password: "a-long-enough-password", acceptTerms: true });
    assert.strictEqual(r.status, 409); ok("duplicate email rejected");

    r = await u.req("POST", "/api/orders", { serviceId: 1, countryId: 1 });
    assert.strictEqual(r.status, 402); ok("order without credit refused");

    r = await u.req("POST", "/api/wallet/topup", { amountCents: 10000 });
    assert.strictEqual(r.status, 400); ok("tiny top-up refused");
    r = await u.req("POST", "/api/wallet/topup", { amountCents: 1000000 });
    assert.strictEqual(r.status, 200);
    r = await u.req("GET", "/api/me");
    assert.strictEqual(r.json.user.balance_cents, 1000000); ok("demo top-up credits balance");

    // find a country in stock for WhatsApp (service 1)
    r = await u.req("GET", "/api/catalog/1/countries");
    const country = r.json.countries.find((c) => c.stock > 0);
    assert.ok(country); const price = country.price_cents;

    r = await u.req("POST", "/api/orders", { serviceId: 1, countryId: country.id });
    assert.strictEqual(r.status, 201); assert.strictEqual(r.json.order.status, "waiting"); assert.ok(r.json.order.phone.startsWith("+"));
    const id1 = r.json.order.id;
    r = await u.req("GET", "/api/me");
    assert.strictEqual(r.json.user.balance_cents, 1000000 - price); ok("order charges the price and returns a number");

    let order;
    for (let i = 0; i < 40; i++) {
      r = await u.req("GET", "/api/orders");
      order = r.json.orders.find((o) => o.id === id1);
      if (order.status === "received") break;
      await sleep(500);
    }
    assert.strictEqual(order.status, "received"); assert.match(order.code, /^\d{6}$/); ok("code arrives via worker");

    r = await u.req("POST", `/api/orders/${id1}/cancel`);
    assert.strictEqual(r.status, 409); ok("cannot cancel after code arrived");
    r = await u.req("POST", `/api/orders/${id1}/finish`);
    assert.strictEqual(r.status, 200); assert.strictEqual(r.json.order.status, "finished"); ok("finish order");

    // cancel path refunds
    r = await u.req("POST", "/api/orders", { serviceId: 1, countryId: country.id });
    const id2 = r.json.order.id;
    r = await u.req("POST", `/api/orders/${id2}/cancel`);
    assert.strictEqual(r.status, 200); assert.strictEqual(r.json.order.status, "cancelled");
    r = await u.req("GET", "/api/me");
    assert.strictEqual(r.json.user.balance_cents, 1000000 - price); ok("cancel refunds in full");

    // other users cannot touch my orders
    const other = new Client();
    await other.req("POST", "/api/auth/register", { email: "other@example.com", password: "another-long-password", acceptTerms: true });
    r = await other.req("POST", `/api/orders/${id1}/cancel`);
    assert.strictEqual(r.status, 404); ok("orders are private to their owner");
    r = await other.req("GET", "/api/admin/overview");
    assert.strictEqual(r.status, 403); ok("non-admin blocked from admin API");
    r = await other.req("GET", "/admin");
    assert.strictEqual(r.status, 302); ok("non-admin redirected from /admin");
    r = await u.req("POST", "/api/orders", { serviceId: 1, countryId: country.id }, { Origin: "https://evil.example" });
    assert.strictEqual(r.status, 403); ok("cross-site POST blocked");

    // admin
    const a = new Client();
    r = await a.req("POST", "/api/auth/login", { email: "boss@example.com", password: "wrong password here" });
    assert.strictEqual(r.status, 401);
    r = await a.req("POST", "/api/auth/login", { email: "boss@example.com", password: "correct horse battery" });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.json.user.role, "admin"); ok("admin login");
    r = await a.req("GET", "/admin");
    assert.strictEqual(r.status, 200); ok("/admin served to admin");
    r = await a.req("GET", "/api/admin/overview");
    assert.strictEqual(r.status, 200); assert.ok(r.json.orders >= 2); assert.strictEqual(r.json.delivered, 1); ok("admin overview");
    r = await a.req("GET", "/api/admin/users");
    const buyer = r.json.users.find((x) => x.email === "buyer@example.com");
    assert.ok(buyer); ok("admin lists users");
    r = await a.req("POST", `/api/admin/users/${buyer.id}/credit`, { amountCents: 50000, note: "test" });
    assert.strictEqual(r.status, 200);
    r = await u.req("GET", "/api/me");
    assert.strictEqual(r.json.user.balance_cents, 1000000 - price + 50000); ok("admin credit");

    // admin refund of a delivered order
    r = await a.req("POST", `/api/admin/orders/${id1}/refund`);
    assert.strictEqual(r.status, 409); ok("finished order cannot be refunded twice");
    r = await u.req("POST", "/api/orders", { serviceId: 1, countryId: country.id });
    const id3 = r.json.order.id;
    for (let i = 0; i < 40; i++) { r = await u.req("GET", "/api/orders"); if (r.json.orders.find((o) => o.id === id3).status === "received") break; await sleep(500); }
    const before = (await u.req("GET", "/api/me")).json.user.balance_cents;
    r = await a.req("POST", `/api/admin/orders/${id3}/refund`);
    assert.strictEqual(r.status, 200);
    const after = (await u.req("GET", "/api/me")).json.user.balance_cents;
    assert.strictEqual(after, before + price); ok("admin refund returns money");

    // catalog edits show up in the shop
    r = await a.req("PATCH", "/api/admin/services/1", { base_cents: 99900 });
    assert.strictEqual(r.status, 200);
    r = await u.req("GET", "/api/catalog/1/countries");
    assert.ok(r.json.countries.find((c) => c.id === country.id).price_cents >= 99900 * 0.7); ok("price edit reaches the shop");
    r = await a.req("PATCH", "/api/admin/services/1", { enabled: false });
    r = await u.req("GET", "/api/catalog/1/countries");
    assert.strictEqual(r.status, 404); ok("disabled app disappears");
    r = await a.req("PATCH", "/api/admin/services/1", { enabled: true, base_cents: 56600 });
    r = await a.req("DELETE", "/api/admin/services/1");
    assert.strictEqual(r.status, 409); ok("app with orders cannot be deleted");

    // maintenance
    r = await a.req("PUT", "/api/admin/settings", { maintenance: true, banner: "Back soon" });
    assert.strictEqual(r.status, 200);
    r = await u.req("POST", "/api/orders", { serviceId: 1, countryId: country.id });
    assert.strictEqual(r.status, 503); ok("maintenance mode pauses orders");
    r = await anon.req("GET", "/api/catalog");
    assert.strictEqual(r.json.banner, "Back soon"); ok("banner is public");
    await a.req("PUT", "/api/admin/settings", { maintenance: false });

    // disabled user is locked out
    r = await a.req("POST", `/api/admin/users/${buyer.id}/disable`, { disabled: true });
    assert.strictEqual(r.status, 200);
    r = await u.req("GET", "/api/me");
    assert.strictEqual(r.json.user, null); ok("disabled user is signed out");

    r = await u.req("POST", "/api/auth/logout");
    console.log(`\n${passed} checks passed`);
  } catch (e) {
    console.error("\nFAILED:", e.message);
    console.error("--- server log ---\n" + log);
    process.exitCode = 1;
  } finally {
    server.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

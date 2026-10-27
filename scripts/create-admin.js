// Usage: npm run create-admin -- you@example.com 'a long password'
// Creates the account, or promotes it to admin (and resets its password) if it already exists.
const { db } = require("../src/db");
const { hashPassword } = require("../src/auth");

(async () => {
  const email = String(process.argv[2] || process.env.HL_EMAIL || "").trim().toLowerCase();
  const password = String(process.argv[3] || process.env.HL_PASSWORD || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || password.length < 10) {
    console.error("Usage: npm run create-admin -- <email> <password of at least 10 characters>");
    process.exit(1);
  }
  const hash = await hashPassword(password);
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) {
    db.prepare("UPDATE users SET role = 'admin', pass_hash = ?, disabled = 0 WHERE id = ?").run(hash, existing.id);
    console.log(`Updated ${email}: now an admin with the new password.`);
  } else {
    db.prepare("INSERT INTO users (email, pass_hash, role, created_at) VALUES (?, ?, 'admin', ?)").run(email, hash, Date.now());
    console.log(`Created admin ${email}.`);
  }
})();

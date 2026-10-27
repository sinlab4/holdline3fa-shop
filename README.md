# Holdline3FA

A storefront where customers create an account, add credit, rent a temporary phone number for an app, and receive the verification code on the page. It has an admin panel at `/admin` for prices, countries, orders, customers and settings.

No packages to install. It needs only **Node 22.13 or newer** and runs from a single folder.

## What works today and what you still need to supply

| Part | Status |
|---|---|
| Accounts, login, sessions, wallet, orders, refunds, admin panel | Built and tested |
| Card payments | Built for Stripe Checkout. Needs your Stripe keys. |
| Real phone numbers | **You must connect a provider.** Until then the site uses simulated numbers (`PROVIDER=mock`). |

The simulated mode is for testing only. Do not take real money while `PROVIDER=mock`, because customers would pay for numbers that do not exist.

## Prices are in Naira

All prices and balances are in naira (₦), stored internally in kobo. The starter price list was converted at ₦1,346 per US dollar and rounded up to the next ₦10 (set `USD_RATE` before the first start to change that). After that, edit prices in **Admin > Catalog**. Top-ups are ₦1,000 to ₦500,000. Stripe may not accept NGN for every business, so check before you rely on it. Paystack or Flutterwave are common choices for Nigeria.

## Run it on your computer

**Windows, easiest way:** unzip the folder (right-click, Extract All), then double-click `start-windows.bat`. It asks for an email and password for your admin login, starts the site, and opens your browser. If Windows shows a blue "protected your PC" box, click More info, then Run anyway.

**Or from a terminal:**

```bash
cp .env.example .env          # optional, defaults work for testing
npm run create-admin -- you@example.com 'a long password here'
ALLOW_DEMO_TOPUP=1 npm start  # free test credit, simulated numbers
```

Open http://localhost:3000. Log in with the admin account and open http://localhost:3000/admin.

Run the self-test with `npm test` (31 checks).

## Put it online at holdline3fa.com

1. **Register the domain** (Namecheap, Cloudflare, Google Domains and so on).
2. **Pick a host that can run Node and keep a disk.** The database is a file, so the host needs a persistent disk or volume. Simple options: Railway, Render, Fly.io, or any VPS (DigitalOcean, Hetzner). Use the included `Dockerfile` if the host supports Docker, or run `node src/server.js` directly.
3. **Set environment variables** in the host's dashboard (see `.env.example`). At minimum: `NODE_ENV=production`, `PUBLIC_URL=https://holdline3fa.com`, `TRUST_PROXY=1`, and `DATABASE_PATH` pointing at the persistent disk. Leave `ALLOW_DEMO_TOPUP` unset.
4. **Create your admin login** once on the server: `npm run create-admin -- you@example.com 'a long password'`.
5. **Point the domain at the host** using the DNS instructions the host gives you. HTTPS certificates are issued by the host automatically.
6. **Back up** the database file (`DATABASE_PATH`) regularly.

## Connect card payments (Stripe)

1. Create a Stripe account and copy the **secret key** into `STRIPE_SECRET_KEY`.
2. In Stripe, add a webhook endpoint `https://holdline3fa.com/api/stripe/webhook` for the events `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Copy its **signing secret** into `STRIPE_WEBHOOK_SECRET`.
3. Restart. The "Add credit" button now sends customers to Stripe, and their balance is credited when Stripe confirms payment. A repeated webhook can never credit twice.

Stripe reviews each business. Read their rules on what they allow before you apply.

## Connect a real number provider (Proxnum)

`src/providers/http.js` is already written for the Proxnum Reseller API (https://proxnum.com/reseller-api-docs).

1. Make a Proxnum account, create an API key on its Profile page, and put some money on the Proxnum balance. Ask Proxnum support to confirm in writing that you may resell.
2. Set three settings where the site runs (never inside the code, never in a chat): `PROVIDER=http`, `PROVIDER_API_KEY=<your key>`. `PROVIDER_BASE_URL` is optional.
3. In **Admin > Catalog**, set each app's *provider code* to Proxnum's service code (for example `wa`, `ig`) and each country's *provider code* to Proxnum's country number (for example `6`). Proxnum lists both on its Service Codes and Country Codes pages.
4. Proxnum bills you in US dollars. Keep your naira prices well above its price (see its `/api/v1/resell/price`) plus payment fees.

Test on your own computer first (PowerShell):

```
$env:PROVIDER="http"; $env:PROVIDER_API_KEY="paste-key-here"; $env:ALLOW_DEMO_TOPUP="1"; node src\server.js
```

Buy one cheap number for yourself and confirm the code arrives, then turn demo top-ups off before going public. If a buy fails, the customer is not charged.

## How money is handled

Balances are stored in whole cents. Buying an order takes the money first inside one database transaction, so two quick clicks cannot overspend. If the provider fails, the order times out with no SMS, or the customer or an admin cancels, the same transaction marks the order closed and returns the price once. Every change is recorded in the `ledger` table.

## Security notes

- Passwords are hashed with scrypt. Sessions use random tokens stored hashed, in `HttpOnly` `SameSite=Lax` cookies (`Secure` in production).
- Requests from other sites are rejected, login and ordering are rate limited, and a strict Content-Security-Policy is sent with every page.
- `/admin` and `/api/admin/*` are available to accounts with the admin role only. Every admin action is written to the server log.
- Choose a long admin password. Consider adding two-factor login at your host or proxy.

## Running it responsibly

Services that sell temporary numbers are widely used for fake accounts and fraud, and platforms block many of these numbers. You are responsible for following the law where you operate and the rules of your provider and payment processor. Keep a way to contact you, respond to abuse reports, and use **Admin > Customers** to disable accounts that break the rules. The shop page already tells customers what is not allowed. Consider adding terms of service and a privacy policy before launch.

## Project layout

```
src/server.js         web server and routes wiring
src/mini.js           small built-in router (no dependencies)
src/routes-api.js     customer API (accounts, catalog, orders, wallet)
src/routes-admin.js   admin API
src/orders.js         ordering, refunds, background worker
src/payments.js       Stripe top-ups and webhook
src/providers/        mock.js (testing) and http.js (your real provider)
public/               shop page and shared files
views/admin.html      admin page (served only to admins)
test/smoke.js         end-to-end self test
```

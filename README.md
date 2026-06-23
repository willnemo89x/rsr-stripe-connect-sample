# Red Seal Rescue — Stripe Connect sample

A minimal, end-to-end **Stripe Connect** integration:

1. **Onboard coaches** as connected accounts (v2 Accounts API, `recipient` config, platform collects fees)
2. **Onboard** them via Stripe-hosted **Account Links**
3. Read **live onboarding status** straight from the API (never cached)
4. Receive **requirement / capability change** webhooks (v2 **thin** events)
5. **Create products** (coaching packages) at the platform level
6. **Storefront** that lists products + coaches
7. **Sell** with a **destination charge + application fee** via hosted **Checkout**

> Why a server? A Stripe **secret key must never live in client-side code**, and
> Connect needs server-side calls + a webhook endpoint. Your main coaching app
> (static, on GitHub Pages) can't do that — so this is a small standalone Node
> server. It's intentionally separate from the Pages repo so secrets are never
> deployed.

---

## 1. Install

```bash
cd RedSealRescue/stripe-connect-sample
npm install
```

## 2. Configure

```bash
cp .env.example .env
```

Open `.env` and paste your **test-mode** secret key from
https://dashboard.stripe.com/test/apikeys (looks like `sk_test_…`).
The server **won't start** until `STRIPE_SECRET_KEY` is a real value — it prints
a clear message telling you what to fix.

`STRIPE_WEBHOOK_SECRET` is only needed for the webhook step (below); you can do
onboarding / products / checkout without it first.

## 3. Run

```bash
npm run dev        # auto-restarts on file changes (Node --watch)
# or: npm start
```

Open **http://localhost:4242** and follow Home → Onboard → Products → Storefront.

### Test cards
In Checkout, use `4242 4242 4242 4242`, any future expiry, any CVC, any postal code.

---

## 4. Webhooks — listen for requirement / capability changes

Account requirements can change (regulators, card networks, etc.). We listen for
**v2 thin events** and react.

### Option A — local testing with the Stripe CLI (recommended)

Install the CLI: https://docs.stripe.com/stripe-cli — then:

```bash
stripe listen \
  --thin-events 'v2.core.account[requirements].updated,v2.core.account[.recipient].capability_status_updated' \
  --forward-thin-to localhost:4242/webhooks/stripe
```

The CLI prints a signing secret like `whsec_…`. Paste it into `.env` as
`STRIPE_WEBHOOK_SECRET` and restart the server. Trigger onboarding changes and
watch the server log the handled events.

### Option B — a deployed endpoint (Dashboard)

1. Stripe Dashboard → **Developers → Webhooks → + Add destination**.
2. **Events from:** *Connected accounts*.
3. **Show advanced options → Payload style: Thin.**
4. In **Events**, search `v2` and select:
   - `v2.core.account[requirements].updated`
   - `v2.core.account[configuration.recipient].capability_status_updated`
5. Point it at `https://YOUR-DEPLOYED-HOST/webhooks/stripe` and copy its signing
   secret into `STRIPE_WEBHOOK_SECRET`.

The handler (`server.js` → Section 4) verifies the signature with
`stripeClient.parseEventNotification(...)` (the stripe-node v22 name; older docs
call it `parseThinEvent`), then uses the notification's `fetchRelatedObject()` to
load the related account and re-read its requirements/capabilities.

---

## How the money flows (destination charge)

When a customer buys, we create a Checkout session with:

```
payment_intent_data.application_fee_amount  →  platform keeps this (PLATFORM_FEE_PERCENT)
payment_intent_data.transfer_data.destination → the coach's connected account
```

The charge is created on the **platform**; Stripe transfers the remainder to the
coach. Adjust the fee with `PLATFORM_FEE_PERCENT` in `.env`.

---

## Files

| File | Purpose |
|------|---------|
| `config.js` | Loads/validates env, creates the single **Stripe Client**, helpful errors |
| `store.js` | Demo-only JSON file mapping coach → connected account id (**use a real DB in prod**) |
| `server.js` | All endpoints + the webhook handler (sections are labelled) |
| `public/*.html` | The four UI pages (onboard, products, storefront, success) |
| `.env.example` | Copy to `.env` and fill in |

## Deploy the payments server (so "Collect payment" works for real)

The coaching app is static, but this server isn't — host it on any Node platform,
then paste its URL into the app's **Collect payment** dialog.

### Prerequisite: put this folder in a Git repo

One-click deploy reads from a Git repo. Push just this `stripe-connect-sample`
folder to its own **public** repo, e.g.:

```bash
cd RedSealRescue/stripe-connect-sample
git init -b main
git add -A && git commit -m "Stripe Connect sample"
gh repo create rsr-stripe-connect-sample --public --source=. --push   # needs gh auth
```

### Option A — Render (one-click Blueprint)  ← recommended

This folder ships a `render.yaml`. After pushing the repo:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/willnemo89x/rsr-stripe-connect-sample)

> (Or go to the Render dashboard → **New → Blueprint** and pick the repo.)

Then, in Render:

1. When prompted, set the env vars: **`STRIPE_SECRET_KEY`** (your `sk_live_…` or
   `sk_test_…`) and, once you've created a webhook, **`STRIPE_WEBHOOK_SECRET`**.
2. First deploy finishes → copy the service URL
   (e.g. `https://rsr-stripe-connect.onrender.com`).
3. Set **`ROOT_URL`** to that URL and **redeploy** (so onboarding return links and
   Checkout fallback URLs are correct).
4. Add a webhook destination in Stripe (see **Listen for events** above) pointing
   at `https://YOUR-SERVICE.onrender.com/webhooks/stripe`, copy its signing secret
   into `STRIPE_WEBHOOK_SECRET`, redeploy.

Render's free tier sleeps when idle, so the first request after a pause is slow —
fine for a demo; use a paid plan for production.

### Option B — Railway / Fly.io / a VPS

Any Node host works. Set the same env vars (`STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `ROOT_URL`, optional `PLATFORM_FEE_PERCENT`) and run
`npm install` / `npm start`. The platform's injected `PORT` is honored
automatically.

### After deploying: connect it to the coaching app

1. Open the coaching app → any client → **Collect payment**.
2. In the dialog's **Payments server URL** field, paste your deployed URL
   (e.g. `https://rsr-stripe-connect.onrender.com`) — it's remembered per browser.
3. **Lock down CORS:** in `server.js`, change the CORS `Access-Control-Allow-Origin`
   from `'*'` to your app's exact origin (`https://willnemo89x.github.io`) and redeploy.

## Notes & production checklist

- **SDK:** `stripe` v22+ (pinned in `package.json`). The API version
  (`2026-05-27.dahlia`) is applied **automatically by the SDK** — we don't pin it.
- Replace the JSON-file store with your real database.
- Don't trust prices/destinations from the client — this sample re-fetches the
  product server-side before charging (it does this already).
- Keep secret keys server-side only. Never commit `.env` (it's gitignored).
- To deploy: any Node host works (Render, Railway, Fly.io, a VPS). Set the env
  vars there and point `ROOT_URL` at the public URL.

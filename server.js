// ============================================================================
// server.js — Red Seal Rescue · Stripe Connect sample
// ----------------------------------------------------------------------------
// Flows implemented (each is a labelled section below):
//   1. Create connected accounts            (v2 Accounts API)
//   2. Onboard them via Account Links        (v2 Account Links API)
//   3. Read live onboarding status           (v2 Accounts retrieve)
//   4. Receive requirement/capability events (thin webhooks)
//   5. Create products at the platform level (Products API)
//   6. List products for a storefront
//   7. Sell with a destination charge + app fee (Checkout, hosted)
//
// Domain framing: a "connected account" = a Red Seal Rescue COACH who gets
// paid. A "product" = a coaching package. A customer = a tradesperson buying
// a package. The platform (you) takes an application fee on each sale.
// ============================================================================

const express = require('express');
const path = require('path');

// The ONE Stripe Client + config, created in config.js. We import and reuse it
// for every Stripe request below (never `new Stripe(...)` again).
const {
  stripeClient,
  getWebhookSecret,
  ROOT_URL,
  PORT,
  PLATFORM_FEE_PERCENT,
} = require('./config');

const { saveAccount, listAccounts } = require('./store');

const app = express();

// ----------------------------------------------------------------------------
// ⚠️ WEBHOOK ROUTE MUST COME FIRST, with a RAW body parser.
// Signature verification needs the exact bytes Stripe sent. If express.json()
// runs first it rewrites the body and verification fails. So we mount this one
// route with express.raw() BEFORE the global express.json() below.
// (Full handler is defined in Section 4; we only register the parser here.)
// ----------------------------------------------------------------------------
app.post(
  '/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  handleStripeWebhook // defined further down
);

// For every OTHER route, parse JSON bodies normally, and serve the static UI.
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------------------------------------------------
// CORS — let the (separately hosted) Red Seal Rescue coaching app call this API
// from a different origin, e.g. its "Collect payment" button.
// DEMO: allows all origins. In production, replace '*' with your app's exact
// origin (e.g. 'https://willnemo89x.github.io').
// ----------------------------------------------------------------------------
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204); // preflight
  next();
});

// Small helper so route errors return clean JSON instead of an HTML stack trace.
function wrap(handler) {
  return (req, res) => handler(req, res).catch((err) => {
    console.error(`✗ ${req.method} ${req.path} —`, err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  });
}

// ============================================================================
// SECTION 1 — Create a connected account (v2 Core Accounts API)
// ----------------------------------------------------------------------------
// Platform-controlled pricing + fees model: we set the platform as the
// fees/losses collector, request the `recipient` configuration so the account
// can receive transfers (destination charges), and use the Express dashboard.
//
// We pass ONLY the documented properties below. We never pass a top-level
// `type` (no 'express' / 'standard' / 'custom') — that's the v1 model.
// ============================================================================
app.post('/api/accounts', wrap(async (req, res) => {
  const { displayName, contactEmail } = req.body;
  if (!displayName || !contactEmail) {
    return res.status(400).json({ error: 'displayName and contactEmail are required.' });
  }

  const account = await stripeClient.v2.core.accounts.create({
    display_name: displayName,    // ← from the user (coach's business name)
    contact_email: contactEmail,  // ← from the user
    identity: {
      country: 'us',
    },
    dashboard: 'express',
    defaults: {
      responsibilities: {
        fees_collector: 'application',   // platform collects fees
        losses_collector: 'application', // platform owns losses
      },
    },
    configuration: {
      recipient: {
        capabilities: {
          stripe_balance: {
            stripe_transfers: {
              requested: true, // needed to receive destination-charge transfers
            },
          },
        },
      },
    },
  });

  // Persist the user → account mapping. In production this belongs on your
  // user/coach row in your real DB; here it's a JSON file (see store.js).
  saveAccount({ accountId: account.id, displayName, contactEmail });

  res.json({ accountId: account.id });
}));

// ============================================================================
// SECTION 3 — Read LIVE onboarding status (always from the API, never cached)
// ----------------------------------------------------------------------------
// `include` pulls the recipient configuration + requirements so we can tell:
//   • readyToReceivePayments — can this coach actually receive money yet?
//   • onboardingComplete     — are there outstanding required fields?
// (Defined before Section 2 because the onboarding UI calls it on load.)
// ============================================================================
async function getAccountStatus(accountId) {
  const account = await stripeClient.v2.core.accounts.retrieve(accountId, {
    include: ['configuration.recipient', 'requirements'],
  });

  const readyToReceivePayments =
    account?.configuration?.recipient?.capabilities?.stripe_balance
      ?.stripe_transfers?.status === 'active';

  // If anything is currently_due or past_due, onboarding isn't finished.
  const requirementsStatus = account.requirements?.summary?.minimum_deadline?.status;
  const onboardingComplete =
    requirementsStatus !== 'currently_due' && requirementsStatus !== 'past_due';

  return {
    accountId: account.id,
    displayName: account.display_name,
    readyToReceivePayments,
    onboardingComplete,
    requirementsStatus: requirementsStatus || 'none',
  };
}

app.get('/api/accounts/:id/status', wrap(async (req, res) => {
  res.json(await getAccountStatus(req.params.id));
}));

// List all known connected accounts WITH their live status (onboarding UI +
// storefront both use this). Status is fetched per-account from the API.
app.get('/api/accounts', wrap(async (req, res) => {
  const stored = listAccounts();
  const withStatus = await Promise.all(
    stored.map(async (a) => {
      try {
        return { ...a, ...(await getAccountStatus(a.accountId)) };
      } catch (e) {
        // Account might have been deleted in the dashboard — don't crash the list.
        return { ...a, error: e.message };
      }
    })
  );
  res.json(withStatus);
}));

// ============================================================================
// SECTION 2 — Onboard a connected account (v2 Account Links API)
// ----------------------------------------------------------------------------
// Returns a one-time hosted onboarding URL. The user clicks it, completes
// Stripe's hosted flow, and is sent back to return_url. refresh_url is used by
// Stripe if the link expires before they finish.
// ============================================================================
app.post('/api/accounts/:id/onboarding-link', wrap(async (req, res) => {
  const accountId = req.params.id;

  const accountLink = await stripeClient.v2.core.accountLinks.create({
    account: accountId,
    use_case: {
      type: 'account_onboarding',
      account_onboarding: {
        configurations: ['recipient'],
        // Where Stripe sends the user if the link expires / they need a new one:
        refresh_url: `${ROOT_URL}/onboard.html?accountId=${accountId}`,
        // Where Stripe returns the user after finishing (we re-check status there):
        return_url: `${ROOT_URL}/onboard.html?accountId=${accountId}`,
      },
    },
  });

  res.json({ url: accountLink.url });
}));

// ============================================================================
// SECTION 5 — Create a PRODUCT at the platform level (Products API)
// ----------------------------------------------------------------------------
// Products live on the PLATFORM account, not on the connected account. We map
// each product to its selling coach by stashing the connected account id in
// product metadata (no separate DB needed for products).
// ============================================================================
app.post('/api/products', wrap(async (req, res) => {
  const { name, description, priceInCents, currency, accountId } = req.body;
  if (!name || !priceInCents || !accountId) {
    return res.status(400).json({ error: 'name, priceInCents, and accountId are required.' });
  }

  const product = await stripeClient.products.create({
    name,
    description: description || undefined,
    default_price_data: {
      unit_amount: Math.round(Number(priceInCents)), // integer, smallest currency unit
      currency: (currency || 'usd').toLowerCase(),
    },
    // The product → connected account mapping (which coach gets paid):
    metadata: {
      connected_account_id: accountId,
    },
  });

  res.json({ productId: product.id });
}));

// ============================================================================
// SECTION 6 — List products for the storefront
// ----------------------------------------------------------------------------
// Expand default_price so we have the amount/currency to display and to compute
// the platform fee at checkout time.
// ============================================================================
app.get('/api/products', wrap(async (req, res) => {
  const products = await stripeClient.products.list({
    limit: 100,
    active: true,
    expand: ['data.default_price'],
  });

  const list = products.data
    .filter((p) => p.default_price) // skip any product without a price
    .map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      amount: p.default_price.unit_amount,
      currency: p.default_price.currency,
      priceId: p.default_price.id,
      connectedAccountId: p.metadata?.connected_account_id || null,
    }));

  res.json(list);
}));

// ============================================================================
// SECTION 7 — Sell with a DESTINATION CHARGE + application fee (hosted Checkout)
// ----------------------------------------------------------------------------
// The charge is created on the PLATFORM, an application fee is kept by the
// platform, and the remainder is transferred to the coach's connected account
// (transfer_data.destination). We use hosted Checkout for simplicity.
// ============================================================================
app.post('/api/checkout', wrap(async (req, res) => {
  // successUrl / cancelUrl are OPTIONAL — the coaching app passes its own URLs so
  // the buyer returns to the app after paying. We only accept http(s) URLs.
  const { productId, successUrl, cancelUrl } = req.body;
  if (!productId) return res.status(400).json({ error: 'productId is required.' });
  const safe = (u) => (typeof u === 'string' && /^https?:\/\//.test(u)) ? u : null;

  // Re-fetch the product (with its price) so amounts/destination are trustworthy
  // and not taken from the client.
  const product = await stripeClient.products.retrieve(productId, {
    expand: ['default_price'],
  });

  const connectedAccountId = product.metadata?.connected_account_id;
  if (!connectedAccountId) {
    return res.status(400).json({ error: 'Product is not linked to a connected account.' });
  }

  const price = product.default_price; // expanded object
  // Platform fee = PLATFORM_FEE_PERCENT% of the price (in the same currency unit).
  const applicationFeeAmount = Math.round(price.unit_amount * (PLATFORM_FEE_PERCENT / 100));

  const session = await stripeClient.checkout.sessions.create({
    line_items: [
      {
        price: price.id, // the platform price we created above
        quantity: 1,
      },
    ],
    payment_intent_data: {
      application_fee_amount: applicationFeeAmount,     // platform keeps this
      transfer_data: { destination: connectedAccountId }, // rest goes to the coach
    },
    mode: 'payment',
    // Prefer the caller's URLs (e.g. back into the coaching app); fall back to ours.
    success_url: safe(successUrl) || `${ROOT_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: safe(cancelUrl) || `${ROOT_URL}/storefront.html`,
  });

  res.json({ url: session.url });
}));

// ============================================================================
// SECTION 4 — Webhook handler for THIN events (v2)
// ----------------------------------------------------------------------------
// V2 (Account v2) emits THIN events: a small payload you verify, then you call
// the API to fetch the full event + related object. We listen for:
//   • v2.core.account[requirements].updated
//   • v2.core.account[configuration.recipient].capability_status_updated
// so we can react when a financial regulator / card network changes what a
// coach must provide, or when their transfer capability flips active/inactive.
// ============================================================================
async function handleStripeWebhook(req, res) {
  const webhookSecret = getWebhookSecret();
  if (!webhookSecret) {
    console.error('✗ Webhook received but STRIPE_WEBHOOK_SECRET is not set. See README → "Listen for events".');
    return res.status(500).json({ error: 'Webhook secret not configured on the server.' });
  }

  const signature = req.headers['stripe-signature'];

  // Verify the signature against the RAW body and return a V2 EventNotification.
  // NOTE: in stripe-node v22 this method is `parseEventNotification` — it was
  // renamed from the older `parseThinEvent` you'll see in some docs/snippets.
  let notification;
  try {
    notification = stripeClient.parseEventNotification(req.body, signature, webhookSecret);
  } catch (err) {
    console.error('✗ Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
  }

  try {
    // Route on event type. We match by substring so we're resilient to the
    // configuration-type segment (e.g. [configuration.recipient]).
    if (notification.type.includes('account') && notification.type.includes('requirements')) {
      await onRequirementsUpdated(notification);
    } else if (notification.type.includes('capability_status_updated')) {
      await onCapabilityStatusUpdated(notification);
    } else {
      console.log(`ℹ️  Unhandled event type: ${notification.type}`);
    }

    // Always 2xx quickly so Stripe doesn't retry a handled event.
    res.json({ received: true });
  } catch (err) {
    console.error('✗ Error handling webhook:', err.message);
    res.status(500).json({ error: err.message });
  }
}

// The EventNotification is "thin" — it carries fetchRelatedObject() (the account
// this event is about) and fetchEvent() (the full event). We fetch the related
// account and re-read its live status.

// Requirements changed → re-read the account and collect anything now due.
async function onRequirementsUpdated(notification) {
  const account = await notification.fetchRelatedObject();
  const status = await getAccountStatus(account.id);
  console.log(
    `🔔 Requirements updated for ${account.id}: requirementsStatus=${status.requirementsStatus}, ` +
    `onboardingComplete=${status.onboardingComplete}`
  );
  // TODO (your app): if requirementsStatus is currently_due/past_due, email the
  // coach a fresh onboarding link so they can submit the new information.
}

// A capability flipped (e.g. transfers became active/inactive).
async function onCapabilityStatusUpdated(notification) {
  const account = await notification.fetchRelatedObject();
  const status = await getAccountStatus(account.id);
  console.log(
    `🔔 Capability status changed for ${account.id}: ` +
    `readyToReceivePayments=${status.readyToReceivePayments}`
  );
  // TODO (your app): toggle whether this coach's products are buyable.
}

// ----------------------------------------------------------------------------
// Boot
// ----------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`\n✅ Red Seal Rescue · Stripe Connect sample running`);
  console.log(`   Open:  ${ROOT_URL}`);
  console.log(`   (Platform fee on each sale: ${PLATFORM_FEE_PERCENT}%)\n`);
});

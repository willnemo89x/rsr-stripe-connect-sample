// ============================================================================
// config.js
// ----------------------------------------------------------------------------
// Loads environment variables, validates the ones we can't run without, and
// creates the single Stripe Client that the rest of the app uses for EVERY
// Stripe request (per Stripe's guidance — one client, reused everywhere).
// ============================================================================

// Load variables from a local ".env" file into process.env (no-op in prod
// hosts that inject env vars directly).
require('dotenv').config();

// The Stripe SDK. `Stripe` is the client constructor.
const Stripe = require('stripe');

// ----------------------------------------------------------------------------
// Helper: fail loudly and helpfully when a required value is missing or is
// still set to the placeholder shipped in .env.example.
// ----------------------------------------------------------------------------
function readRequired(name, { placeholders = [] } = {}) {
  const value = process.env[name];
  const isMissing = !value || value.trim() === '';
  const isPlaceholder = value && placeholders.some((p) => value.includes(p));

  if (isMissing || isPlaceholder) {
    console.error('\n──────────────────────────────────────────────────────────');
    console.error(`❌  Configuration problem: "${name}" is not set.`);
    if (isPlaceholder) {
      console.error('    It still contains the placeholder from .env.example.');
    }
    console.error('');
    console.error('    Fix it:');
    console.error('      1. Copy the example file:   cp .env.example .env');
    console.error('      2. Open .env and paste your real value for ' + name + '.');
    console.error('      3. Get TEST keys here: https://dashboard.stripe.com/test/apikeys');
    console.error('──────────────────────────────────────────────────────────\n');
    process.exit(1); // Stop now — running without this would only fail later, more confusingly.
  }
  return value;
}

// ----------------------------------------------------------------------------
// REQUIRED at startup: the platform secret key.
// (Placeholder strings here match what .env.example ships with.)
// ----------------------------------------------------------------------------
const STRIPE_SECRET_KEY = readRequired('STRIPE_SECRET_KEY', {
  placeholders: ['REPLACE_WITH_YOUR_SECRET_KEY', 'sk_***'],
});

// ----------------------------------------------------------------------------
// THE Stripe Client. Created once and exported.
//
// NOTE: We deliberately do NOT pin `apiVersion` here. The installed SDK
// (stripe-node v22+) already targets the correct preview API version
// (2026-05-27.dahlia) automatically, which is required for the v2 Accounts API
// used in this sample. Hard-coding a version could fight with the SDK.
// ----------------------------------------------------------------------------
const stripeClient = new Stripe(STRIPE_SECRET_KEY);

// ----------------------------------------------------------------------------
// The webhook signing secret is only needed by the /webhooks/stripe route, so
// we don't exit at startup if it's missing — we surface a clear error there
// instead. This lets you exercise onboarding/products/checkout before you've
// wired up the Stripe CLI listener.
// ----------------------------------------------------------------------------
function getWebhookSecret() {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || secret.includes('REPLACE_WITH_YOUR_WEBHOOK_SIGNING_SECRET')) {
    return null; // The route checks for null and responds with guidance.
  }
  return secret;
}

// ----------------------------------------------------------------------------
// Optional knobs with sensible defaults.
// ----------------------------------------------------------------------------
const ROOT_URL = process.env.ROOT_URL || 'http://localhost:4242';
const PORT = parseInt(process.env.PORT || '4242', 10);

// Platform fee as a percentage of each sale (10 => platform keeps 10%).
const PLATFORM_FEE_PERCENT = Number(process.env.PLATFORM_FEE_PERCENT || '10');

module.exports = {
  stripeClient,
  getWebhookSecret,
  ROOT_URL,
  PORT,
  PLATFORM_FEE_PERCENT,
};

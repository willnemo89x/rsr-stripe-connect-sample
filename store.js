// ============================================================================
// store.js
// ----------------------------------------------------------------------------
// A tiny JSON-file "database" that maps a platform user (here, identified by
// the email they onboarded with) to their Stripe connected ACCOUNT ID.
//
// ⚠️  DEMO ONLY. In a real app, store this mapping in your real database
//     (Postgres, etc.) on your user/coach record. We persist to a flat JSON
//     file just so the mapping survives a server restart during the demo.
//
// Note what we DON'T store: onboarding status / capabilities. Per the brief,
// we always read those live from the Stripe API so they're never stale.
// ============================================================================

const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data.json');

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { accounts: [] }; // File doesn't exist yet, or is empty.
  }
}

function writeAll(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// Save the mapping after creating a connected account.
// `user` is whatever identifies the coach on your platform (email here).
function saveAccount({ accountId, displayName, contactEmail }) {
  const db = readAll();
  // Replace any prior record for the same email (idempotent for the demo).
  db.accounts = db.accounts.filter((a) => a.contactEmail !== contactEmail);
  db.accounts.push({
    accountId,
    displayName,
    contactEmail,
    createdAt: new Date().toISOString(),
  });
  writeAll(db);
}

// All known connected accounts (used by the onboarding list + storefront).
function listAccounts() {
  return readAll().accounts;
}

module.exports = { saveAccount, listAccounts };

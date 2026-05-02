const path = require('path');
const fs   = require('fs');

// Activated only at startup via: node server.js --demo  (or npm run demo)
// Demo mode must never read live user data or write to data/.
const demoMode = process.argv.includes('--demo');

// ── Bootstrap: create data/ and seed .env before anything else loads ─────────
const dataDir = path.join(process.cwd(), 'data');
if (!demoMode && !fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
console.log(`  Data directory: ${dataDir}`);
const dataEnvFile    = path.join(dataDir, '.env');
const exampleEnvFile = path.join(__dirname, 'data.example', '.env');
if (!demoMode && !fs.existsSync(dataEnvFile) && fs.existsSync(exampleEnvFile)) {
  fs.copyFileSync(exampleEnvFile, dataEnvFile);
  console.log('  Created data/.env from data.example/.env — fill in your Plaid credentials.');
}

// Load .env from data/ first, fall back to root .env (backwards-compatible)
if (!demoMode) {
  require('dotenv').config({ path: dataEnvFile });
  if (!process.env.PLAID_CLIENT_ID) require('dotenv').config(); // root fallback
}

const express   = require('express');
const cors      = require('cors');
const https     = require('https');
const Anthropic = require('@anthropic-ai/sdk').default;
const {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
} = require('plaid');

const app = express();
app.use(cors({ origin: ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://myfinance.local'] }));
app.use(express.json());
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/') {
    res.setHeader('Cache-Control', 'public, max-age=60');
  }
  next();
});
app.use((req, res, next) => {
  // Never expose local finance data through the root static file server.
  if (req.path === '/data' || req.path.startsWith('/data/') ||
      req.path === '/data.example' || req.path.startsWith('/data.example/')) {
    return res.status(404).send('Not found');
  }
  next();
});
app.get(['/', '/dashboard', '/investments', '/spending', '/transactions', '/recurring', '/accounts', '/settings'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.use(express.static(path.join(__dirname)));

// ── Plaid client ──────────────────────────────────────────────────────────────
let PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID;
let PLAID_SECRET    = process.env.PLAID_SECRET;
let PLAID_ENV       = process.env.PLAID_ENV || 'sandbox';

function makePlaidClient(clientId, secret, env) {
  return new PlaidApi(new Configuration({
    basePath: PlaidEnvironments[env],
    baseOptions: { headers: { 'PLAID-CLIENT-ID': clientId, 'PLAID-SECRET': secret } },
  }));
}
let plaidClient = makePlaidClient(PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV);

// ── Anthropic / Claude ────────────────────────────────────────────────────────
let ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// ── Token persistence ─────────────────────────────────────────────────────────
const TOKENS_FILE = path.join(dataDir, 'tokens.json');
let items = [];
try {
  if (!demoMode && fs.existsSync(TOKENS_FILE)) items = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
} catch (_) { items = []; }
function saveItems() { fs.writeFileSync(TOKENS_FILE, JSON.stringify(items, null, 2)); }

// ── Net worth history (persisted on disk) ─────────────────────────────────────
const HISTORY_FILE = path.join(dataDir, 'history.json');
let netWorthHistory = [];
try {
  if (!demoMode && fs.existsSync(HISTORY_FILE)) netWorthHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
} catch (_) { netWorthHistory = []; }
function persistHistory() { fs.writeFileSync(HISTORY_FILE, JSON.stringify(netWorthHistory, null, 2)); }

// Returns "YYYY-Www" for a date string, used for weekly downsampling
function isoWeekKey(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// Compacts net worth history: entries older than 30 days are downsampled to one per week (latest wins).
// Entries with source:'manual' are always preserved.
function compactHistory(history) {
  const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString().split('T')[0];
  const recent  = history.filter(h => h.date >= cutoff);
  const older   = history.filter(h => h.date < cutoff);
  const manual  = older.filter(h => h.source === 'manual');
  const auto    = older.filter(h => h.source !== 'manual');
  const byWeek  = new Map();
  for (const h of auto) {
    const wk = isoWeekKey(h.date);
    if (!byWeek.has(wk) || h.date > byWeek.get(wk).date) byWeek.set(wk, h);
  }
  const compacted = [...manual, ...[...byWeek.values()]].sort((a, b) => a.date.localeCompare(b.date));
  return [...compacted, ...recent];
}

// ── Manual accounts (persisted on disk) ───────────────────────────────────────
const MANUAL_FILE = path.join(dataDir, 'manual_accounts.json');
let manualAccountsDb = [];
try {
  if (!demoMode && fs.existsSync(MANUAL_FILE)) manualAccountsDb = JSON.parse(fs.readFileSync(MANUAL_FILE, 'utf8'));
} catch (_) { manualAccountsDb = []; }
function persistManual() { fs.writeFileSync(MANUAL_FILE, JSON.stringify(manualAccountsDb, null, 2)); }

// ── Transaction category overrides (persisted on disk) ────────────────────────
// Format: { "transaction_id": "car", "other_tx_id": "vacation", ... }
const TX_OVERRIDES_FILE = path.join(dataDir, 'tx_overrides.json');
let txOverrides = {};
try {
  if (!demoMode && fs.existsSync(TX_OVERRIDES_FILE)) txOverrides = JSON.parse(fs.readFileSync(TX_OVERRIDES_FILE, 'utf8'));
} catch (_) { txOverrides = {}; }
function persistOverrides() { fs.writeFileSync(TX_OVERRIDES_FILE, JSON.stringify(txOverrides, null, 2)); }

// ── Custom categories (persisted on disk) ─────────────────────────────────────
// Format: [{ key, label, icon, color }, ...]
const CUSTOM_CATS_FILE = path.join(dataDir, 'custom_categories.json');
let customCatsDb = [];
try {
  if (!demoMode && fs.existsSync(CUSTOM_CATS_FILE)) customCatsDb = JSON.parse(fs.readFileSync(CUSTOM_CATS_FILE, 'utf8'));
} catch (_) { customCatsDb = []; }
function persistCustomCats() { fs.writeFileSync(CUSTOM_CATS_FILE, JSON.stringify(customCatsDb, null, 2)); }

// ── Spending exclusions (persisted on disk) ───────────────────────────────────
// Format: { "transaction_id": true, ... }  — transactions the user has excluded from spending
const SPEND_EXCL_FILE = path.join(dataDir, 'spending_exclusions.json');
let spendExclDb = {};
try {
  if (!demoMode && fs.existsSync(SPEND_EXCL_FILE)) spendExclDb = JSON.parse(fs.readFileSync(SPEND_EXCL_FILE, 'utf8'));
} catch (_) { spendExclDb = {}; }
function persistSpendExcl() { fs.writeFileSync(SPEND_EXCL_FILE, JSON.stringify(spendExclDb, null, 2)); }

// ── CSV accounts (persisted on disk) ─────────────────────────────────────────
// Format: [{ id, name, institution, assetBucket, dataType, balance, transactions[], holdings[], securities{}, ... }]
const CSV_ACCOUNTS_FILE = path.join(dataDir, 'csv_accounts.json');
let csvAccountsDb = [];
try {
  if (!demoMode && fs.existsSync(CSV_ACCOUNTS_FILE)) csvAccountsDb = JSON.parse(fs.readFileSync(CSV_ACCOUNTS_FILE, 'utf8'));
} catch (_) { csvAccountsDb = []; }
function persistCsvAccounts() { fs.writeFileSync(CSV_ACCOUNTS_FILE, JSON.stringify(csvAccountsDb, null, 2)); }

// ── Cost basis overrides (persisted on disk) ──────────────────────────────────
// Format: { "VOO": 12345.67, "AAPL": 8900.00, ... }  (keyed by ticker symbol)
const COST_BASIS_FILE = path.join(dataDir, 'cost_basis_overrides.json');
let costBasisDb = {};
try {
  if (!demoMode && fs.existsSync(COST_BASIS_FILE)) costBasisDb = JSON.parse(fs.readFileSync(COST_BASIS_FILE, 'utf8'));
} catch (_) { costBasisDb = {}; }
function persistCostBasis() { fs.writeFileSync(COST_BASIS_FILE, JSON.stringify(costBasisDb, null, 2)); }

// ── Manual (cash) transactions (persisted on disk) ────────────────────────────
// Format: [{ transaction_id, date, name, amount, account_name, institution_name, is_manual, ... }]
const MANUAL_TX_FILE = path.join(dataDir, 'manual_transactions.json');
let manualTxDb = [];
try {
  if (!demoMode && fs.existsSync(MANUAL_TX_FILE)) manualTxDb = JSON.parse(fs.readFileSync(MANUAL_TX_FILE, 'utf8'));
} catch (_) { manualTxDb = []; }
function persistManualTx() { fs.writeFileSync(MANUAL_TX_FILE, JSON.stringify(manualTxDb, null, 2)); }

// ── Live price cache (in-memory, TTL 5 minutes) ───────────────────────────────
const PRICE_CACHE_TTL = 5 * 60 * 1000;
const priceCache  = {}; // { "VOO": { price: 520.23, ts: 1714000000000 }, ... }
const FX_CACHE_TTL  = 30 * 60 * 1000;
const fxRateCache = {}; // { "INR": { rate: 83.5, ts: ... }, ... } — USD per 1 unit of currency

// ── Transactions cache (persisted on disk) ────────────────────────────────────
// Format: { last_synced: ISO string, transactions: [...Plaid tx objects] }
const TX_CACHE_FILE = path.join(dataDir, 'transactions_cache.json');
let txCache = { last_synced: null, transactions: [] };
try {
  if (!demoMode && fs.existsSync(TX_CACHE_FILE)) txCache = JSON.parse(fs.readFileSync(TX_CACHE_FILE, 'utf8'));
} catch (_) { txCache = { last_synced: null, transactions: [] }; }
function persistTxCache() { fs.writeFileSync(TX_CACHE_FILE, JSON.stringify(txCache, null, 2)); }

// ── Investments cache (persisted on disk) ─────────────────────────────────────
// Format: { last_synced: ISO string, holdings: [...], securities: {...}, needs_reconnect: [...] }
const INV_CACHE_FILE = path.join(dataDir, 'investments_cache.json');
let invCache = { last_synced: null, holdings: [], securities: {}, needs_reconnect: [] };
try {
  if (!demoMode && fs.existsSync(INV_CACHE_FILE)) invCache = JSON.parse(fs.readFileSync(INV_CACHE_FILE, 'utf8'));
} catch (_) { invCache = { last_synced: null, holdings: [], securities: {}, needs_reconnect: [] }; }
function persistInvCache() { fs.writeFileSync(INV_CACHE_FILE, JSON.stringify(invCache, null, 2)); }

// ── Demo mode ─────────────────────────────────────────────────────────────────
// Never stored to disk — zero risk of demo data leaking into production files.
const DEMO_DATA_FILE = path.join(__dirname, 'data.example', 'demo_data.json');

function loadDemoData() {
  try { return JSON.parse(fs.readFileSync(DEMO_DATA_FILE, 'utf8')); }
  catch (_) { return { accounts: [], history: [], holdings: [], securities: {}, transactions: [] }; }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health / config check
app.get('/api/config', (_req, res) => {
  res.json({
    configured:             !!(PLAID_CLIENT_ID && PLAID_SECRET),
    environment:            PLAID_ENV,
    connected_institutions: items.length,
    demo_mode:              demoMode,
  });
});


// Save Plaid credentials to data/.env and hot-reload the client (no restart needed)
app.post('/api/setup', (req, res) => {
  if (demoMode) return res.status(403).json({ error: 'Cannot configure in demo mode.' });
  const { clientId, secret, environment } = req.body;
  if (!clientId || !secret) return res.status(400).json({ error: 'Client ID and Secret are required.' });

  const env = ['sandbox', 'development', 'production'].includes(environment) ? environment : 'production';

  // Read existing .env so we preserve any other vars the user may have set
  let existing = '';
  try { existing = fs.readFileSync(dataEnvFile, 'utf8'); } catch (_) {}
  const lines = existing.split('\n').filter(l => !/^PLAID_(CLIENT_ID|SECRET|ENV)\s*=/.test(l));
  lines.push(`PLAID_CLIENT_ID=${clientId}`, `PLAID_SECRET=${secret}`, `PLAID_ENV=${env}`);
  fs.writeFileSync(dataEnvFile, lines.join('\n') + '\n');

  // Hot-reload — no server restart required
  PLAID_CLIENT_ID = clientId;
  PLAID_SECRET    = secret;
  PLAID_ENV       = env;
  plaidClient     = makePlaidClient(clientId, secret, env);

  res.json({ success: true, configured: true, environment: env });
});

// Step 1 – create a Plaid Link token
app.post('/api/create_link_token', async (_req, res) => {
  if (demoMode) return res.status(403).json({ error: 'Cannot connect accounts in demo mode. Restart with npm start.' });
  if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
    return res.status(400).json({ error: 'Plaid credentials not configured. See .env.example.' });
  }
  try {
    const resp = await plaidClient.linkTokenCreate({
      user:          { client_user_id: 'local-user' },
      client_name:   'Net Worth Tracker',
      products:      ['transactions', 'investments'],
      language:      'en',
      country_codes: ['US'],
    });
    res.json({ link_token: resp.data.link_token });
  } catch (err) {
    console.error('create_link_token:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error_message || err.message });
  }
});

// Step 2 – exchange public token for access token
app.post('/api/exchange_token', async (req, res) => {
  if (demoMode) return res.status(403).json({ error: 'Cannot connect accounts in demo mode. Restart with npm start.' });
  const { public_token, institution_name, institution_id } = req.body;
  if (!public_token) return res.status(400).json({ error: 'public_token is required' });
  try {
    const resp = await plaidClient.itemPublicTokenExchange({ public_token });
    items.push({
      access_token:     resp.data.access_token,
      item_id:          resp.data.item_id,
      institution_name: institution_name || 'Unknown Bank',
      institution_id:   institution_id   || '',
      connected_at:     new Date().toISOString(),
    });
    saveItems();
    res.json({ success: true, item_id: resp.data.item_id });
  } catch (err) {
    console.error('exchange_token:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error_message || err.message });
  }
});

// Get all accounts across every connected institution
app.get('/api/accounts', async (_req, res) => {
  if (demoMode) {
    return res.json({ accounts: loadDemoData().accounts || [], demo_mode: true });
  }
  const allAccounts = [];
  for (const item of items) {
    try {
      const resp = await plaidClient.accountsGet({ access_token: item.access_token });
      const accounts = resp.data.accounts.map(acc => ({
        ...acc,
        institution_name: item.institution_name,
        institution_id:   item.institution_id,
        item_id:          item.item_id,
      }));

      // Attempt to fetch credit-card liability data (requires Liabilities product).
      // Gracefully skip if the product isn't enabled for this item.
      try {
        const liabResp = await plaidClient.liabilitiesGet({ access_token: item.access_token });
        const creditCards = liabResp.data.liabilities?.credit || [];
        const liabMap = {};
        for (const cc of creditCards) liabMap[cc.account_id] = cc;
        for (const acc of accounts) {
          const cc = liabMap[acc.account_id];
          if (cc) {
            acc.next_payment_due_date     = cc.next_payment_due_date     || null;
            acc.minimum_payment_amount    = cc.minimum_payment_amount    ?? null;
          }
        }
      } catch (_liabErr) {
        // Liabilities product not enabled — credit card due dates unavailable
      }

      accounts.forEach(acc => allAccounts.push(acc));
    } catch (err) {
      console.error(`accounts [${item.institution_name}]:`, err.message);
    }
  }
  res.json({ accounts: allAccounts });
});

// Get transactions — returns local cache instantly (no Plaid call)
app.get('/api/transactions', (_req, res) => {
  if (demoMode) {
    const dd = loadDemoData();
    return res.json({ transactions: dd.transactions || [], last_synced: null, demo_mode: true });
  }
  res.json({
    transactions: txCache.transactions || [],
    last_synced:  txCache.last_synced  || null,
    from_cache:   true,
  });
});

// Sync transactions from Plaid — fetches last 90 days, merges with older cached history
app.post('/api/transactions/sync', async (_req, res) => {
  if (demoMode) return res.json({ transactions: loadDemoData().transactions || [], last_synced: null, demo_mode: true });
  const endDate   = new Date().toISOString().split('T')[0];
  const startDate = new Date(Date.now() - 90 * 86400_000).toISOString().split('T')[0];
  const freshTxs  = [];

  for (const item of items) {
    try {
      let offset = 0;
      while (true) {
        const resp = await plaidClient.transactionsGet({
          access_token: item.access_token,
          start_date:   startDate,
          end_date:     endDate,
          options:      { count: 500, offset },
        });
        const txs = resp.data.transactions;
        txs.forEach(t => freshTxs.push({ ...t, institution_name: item.institution_name }));
        offset += txs.length;
        if (offset >= resp.data.total_transactions || txs.length === 0) break;
      }
    } catch (err) {
      console.error(`transactions [${item.institution_name}]:`, err.message);
    }
  }

  // Keep cached transactions that are older than the Plaid window (we can't re-fetch those)
  // Replace everything within the window with fresh Plaid data (handles pending→posted transitions)
  const sixMonthsAgo = new Date(Date.now() - 180 * 86400_000).toISOString().split('T')[0];
  const historicTxs = (txCache.transactions || []).filter(t => t.date < startDate && t.date >= sixMonthsAgo);
  const merged = [...historicTxs, ...freshTxs];
  merged.sort((a, b) => new Date(b.date) - new Date(a.date));

  // Enforce 6-month retention and 10k hard cap (merged is already newest-first)
  const MAX_TX = 10_000;
  if (merged.length > MAX_TX) {
    console.warn(`[tx-cache] trimmed to ${MAX_TX} (dropped ${merged.length - MAX_TX} older entries)`);
    merged.splice(MAX_TX);
  }

  txCache = { last_synced: new Date().toISOString(), transactions: merged };
  persistTxCache();
  res.json({ transactions: merged, last_synced: txCache.last_synced });
});

// Get investment holdings — returns local cache instantly (no Plaid call)
app.get('/api/investments', (_req, res) => {
  if (demoMode) {
    const dd = loadDemoData();
    return res.json({ holdings: dd.holdings || [], securities: dd.securities || {}, needs_reconnect: [], last_synced: null, demo_mode: true });
  }
  res.json({
    holdings:        invCache.holdings        || [],
    securities:      invCache.securities      || {},
    needs_reconnect: invCache.needs_reconnect || [],
    last_synced:     invCache.last_synced     || null,
    from_cache:      true,
  });
});

// Sync investments from Plaid — fetches fresh holdings and overwrites cache
app.post('/api/investments/sync', async (_req, res) => {
  if (demoMode) { const dd = loadDemoData(); return res.json({ holdings: dd.holdings || [], securities: dd.securities || {}, needs_reconnect: [], last_synced: null, demo_mode: true }); }
  const allHoldings    = [];
  const allSecurities  = {};
  const needsReconnect = [];

  for (const item of items) {
    try {
      const resp = await plaidClient.investmentsHoldingsGet({ access_token: item.access_token });
      (resp.data.securities || []).forEach(s => { allSecurities[s.security_id] = s; });
      (resp.data.holdings || []).forEach(h =>
        allHoldings.push({ ...h, institution_name: item.institution_name, item_id: item.item_id })
      );
    } catch (err) {
      const code = err.response?.data?.error_code || '';
      const msg  = err.response?.data?.error_message || err.message;
      console.log(`investments [${item.institution_name}] error_code=${code}: ${msg}`);
      const reconnectCodes = [
        'ADDITIONAL_CONSENT_REQUIRED',
        'PRODUCTS_NOT_SUPPORTED', 'PRODUCT_NOT_ENABLED',
        'ITEM_NOT_SUPPORTED',     'INVALID_PRODUCT',
        'PLANNED_MAINTENANCE',
      ];
      if (reconnectCodes.some(c => code.includes(c)) || code === '') {
        needsReconnect.push({ institution_name: item.institution_name, item_id: item.item_id, error_code: code });
      }
    }
  }

  invCache = {
    last_synced:     new Date().toISOString(),
    holdings:        allHoldings,
    securities:      allSecurities,
    needs_reconnect: needsReconnect,
  };
  persistInvCache();
  res.json({ holdings: allHoldings, securities: allSecurities, needs_reconnect: needsReconnect, last_synced: invCache.last_synced });
});

// Remove a connected institution and scrub all associated data from every cache.
app.delete('/api/items/:item_id', async (req, res) => {
  if (demoMode) return res.json({ success: true, demo_mode: true });
  const item = items.find(i => i.item_id === req.params.item_id);
  if (item) {
    try { await plaidClient.itemRemove({ access_token: item.access_token }); } catch (_) {}
    items = items.filter(i => i.item_id !== req.params.item_id);
    saveItems();

    // Purge this institution's transactions from the cache and collect their IDs
    // so we can scrub overrides that reference them.
    const removedTxIds = new Set(
      (txCache.transactions || [])
        .filter(t => t.institution_name === item.institution_name)
        .map(t => t.transaction_id)
    );
    if (removedTxIds.size > 0) {
      txCache.transactions = (txCache.transactions || []).filter(t => !removedTxIds.has(t.transaction_id));
      persistTxCache();
      let overrideDirty = false;
      for (const id of removedTxIds) {
        if (id in txOverrides) { delete txOverrides[id]; overrideDirty = true; }
        if (id in spendExclDb) { delete spendExclDb[id]; overrideDirty = true; }
      }
      if (overrideDirty) { persistOverrides(); persistSpendExcl(); }
    }

    // Purge this institution's holdings from the investments cache.
    const prevHoldings = (invCache.holdings || []).length;
    invCache.holdings = (invCache.holdings || []).filter(h => h.item_id !== req.params.item_id);
    if (invCache.holdings.length !== prevHoldings) persistInvCache();
  }
  res.json({ success: true });
});

// ── Net worth history endpoints ───────────────────────────────────────────────
app.get('/api/history', (_req, res) => {
  if (demoMode) {
    return res.json({ history: loadDemoData().history || [], demo_mode: true });
  }
  res.json({ history: netWorthHistory });
});

app.post('/api/history/snapshot', (req, res) => {
  if (demoMode) return res.json({ success: true, demo_mode: true }); // no-op in demo
  const { date, value, investments } = req.body;
  if (!date || value === undefined) return res.status(400).json({ error: 'date and value required' });
  const snap = { date, value, ...(investments != null ? { investments } : {}) };
  const idx = netWorthHistory.findIndex(h => h.date === date);
  if (idx !== -1) netWorthHistory[idx] = { ...netWorthHistory[idx], ...snap };
  else netWorthHistory.push(snap);
  netWorthHistory.sort((a, b) => a.date.localeCompare(b.date));
  netWorthHistory = compactHistory(netWorthHistory);
  persistHistory();
  res.json({ success: true, total_snapshots: netWorthHistory.length });
});

app.post('/api/history/import', (req, res) => {
  if (demoMode) return res.json({ success: true, demo_mode: true });
  const entries = req.body;
  if (!Array.isArray(entries)) return res.status(400).json({ error: 'expected array of {date,value}' });
  for (const e of entries) {
    if (!e.date || e.value === undefined) continue;
    const snap = { date: e.date, value: e.value, source: 'manual' };
    const idx = netWorthHistory.findIndex(h => h.date === e.date);
    if (idx === -1) netWorthHistory.push(snap); // don't overwrite existing tracked entries
  }
  netWorthHistory.sort((a, b) => a.date.localeCompare(b.date));
  netWorthHistory = compactHistory(netWorthHistory);
  persistHistory();
  res.json({ success: true, total_snapshots: netWorthHistory.length });
});

// ── Manual accounts endpoints ─────────────────────────────────────────────────
app.get('/api/manual-accounts', (_req, res) => {
  if (demoMode) return res.json({ accounts: loadDemoData().manual_accounts || [], demo_mode: true });
  res.json({ accounts: manualAccountsDb });
});

app.put('/api/manual-accounts', (req, res) => {
  if (demoMode) return res.json({ success: true, demo_mode: true }); // no-op in demo
  manualAccountsDb = req.body.accounts || [];
  persistManual();
  res.json({ success: true });
});

// ── Manual (cash) transaction endpoints ──────────────────────────────────────
app.get('/api/manual-transactions', (_req, res) => {
  if (demoMode) return res.json({ transactions: [] });
  res.json({ transactions: manualTxDb });
});

app.put('/api/manual-transactions', (req, res) => {
  if (demoMode) return res.json({ success: true, demo_mode: true });
  manualTxDb = req.body.transactions || [];
  persistManualTx();
  res.json({ success: true });
});

// ── CSV account endpoints ─────────────────────────────────────────────────────
app.get('/api/csv-accounts', (_req, res) => {
  if (demoMode) return res.json({ accounts: loadDemoData().csv_accounts || [], demo_mode: true });
  res.json({ accounts: csvAccountsDb });
});

app.put('/api/csv-accounts', (req, res) => {
  if (demoMode) return res.json({ success: true, demo_mode: true });
  csvAccountsDb = req.body.accounts || [];
  persistCsvAccounts();
  res.json({ success: true });
});

// Add investments consent to an existing item (no disconnect needed)
app.post('/api/update_consent/:item_id', async (req, res) => {
  if (demoMode) return res.status(403).json({ error: 'Cannot update Plaid consent in demo mode.' });
  const item = items.find(i => i.item_id === req.params.item_id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  try {
    const resp = await plaidClient.linkTokenCreate({
      user:                         { client_user_id: 'local-user' },
      client_name:                  'Net Worth Tracker',
      access_token:                 item.access_token,
      additional_consented_products: ['investments'],
      language:                     'en',
      country_codes:                ['US'],
    });
    res.json({ link_token: resp.data.link_token });
  } catch (err) {
    console.error('update_consent:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error_message || err.message });
  }
});

// ── Transaction category override endpoints ───────────────────────────────────
app.get('/api/tx-overrides', (_req, res) => {
  if (demoMode) return res.json({ overrides: loadDemoData().tx_overrides || {}, demo_mode: true });
  res.json({ overrides: txOverrides });
});

app.put('/api/tx-overrides', (req, res) => {
  if (demoMode) return res.json({ success: true, demo_mode: true });
  txOverrides = req.body.overrides || {};
  persistOverrides();
  res.json({ success: true });
});

// ── Spending exclusion endpoints ──────────────────────────────────────────────
app.get('/api/spending-exclusions', (_req, res) => {
  if (demoMode) return res.json({ exclusions: loadDemoData().spending_exclusions || {}, demo_mode: true });
  res.json({ exclusions: spendExclDb });
});
app.put('/api/spending-exclusions', (req, res) => {
  if (demoMode) return res.json({ success: true, demo_mode: true });
  spendExclDb = req.body.exclusions || {};   // always update in-memory so GET returns fresh data
  persistSpendExcl();
  res.json({ success: true });
});

// ── Custom category endpoints ─────────────────────────────────────────────────
app.get('/api/custom-categories', (_req, res) => {
  if (demoMode) return res.json({ categories: loadDemoData().custom_categories || [], demo_mode: true });
  res.json({ categories: customCatsDb });
});

app.put('/api/custom-categories', (req, res) => {
  if (demoMode) return res.json({ success: true, demo_mode: true });
  customCatsDb = req.body.categories || [];
  persistCustomCats();
  res.json({ success: true });
});

// ── Cost basis override endpoints ─────────────────────────────────────────────
app.get('/api/cost-basis', (_req, res) => {
  if (demoMode) return res.json({ overrides: loadDemoData().cost_basis_overrides || {}, demo_mode: true });
  res.json({ overrides: costBasisDb });
});
app.put('/api/cost-basis', (req, res) => {
  if (demoMode) return res.json({ success: true, demo_mode: true });
  costBasisDb = req.body.overrides || {};
  persistCostBasis();
  res.json({ success: true });
});

// ── Live ticker prices ────────────────────────────────────────────────────────

function httpsGetJson(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        ...extraHeaders,
      },
    }, (r) => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON from ' + url.slice(0, 80))); }
      });
    }).on('error', reject);
  });
}

function httpsGetText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    }, (r) => {
      // Follow redirects
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        return httpsGetText(r.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// Fetch USD-to-X exchange rate from Google Finance (primary) with Yahoo Finance fallback.
// Returns: how many units of `currency` per 1 USD (e.g. 83.5 for INR).
async function fetchFxRate(currency) {
  // ── Google Finance ────────────────────────────────────────────────────────
  try {
    const html = await httpsGetText(`https://www.google.com/finance/quote/USD-${currency}`);
    // Google Finance embeds the live price in a data-last-price attribute
    let m = html.match(/data-last-price="([\d.]+)"/);
    if (!m) {
      // Fallback: look for the rate in the main YMlKec price element
      m = html.match(/class="[^"]*YMlKec[^"]*"[^>]*>([\d,]+\.[\d]+)</);
    }
    if (m) {
      const rate = parseFloat(m[1].replace(/,/g, ''));
      if (rate > 0) {
        console.log(`[FX] Google Finance USD-${currency} → ${rate}`);
        return rate;
      }
    }
  } catch (e) {
    console.warn(`[FX] Google Finance failed for USD-${currency}:`, e.message);
  }

  // ── Yahoo Finance fallback ────────────────────────────────────────────────
  const pair = `USD${currency}=X`;
  let fx = await fetchYahooV8(pair);
  if (!fx) fx = await fetchYahooV1(pair);
  if (fx) {
    console.log(`[FX] Yahoo Finance ${pair} → ${fx.price}`);
    return fx.price;
  }

  return null;
}

// Ticker aliases: map stored CSV symbols to the correct Yahoo Finance query symbol.
// Yahoo Finance uses hyphens for dot-suffixed tickers (BRK.B → BRK-B).
const TICKER_ALIASES = {
  'BRKB': 'BRK-B',
};

// Map user-facing exchange suffixes to Yahoo Finance suffixes.
// Users enter RELIANCE.NSE / RELIANCE.BSE; Yahoo expects RELIANCE.NS / RELIANCE.BO.
const EXCHANGE_SUFFIX_MAP = { '.NSE': '.NS', '.BSE': '.BO' };
function toYahooTicker(ticker) {
  for (const [from, to] of Object.entries(EXCHANGE_SUFFIX_MAP)) {
    if (ticker.endsWith(from)) return ticker.slice(0, -from.length) + to;
  }
  return TICKER_ALIASES[ticker] || ticker;
}

// Proxy tickers: plan-specific fund codes (e.g. NH Deferred Compensation Plan via Fidelity)
// that have no public API. We fetch the equivalent public fund's daily % change and apply
// it to the last known price from the most recent CSV import to give a live estimate.
const TICKER_PROXIES = {
  'NHFSMKX98': 'FXAIX',  // NH Fidelity 500 Index → Fidelity 500 Index Fund
  'NHFSTMX97': 'FSKAX',  // NH Total Market Index  → Fidelity Total Market Index Fund
  'NHXINT906': 'FSPSX',  // NH International Index → Fidelity International Index Fund
};

// Return the most recently imported institution_price for a ticker from in-memory CSV holdings.
function getLastKnownCsvPrice(ticker) {
  for (const account of csvAccountsDb) {
    const securities = account.securities || {};
    for (const [secId, sec] of Object.entries(securities)) {
      if (sec.ticker_symbol === ticker) {
        const holding = (account.holdings || []).find(h => h.security_id === secId);
        if (holding?.institution_price != null) return Number(holding.institution_price);
      }
    }
  }
  return null;
}

// For proxy-mapped tickers: apply the proxy fund's daily % change to the last known price.
async function fetchProxyPrice(ticker) {
  const proxyTicker = TICKER_PROXIES[ticker];
  if (!proxyTicker) return null;
  const base = getLastKnownCsvPrice(ticker);
  if (base == null) return null;
  let proxy = await fetchYahooV8(proxyTicker);
  if (!proxy) proxy = await fetchYahooV1(proxyTicker);
  if (!proxy || proxy.changePct == null) return null;
  const price = base * (1 + proxy.changePct / 100);
  return { price, change: price - base, changePct: proxy.changePct };
}

// Extract { price, change, changePct } from a Yahoo Finance v8 chart result.
// meta.chartPreviousClose is the close BEFORE the chart window (e.g. 5+ days ago),
// NOT yesterday's close — using it produces multi-day changes, not daily ones.
// The correct previous close is the second-to-last daily close in the chart data.
function parseYahooResult(result) {
  const meta = result?.meta;
  if (!meta) return null;
  const price = meta.regularMarketPrice ?? meta.previousClose;
  if (price == null) return null;
  // Build a list of non-null closes from the daily candles.
  const closes = (result?.indicators?.quote?.[0]?.close || []).filter(v => v != null);
  // Second-to-last close = yesterday's session close (last entry is today's ongoing session).
  const prev = closes.length >= 2 ? closes[closes.length - 2] : price;
  const change    = price - prev;
  const changePct = prev > 0 ? (change / prev) * 100 : null;
  const currency  = (meta.currency || 'USD').toUpperCase();
  return { price, change, changePct, currency };
}

// Primary: Yahoo Finance v8 chart API (stable, no auth required)
async function fetchYahooV8(ticker) {
  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`;
    const data = await httpsGetJson(url);
    return parseYahooResult(data?.chart?.result?.[0]);
  } catch {
    return null;
  }
}

// Fallback: Yahoo Finance v1 (quote summary)
async function fetchYahooV1(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`;
    const data = await httpsGetJson(url);
    return parseYahooResult(data?.chart?.result?.[0]);
  } catch {
    return null;
  }
}

app.get('/api/prices', async (req, res) => {
  const tickerParam = req.query.tickers || '';
  const raw = tickerParam.split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
  // Validate: max 100 tickers, each must be 1–20 alphanumeric/dot/dash chars
  // 20 chars covers Indian tickers like TATAMOTORS.NS (13 chars) and similar long symbols
  const tickers = raw.filter(t => /^[A-Z0-9.\-]{1,20}$/.test(t)).slice(0, 100);
  if (!tickers.length) return res.json({ prices: {}, fetched_at: new Date().toISOString() });

  const now   = Date.now();
  const fresh = {};
  const stale = [];

  // priceDetails carries full per-ticker data: { price, change, changePct }
  const priceDetails = {};
  tickers.forEach(t => {
    const cached = priceCache[t];
    if (cached && (now - cached.ts) < PRICE_CACHE_TTL) {
      fresh[t] = cached.price;
      priceDetails[t] = { price: cached.price, change: cached.change ?? null, changePct: cached.changePct ?? null };
    } else {
      stale.push(t);
    }
  });

  if (stale.length) {
    // Fetch stale tickers in parallel:
    //   1. Yahoo Finance v8 (query2), with alias applied for dot-tickers like BRK-B
    //   2. Yahoo Finance v1 fallback
    //   3. Proxy estimate for plan-specific fund codes (NHFSMKX98 etc.)
    const pendingFx = {}; // non-USD results awaiting conversion: { ticker: result }

    await Promise.all(stale.map(async (ticker) => {
      const yahooTicker = toYahooTicker(ticker);
      let result = await fetchYahooV8(yahooTicker);
      if (!result) result = await fetchYahooV1(yahooTicker);
      if (!result) result = await fetchProxyPrice(ticker);
      if (result) {
        if (result.currency && result.currency !== 'USD') {
          pendingFx[ticker] = result; // convert after fetching FX rate
        } else {
          priceCache[ticker] = { price: result.price, change: result.change ?? null, changePct: result.changePct ?? null, ts: now };
          fresh[ticker] = result.price;
          priceDetails[ticker] = { price: result.price, change: result.change ?? null, changePct: result.changePct ?? null };
          const alias = yahooTicker !== ticker ? ` (→ ${yahooTicker})` : '';
          const proxy = TICKER_PROXIES[ticker] ? ` (proxy ${TICKER_PROXIES[ticker]})` : '';
          console.log(`[Prices] ${ticker}${alias}${proxy} → $${result.price.toFixed(4)} (${result.changePct?.toFixed(2) ?? '—'}%)`);
        }
      } else {
        console.warn(`[Prices] Could not fetch price for ${ticker}`);
      }
    }));

    // Convert non-USD prices to USD using live FX rates
    if (Object.keys(pendingFx).length) {
      const currencies = [...new Set(Object.values(pendingFx).map(r => r.currency))];
      const rates = {};
      await Promise.all(currencies.map(async (currency) => {
        const cached = fxRateCache[currency];
        if (cached && (now - cached.ts) < FX_CACHE_TTL) { rates[currency] = cached.rate; return; }
        const rate = await fetchFxRate(currency); // Google Finance → Yahoo Finance fallback
        if (rate) {
          fxRateCache[currency] = { rate, ts: now };
          rates[currency] = rate;
        }
      }));

      Object.entries(pendingFx).forEach(([ticker, result]) => {
        const rate     = rates[result.currency];
        const usdPrice = rate ? result.price / rate : result.price;
        const usdChg   = rate && result.change != null ? result.change / rate : result.change;
        priceCache[ticker] = { price: usdPrice, change: usdChg ?? null, changePct: result.changePct ?? null, ts: now };
        fresh[ticker]      = usdPrice;
        priceDetails[ticker] = { price: usdPrice, change: usdChg ?? null, changePct: result.changePct ?? null };
        console.log(`[Prices] ${ticker} (${result.currency}) ${result.price.toFixed(2)} ÷ ${rate?.toFixed(2) ?? '?'} → $${usdPrice.toFixed(4)} (${result.changePct?.toFixed(2) ?? '—'}%)`);
      });
    }
  }

  res.json({ prices: fresh, details: priceDetails, fetched_at: new Date().toISOString(), cached_count: tickers.length - stale.length });
});

// ── FX rate lookup (USD per 1 unit of foreign currency) ──────────────────────
app.get('/api/fx-rate', async (req, res) => {
  const currency = (req.query.currency || '').toUpperCase();
  if (!currency || currency === 'USD') return res.json({ currency: 'USD', rate: 1 });
  if (!/^[A-Z]{3}$/.test(currency)) return res.status(400).json({ error: 'Invalid currency code' });
  if (demoMode) {
    const demoRates = { INR: 83.5, EUR: 0.92, GBP: 0.79, AUD: 1.53, CAD: 1.36, JPY: 149.5, SGD: 1.34, CHF: 0.9, HKD: 7.82 };
    return res.json({ currency, rate: demoRates[currency] ?? 1 });
  }
  const now = Date.now();
  const cached = fxRateCache[currency];
  if (cached && (now - cached.ts) < FX_CACHE_TTL) return res.json({ currency, rate: cached.rate });
  const rate = await fetchFxRate(currency);
  if (!rate) return res.status(502).json({ error: `Could not fetch FX rate for ${currency}` });
  fxRateCache[currency] = { rate, ts: now };
  res.json({ currency, rate });
});

// ── Gold spot price (Yahoo Finance GC=F — gold futures, USD per troy oz) ─────
let goldPriceCache = { price: null, ts: 0 };

app.get('/api/gold-price', async (req, res) => {
  if (demoMode) return res.json({ price_per_oz: 3300, source: 'demo', fetched_at: new Date().toISOString() });

  const now = Date.now();
  if (goldPriceCache.price && (now - goldPriceCache.ts) < PRICE_CACHE_TTL) {
    return res.json({ price_per_oz: goldPriceCache.price, source: 'GC=F', fetched_at: new Date(goldPriceCache.ts).toISOString(), cached: true });
  }

  try {
    let result = await fetchYahooV8('GC=F');
    if (!result) result = await fetchYahooV1('GC=F');
    if (!result) return res.status(502).json({ error: 'Could not fetch gold price from Yahoo Finance' });
    goldPriceCache = { price: result.price, ts: now };
    console.log(`[Gold] GC=F → $${result.price.toFixed(2)}/ozt`);
    res.json({ price_per_oz: result.price, source: 'GC=F', fetched_at: new Date(now).toISOString() });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// (Property estimate via Redfin/Rentcast removed — property values are entered manually)

// ── Claude / Anthropic endpoints ──────────────────────────────────────────────
app.get('/api/claude/status', (req, res) => {
  if (demoMode) return res.json({ configured: false, demo_mode: true });
  res.json({ configured: !!ANTHROPIC_API_KEY });
});

app.post('/api/claude/setup', (req, res) => {
  if (demoMode) return res.status(403).json({ error: 'Cannot configure in demo mode.' });
  const { apiKey } = req.body;
  if (!apiKey || !apiKey.startsWith('sk-ant-')) {
    return res.status(400).json({ error: 'Invalid API key format. Should start with sk-ant-' });
  }
  let existing = '';
  try { existing = fs.readFileSync(dataEnvFile, 'utf8'); } catch (_) {}
  const lines = existing.split('\n').filter(l => !/^ANTHROPIC_API_KEY\s*=/.test(l));
  lines.push(`ANTHROPIC_API_KEY=${apiKey}`);
  fs.writeFileSync(dataEnvFile, lines.join('\n') + '\n');
  ANTHROPIC_API_KEY = apiKey;
  res.json({ success: true });
});

app.post('/api/claude/chat', async (req, res) => {
  if (demoMode) return res.status(403).json({ error: 'Cannot use Claude API chat in demo mode.' });
  if (!ANTHROPIC_API_KEY) return res.status(401).json({ error: 'Claude API key not configured.' });
  const { message, portfolioData } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const systemPrompt = `You are a personal finance and investment portfolio analyst. The user is sharing their real portfolio data with you for analysis.

Portfolio Data:
${JSON.stringify(portfolioData || {}, null, 2)}

Provide clear, actionable insights. Format your response with markdown — use headers, bullet points, and bold text where helpful. Focus on what is most useful to this specific investor based on their actual holdings.`;

  try {
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const stream = anthropic.messages.stream({
      model: 'claude-opus-4-7',
      max_tokens: 2048,
      thinking: { type: 'adaptive' },
      system: systemPrompt,
      messages: [{ role: 'user', content: message }],
    });

    stream.on('text', (text) => {
      res.write(`data: ${JSON.stringify({ type: 'text', text })}\n\n`);
    });

    await stream.finalMessage();
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
    res.end();
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Net Worth Tracker  →  http://localhost:${PORT}`);
  if (demoMode) {
    console.log(`  Mode               →  🎭 DEMO  (fake data, no Plaid calls, nothing written to disk)`);
    console.log(`  To use live data   →  npm start\n`);
  } else {
    console.log(`  Mode               →  ✅ LIVE  (your real data in data/)`);
    console.log(`  Plaid environment  →  ${PLAID_ENV}`);
    if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
      console.log('\n  ⚠  Plaid credentials missing!');
      console.log('     Copy data.example/ → data/ and fill in data/.env');
      console.log('     Free signup: https://dashboard.plaid.com/signup\n');
    }
  }
});

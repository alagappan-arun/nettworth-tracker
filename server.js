const path = require('path');
const fs   = require('fs');

// ── Bootstrap: create data/ and seed .env before anything else loads ─────────
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dataEnvFile    = path.join(dataDir, '.env');
const exampleEnvFile = path.join(__dirname, 'data.example', '.env');
if (!fs.existsSync(dataEnvFile) && fs.existsSync(exampleEnvFile)) {
  fs.copyFileSync(exampleEnvFile, dataEnvFile);
  console.log('  Created data/.env from data.example/.env — fill in your Plaid credentials.');
}

// Load .env from data/ first, fall back to root .env (backwards-compatible)
require('dotenv').config({ path: dataEnvFile });
if (!process.env.PLAID_CLIENT_ID) require('dotenv').config(); // root fallback

const express = require('express');
const cors    = require('cors');
const https   = require('https');
const {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
} = require('plaid');

const app = express();
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/') {
    res.setHeader('Cache-Control', 'public, max-age=60');
  }
  next();
});
app.use(express.static(path.join(__dirname)));

// ── Plaid client ──────────────────────────────────────────────────────────────
const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID;
const PLAID_SECRET    = process.env.PLAID_SECRET;
const PLAID_ENV       = process.env.PLAID_ENV || 'sandbox';

const plaidClient = new PlaidApi(
  new Configuration({
    basePath: PlaidEnvironments[PLAID_ENV],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
        'PLAID-SECRET':    PLAID_SECRET,
      },
    },
  })
);

// ── Token persistence ─────────────────────────────────────────────────────────
const TOKENS_FILE = path.join(dataDir, 'tokens.json');
let items = [];
try {
  if (fs.existsSync(TOKENS_FILE)) items = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
} catch (_) { items = []; }
function saveItems() { fs.writeFileSync(TOKENS_FILE, JSON.stringify(items, null, 2)); }

// ── Net worth history (persisted on disk) ─────────────────────────────────────
const HISTORY_FILE = path.join(dataDir, 'history.json');
let netWorthHistory = [];
try {
  if (fs.existsSync(HISTORY_FILE)) netWorthHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
} catch (_) { netWorthHistory = []; }
function persistHistory() { fs.writeFileSync(HISTORY_FILE, JSON.stringify(netWorthHistory, null, 2)); }

// ── Manual accounts (persisted on disk) ───────────────────────────────────────
const MANUAL_FILE = path.join(dataDir, 'manual_accounts.json');
let manualAccountsDb = [];
try {
  if (fs.existsSync(MANUAL_FILE)) manualAccountsDb = JSON.parse(fs.readFileSync(MANUAL_FILE, 'utf8'));
} catch (_) { manualAccountsDb = []; }
function persistManual() { fs.writeFileSync(MANUAL_FILE, JSON.stringify(manualAccountsDb, null, 2)); }

// ── Transaction category overrides (persisted on disk) ────────────────────────
// Format: { "transaction_id": "car", "other_tx_id": "vacation", ... }
const TX_OVERRIDES_FILE = path.join(dataDir, 'tx_overrides.json');
let txOverrides = {};
try {
  if (fs.existsSync(TX_OVERRIDES_FILE)) txOverrides = JSON.parse(fs.readFileSync(TX_OVERRIDES_FILE, 'utf8'));
} catch (_) { txOverrides = {}; }
function persistOverrides() { fs.writeFileSync(TX_OVERRIDES_FILE, JSON.stringify(txOverrides, null, 2)); }

// ── Custom categories (persisted on disk) ─────────────────────────────────────
// Format: [{ key, label, icon, color }, ...]
const CUSTOM_CATS_FILE = path.join(dataDir, 'custom_categories.json');
let customCatsDb = [];
try {
  if (fs.existsSync(CUSTOM_CATS_FILE)) customCatsDb = JSON.parse(fs.readFileSync(CUSTOM_CATS_FILE, 'utf8'));
} catch (_) { customCatsDb = []; }
function persistCustomCats() { fs.writeFileSync(CUSTOM_CATS_FILE, JSON.stringify(customCatsDb, null, 2)); }

// ── Spending exclusions (persisted on disk) ───────────────────────────────────
// Format: { "transaction_id": true, ... }  — transactions the user has excluded from spending
const SPEND_EXCL_FILE = path.join(dataDir, 'spending_exclusions.json');
let spendExclDb = {};
try {
  if (fs.existsSync(SPEND_EXCL_FILE)) spendExclDb = JSON.parse(fs.readFileSync(SPEND_EXCL_FILE, 'utf8'));
} catch (_) { spendExclDb = {}; }
function persistSpendExcl() { fs.writeFileSync(SPEND_EXCL_FILE, JSON.stringify(spendExclDb, null, 2)); }

// ── CSV accounts (persisted on disk) ─────────────────────────────────────────
// Format: [{ id, name, institution, assetBucket, dataType, balance, transactions[], holdings[], securities{}, ... }]
const CSV_ACCOUNTS_FILE = path.join(dataDir, 'csv_accounts.json');
let csvAccountsDb = [];
try {
  if (fs.existsSync(CSV_ACCOUNTS_FILE)) csvAccountsDb = JSON.parse(fs.readFileSync(CSV_ACCOUNTS_FILE, 'utf8'));
} catch (_) { csvAccountsDb = []; }
function persistCsvAccounts() { fs.writeFileSync(CSV_ACCOUNTS_FILE, JSON.stringify(csvAccountsDb, null, 2)); }

// ── Cost basis overrides (persisted on disk) ──────────────────────────────────
// Format: { "VOO": 12345.67, "AAPL": 8900.00, ... }  (keyed by ticker symbol)
const COST_BASIS_FILE = path.join(dataDir, 'cost_basis_overrides.json');
let costBasisDb = {};
try {
  if (fs.existsSync(COST_BASIS_FILE)) costBasisDb = JSON.parse(fs.readFileSync(COST_BASIS_FILE, 'utf8'));
} catch (_) { costBasisDb = {}; }
function persistCostBasis() { fs.writeFileSync(COST_BASIS_FILE, JSON.stringify(costBasisDb, null, 2)); }

// ── Live price cache (in-memory, TTL 5 minutes) ───────────────────────────────
const PRICE_CACHE_TTL = 5 * 60 * 1000;
const priceCache = {}; // { "VOO": { price: 520.23, ts: 1714000000000 }, ... }

// ── Transactions cache (persisted on disk) ────────────────────────────────────
// Format: { last_synced: ISO string, transactions: [...Plaid tx objects] }
const TX_CACHE_FILE = path.join(dataDir, 'transactions_cache.json');
let txCache = { last_synced: null, transactions: [] };
try {
  if (fs.existsSync(TX_CACHE_FILE)) txCache = JSON.parse(fs.readFileSync(TX_CACHE_FILE, 'utf8'));
} catch (_) { txCache = { last_synced: null, transactions: [] }; }
function persistTxCache() { fs.writeFileSync(TX_CACHE_FILE, JSON.stringify(txCache, null, 2)); }

// ── Investments cache (persisted on disk) ─────────────────────────────────────
// Format: { last_synced: ISO string, holdings: [...], securities: {...}, needs_reconnect: [...] }
const INV_CACHE_FILE = path.join(dataDir, 'investments_cache.json');
let invCache = { last_synced: null, holdings: [], securities: {}, needs_reconnect: [] };
try {
  if (fs.existsSync(INV_CACHE_FILE)) invCache = JSON.parse(fs.readFileSync(INV_CACHE_FILE, 'utf8'));
} catch (_) { invCache = { last_synced: null, holdings: [], securities: {}, needs_reconnect: [] }; }
function persistInvCache() { fs.writeFileSync(INV_CACHE_FILE, JSON.stringify(invCache, null, 2)); }

// ── Demo mode ─────────────────────────────────────────────────────────────────
// Activated only at startup via: node server.js --demo  (or npm run demo)
// Never stored to disk — zero risk of demo data leaking into production files.
const DEMO_DATA_FILE = path.join(__dirname, 'data.example', 'demo_data.json');
const demoMode = process.argv.includes('--demo');

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
      resp.data.accounts.forEach(acc =>
        allAccounts.push({
          ...acc,
          institution_name: item.institution_name,
          institution_id:   item.institution_id,
          item_id:          item.item_id,
        })
      );
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
  const historicTxs = (txCache.transactions || []).filter(t => t.date < startDate);
  const merged = [...historicTxs, ...freshTxs];
  merged.sort((a, b) => new Date(b.date) - new Date(a.date));

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

// Remove a connected institution
app.delete('/api/items/:item_id', async (req, res) => {
  const item = items.find(i => i.item_id === req.params.item_id);
  if (item) {
    try { await plaidClient.itemRemove({ access_token: item.access_token }); } catch (_) {}
    items = items.filter(i => i.item_id !== req.params.item_id);
    saveItems();
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
  persistHistory();
  res.json({ success: true, total_snapshots: netWorthHistory.length });
});

// ── Manual accounts endpoints ─────────────────────────────────────────────────
app.get('/api/manual-accounts', (_req, res) => {
  res.json({ accounts: manualAccountsDb });
});

app.put('/api/manual-accounts', (req, res) => {
  if (demoMode) return res.json({ success: true, demo_mode: true }); // no-op in demo
  manualAccountsDb = req.body.accounts || [];
  persistManual();
  res.json({ success: true });
});

// ── CSV account endpoints ─────────────────────────────────────────────────────
app.get('/api/csv-accounts', (_req, res) => {
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
  res.json({ overrides: txOverrides });
});

app.put('/api/tx-overrides', (req, res) => {
  txOverrides = req.body.overrides || {};
  persistOverrides();
  res.json({ success: true });
});

// ── Spending exclusion endpoints ──────────────────────────────────────────────
app.get('/api/spending-exclusions', (_req, res) => res.json({ exclusions: spendExclDb }));
app.put('/api/spending-exclusions', (req, res) => {
  spendExclDb = req.body.exclusions || {};   // always update in-memory so GET returns fresh data
  if (!demoMode) persistSpendExcl();         // only write to disk in non-demo mode
  res.json({ success: true });
});

// ── Custom category endpoints ─────────────────────────────────────────────────
app.get('/api/custom-categories', (_req, res) => {
  res.json({ categories: customCatsDb });
});

app.put('/api/custom-categories', (req, res) => {
  customCatsDb = req.body.categories || [];
  persistCustomCats();
  res.json({ success: true });
});

// ── Cost basis override endpoints ─────────────────────────────────────────────
app.get('/api/cost-basis', (_req, res) => res.json({ overrides: costBasisDb }));
app.put('/api/cost-basis', (req, res) => {
  if (demoMode) return res.json({ success: true, demo_mode: true });
  costBasisDb = req.body.overrides || {};
  persistCostBasis();
  res.json({ success: true });
});

// ── Live ticker prices (Yahoo Finance unofficial API) ─────────────────────────
function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible)',
        'Accept': 'application/json',
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

app.get('/api/prices', async (req, res) => {
  const tickerParam = req.query.tickers || '';
  const raw = tickerParam.split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
  // Validate: max 100 tickers, each must be 1–10 alphanumeric chars (standard ticker format)
  const tickers = raw.filter(t => /^[A-Z0-9.\-]{1,10}$/.test(t)).slice(0, 100);
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
    try {
      const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(stale.join(','))}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent`;
      const data = await httpsGetJson(url);
      const quotes = data?.quoteResponse?.result || [];
      quotes.forEach(q => {
        const t = (q.symbol || '').toUpperCase();
        const p = q.regularMarketPrice;
        if (t && p != null) {
          priceCache[t] = {
            price:     p,
            change:    q.regularMarketChange           ?? null,
            changePct: q.regularMarketChangePercent    ?? null,
            ts:        now,
          };
          fresh[t] = p;
          priceDetails[t] = { price: p, change: priceCache[t].change, changePct: priceCache[t].changePct };
        }
      });
    } catch (err) {
      console.error('[Yahoo Finance]', err.message);
    }
  }

  res.json({ prices: fresh, details: priceDetails, fetched_at: new Date().toISOString(), cached_count: tickers.length - stale.length });
});

// (Property estimate via Redfin/Rentcast removed — property values are entered manually)

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

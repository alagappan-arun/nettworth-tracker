# 💎 Net Worth Tracker

A personal finance dashboard that runs entirely on your own computer. Connect your bank accounts, track spending by category, and watch your net worth grow over time — no cloud, no subscriptions, no ads.

![Dashboard](https://img.shields.io/badge/status-ready-brightgreen) ![Local](https://img.shields.io/badge/data-local%20only-blue) ![Free](https://img.shields.io/badge/cost-free-success)

---

## ✨ Features

**Dashboard**
- Net worth hero stat with total assets, liabilities, and account count
- Net worth trend chart over time (snapshots saved automatically)
- Asset breakdown donut chart grouped into Cash & Bank, Real Estate, Investments, and Other Assets — each with a percentage bar
- Liabilities breakdown by type

**Investments tab**
- Holdings grouped by institution then by asset type (Cash/Money Market, ETF, Stock, Fixed Income, Mutual Fund, Crypto)
- Toggle between **By Institution** and **By Ticker** views
- Institution filter pills — click any institution to narrow the view (or click an account in the sidebar to jump here pre-filtered)
- Unrealised gain/loss per holding and in aggregate (using Plaid's total cost basis)
- Cash-equivalent tickers (SGOV, JEPQ, BINC, SHV, BIL, and money market funds) automatically classified as Cash

**Spending tab**
- Monthly spending tabs — click any month to see that period
- Donut chart + category breakdown with percentage bars
- Toggle to include or exclude pending transactions
- Click any category to jump to the Transactions tab pre-filtered

**Transactions tab**
- Grouped by date with a daily spending total
- Filters: institution, category, type (spending/income), month, and amount (`50`, `20-100`, `>50`, `<100`)
- Click any category badge to reassign it — your override is saved locally and never overwritten by Plaid
- Create custom categories with your own icon and colour

**Accounts sidebar**
- Accounts grouped by institution with live balances
- Click any account to jump to the relevant tab filtered to that institution
- Connect accounts via Plaid, add manually, or upload a CSV export

**CSV Import**
- Upload a CSV export from any bank or broker — Chase, Schwab, Fidelity, BofA, Vanguard and generic formats auto-detected
- Categorise the account as Cash & Bank, Real Estate, Investments, or Other Assets on upload
- Transactions CSV: rows appear in the Transactions and Spending tabs
- Holdings CSV: rows appear in the Investments tab with gain/loss, and contribute to net worth
- Re-upload a fresh CSV at any time to refresh the data (click the ↑ icon on any CSV account in the sidebar)
- Column mapping is auto-detected and shown for manual verification before saving

**Data & sync**
- All data stored locally in `data/` — nothing sent to any external server
- Transactions and investments cached to disk; page loads are instant
- **↺ Sync** button fetches fresh data from Plaid on demand
- Transaction history accumulates over time — syncs merge the latest 90 days with your older cached data

**Other**
- Dark / light mode toggle (saved across sessions)
- Redfin property estimates — look up your home's current value by address
- Demo mode — preview with realistic fake data before connecting real accounts (see below)

---

## 🖥️ Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- A free Plaid account (see below)

To check if Node is installed:
```bash
node -v
```
If you don't see a version number, download it from [nodejs.org](https://nodejs.org/).

---

## 🚀 Quick Start

**1. Clone the repo**
```bash
git clone https://github.com/YOUR_USERNAME/nett-worth-tracker.git
cd nett-worth-tracker
```

**2. Install dependencies**
```bash
npm install
```

**3. Set up your data folder**
```bash
cp -r data.example data
```
This creates your private `data/` folder from the template. It is gitignored — your data never leaves your machine.

**4. Add your Plaid API keys**

Open `data/.env` and fill in your keys (see the Plaid section below):
```
PLAID_CLIENT_ID=your_client_id_here
PLAID_SECRET=your_secret_here
PLAID_ENV=production
PORT=3000
```

**5. Start the server**
```bash
npm start
```

**6. Open the app**

Go to [http://localhost:3000](http://localhost:3000). Click **🔗 Connect Account** to link your first bank.

---

## 🎭 Demo Mode

Want to show the app to a friend or just explore before connecting real accounts? Start in demo mode:

```bash
npm run demo
```

This loads a full set of realistic fake data (Chase checking/savings/credit, Schwab brokerage with ETF and stock holdings, a manual Fidelity 401k, 12 months of net worth history, and 40 transactions). Nothing is read from or written to your `data/` folder — the moment you stop the server, demo is completely gone.

To switch back to your real data:
```bash
npm start
```

---

## 🏦 Plaid Setup (Free — No Credit Card Required)

This app uses [Plaid](https://plaid.com/) to securely connect to your bank accounts — the same service used by Venmo, Robinhood, and Coinbase.

### Getting your free API keys

1. Sign up at [dashboard.plaid.com/signup](https://dashboard.plaid.com/signup) — free, no credit card
2. Go to **Team Settings → Keys**
3. Copy your **Client ID** and **Production Secret** into `data/.env`

### Which plan to use

Use the **Production** environment (`PLAID_ENV=production`). Plaid's free Trial tier gives you:

| Feature | Details |
|---|---|
| Cost | Free |
| Real accounts | Up to **10 connected bank accounts** |
| Environment | `production` (real data) |
| Approval | Instant — no waitlist |
| Transactions | Last 90 days on connect, ongoing after |
| Investment holdings | ✅ Included |

> **Sandbox testing:** Set `PLAID_ENV=sandbox` and use credentials `user_good` / `pass_good` in the Plaid Link dialog to test with fake data.

### Supported banks & brokerages

Plaid connects to thousands of US institutions including Chase, Bank of America, Wells Fargo, Citi, SoFi, Robinhood, Ally, Capital One, American Express, Schwab, and most credit unions.

### ⚠️ Fidelity is not supported via Plaid

Fidelity intentionally blocks third-party data aggregators. Use the **✏️ Add Manually** button to add Fidelity accounts by entering the balance directly. Manual accounts are included in all net worth calculations — just refresh the balance periodically.

---

## 📈 Investments Tab

Holdings are pulled from Plaid and grouped by institution then by type. Switch to **By Ticker** to aggregate the same security across multiple accounts.

**Asset types:**
- **Cash / Money Market** — uninvested cash (`CUR:USD`) plus cash-like ETFs: SGOV, JEPQ, BINC, SHV, BIL, and common money market fund tickers
- **ETF** — exchange-traded funds
- **Stocks** — individual equities
- **Fixed Income** — bonds
- **Mutual Fund** — mutual funds
- **Crypto** — cryptocurrency (where supported by your broker)

**Institution filter:** Click a pill button at the top to narrow the view to one institution, or click any investment account in the sidebar to jump here pre-filtered.

> If you connected a brokerage before the Investments feature was added, you may see a "Grant access" prompt — click it and complete the short Plaid consent flow to enable holdings data without disconnecting.

---

## 💳 Spending & Transactions

### Auto-categorisation

Transactions are automatically mapped to: Car, Food, Grocery, House, Insurance, Kids, Misc — based on merchant name, Plaid category data, and keyword matching.

### Overriding a category

Click any category badge on a transaction to reassign it. Your choice is saved to `data/tx_overrides.json` and will never be overwritten when Plaid refreshes.

### Custom categories

In the category picker, click **➕ Add new category** to create your own (e.g. Vacation ✈️, Pet 🐾, Gym 🏋️). Custom categories appear everywhere: spending tab, transaction filters, and the category picker.

### Filters

Combine any of: institution, category, type (spending / income), month, and amount. Amount filter supports:
- `50` — exact match (±$0.50)
- `20-100` — range
- `>50` — greater than
- `<100` — less than

### Pending transactions

The Spending tab has a toggle to include or exclude pending transactions. Pending amounts are estimates and may change, so they're excluded by default.

---

## 💾 Where Your Data Is Stored

Everything lives in `data/` — **nothing is sent to any external server**.

| File | What it contains |
|---|---|
| `data/.env` | Your Plaid API keys |
| `data/tokens.json` | Plaid access tokens for your connected banks |
| `data/history.json` | Net worth snapshots over time (the trend chart) |
| `data/manual_accounts.json` | Manually entered accounts |
| `data/tx_overrides.json` | Your manual transaction category overrides |
| `data/custom_categories.json` | Custom spending categories you've created |
| `data/transactions_cache.json` | Cached transactions — accumulates history as you sync |
| `data/investments_cache.json` | Cached investment holdings from your last sync |
| `data/csv_accounts.json` | CSV-imported accounts, transactions, and holdings |

`data/` is listed in `.gitignore` — it will never be committed to GitHub, even by accident.

To back up, copy the `data/` folder somewhere safe. To move to a new machine, copy `data/` across and run `npm install` again.

---

## 📁 Project Structure

```
nett-worth-tracker/
├── data/                 ← 🔒 YOUR private data (gitignored)
├── data.example/         ← Template — copy this to get started
│   └── demo_data.json    ← Fake data used by npm run demo
├── index.html            ← The entire frontend (single file)
├── server.js             ← Express server + Plaid + Redfin API
├── package.json
└── .gitignore
```

---

## 🛠️ Development

```bash
npm start       # start normally (live data)
npm run demo    # start in demo mode (fake data, nothing written to disk)
npm run dev     # start with auto-reload via nodemon (live data)
```

The app runs on `http://localhost:3000`. The frontend is a single `index.html` file — edit and refresh.

---

## 🔒 Security Notes

- Plaid tokens are stored in `data/tokens.json` on your local machine only
- The server runs on `localhost` — not exposed to the internet
- Never commit your `data/` folder or `.env` file to a public repo
- To revoke Plaid access for an institution, click the **✕** next to it in the sidebar

---

## 🤝 Contributing

Pull requests welcome. If you add new spending categories, cash-equivalent tickers, or bank integrations, update `data.example/` to match.

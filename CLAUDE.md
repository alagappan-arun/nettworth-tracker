# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start               # start server with live data (data/)
npm run dev             # start with auto-reload via nodemon
npm run demo            # start in demo mode (reads data.example/demo_data.json, never writes to disk)
node --test tests/logic.test.js  # run all unit tests
```

## Architecture

This is a two-file personal finance app:

- **`index.html`** — the entire frontend (single HTML file with embedded CSS and JS). All UI rendering, state management, and API calls live here.
- **`server.js`** — Express backend. Handles Plaid OAuth flow, caches Plaid responses to disk, proxies Yahoo Finance for live prices, and streams Claude AI responses.

### Data layer (`data/`)

All user data is stored as JSON files in `data/` (gitignored). The server reads them at startup into module-level variables and writes them back on mutation:

| File | In-memory var | Description |
|---|---|---|
| `tokens.json` | `items` | Plaid access tokens per institution |
| `history.json` | `netWorthHistory` | Net worth snapshots (trend chart) |
| `manual_accounts.json` | `manualAccountsDb` | Manually entered accounts |
| `tx_overrides.json` | `txOverrides` | User category overrides per transaction ID |
| `custom_categories.json` | `customCatsDb` | User-defined spending categories |
| `spending_exclusions.json` | `spendExclDb` | Per-transaction spending exclusion overrides |
| `csv_accounts.json` | `csvAccountsDb` | CSV-imported accounts with holdings/transactions |
| `cost_basis_overrides.json` | `costBasisDb` | Manual cost basis by ticker symbol |
| `transactions_cache.json` | `txCache` | Cached Plaid transactions |
| `investments_cache.json` | `invCache` | Cached Plaid holdings + securities |

**Read endpoints return the in-memory cache immediately** (no Plaid call). **Sync endpoints** (`POST /api/transactions/sync`, `POST /api/investments/sync`) fetch fresh Plaid data and overwrite the cache.

Transaction sync merges: keeps cached transactions older than the 90-day Plaid window, replaces everything within the window with fresh data to handle pending→posted transitions.

### Demo mode

Pass `--demo` flag at startup (`npm run demo`). In demo mode, all read endpoints return data from `data.example/demo_data.json`; all write endpoints are no-ops. Nothing is ever written to disk.

### Key architectural constraint: duplicated business logic

The pure functions in `tests/logic.test.js` are **inline copies** of functions defined in `index.html`. The test file comment says explicitly: *"Kept in sync with index.html — if you change the originals, update here too."*

Affected functions: `parseAmountFilter`, `txNormKey`, `isAutoExcluded`, `isTransferTx`, `isExcludedFromSpending`, `getSpendTagState`, `mapToCustomCategory`, `esc`. When editing any of these in `index.html`, mirror the change in `tests/logic.test.js`.

### Plaid credentials hot-reload

`POST /api/setup` writes credentials to `data/.env` and immediately reinitializes the Plaid client — no server restart needed.

### Live price fetching

`GET /api/prices?tickers=VOO,AAPL` fetches from Yahoo Finance v8 API (query2 host, query1 as fallback) with a 5-minute in-memory TTL (`priceCache`). Max 100 tickers per request, validated against `/^[A-Z0-9.\-]{1,10}$/`.

### Claude AI integration

`POST /api/claude/chat` streams a Server-Sent Events response using `anthropic.messages.stream` with `claude-opus-4-7` and adaptive thinking. The Anthropic API key is stored in `data/.env` and hot-reloaded via `POST /api/claude/setup`.

### Transfer/spending detection

`isTransferTx` and `isAutoExcluded` contain hardcoded carve-outs for JPMorgan Chase (mortgage payments that look like transfers) and Zelle (P2P payments that should count as spending). `OWN_ACCOUNT_MASKS` in `tests/logic.test.js` lists specific account number suffixes used to detect same-owner transfers — update both files if these change.

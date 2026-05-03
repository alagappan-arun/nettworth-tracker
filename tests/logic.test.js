/**
 * Unit tests for net-worth-tracker business logic.
 *
 * These tests cover the pure functions extracted from index.html:
 *   - parseAmountFilter
 *   - txNormKey
 *   - isAutoExcluded
 *   - isTransferTx
 *   - isExcludedFromSpending
 *   - getSpendTagState
 *   - mapToCustomCategory (keyword routing)
 *   - esc (HTML escaping helper)
 *
 * Run with:  node --test tests/logic.test.js
 */

'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ─────────────────────────────────────────────────────────────────────────────
//  Inline copies of the pure functions under test.
//  Kept in sync with index.html — if you change the originals, update here too.
// ─────────────────────────────────────────────────────────────────────────────

// ── esc ──────────────────────────────────────────────────────────────────────
const _ESC_MAP = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => _ESC_MAP[c]); }

// ── parseAmountFilter ────────────────────────────────────────────────────────
function parseAmountFilter(raw) {
  const s = raw.trim();
  if (!s) return null;
  const range = s.match(/^(\d+\.?\d*)\s*-\s*(\d+\.?\d*)$/);
  if (range) return { min: +range[1], max: +range[2] };
  const gt = s.match(/^>\s*(\d+\.?\d*)$/);
  if (gt)    return { min: +gt[1], max: Infinity };
  const lt = s.match(/^<\s*(\d+\.?\d*)$/);
  if (lt)    return { min: 0, max: +lt[1] };
  const exact = s.match(/^(\d+\.?\d*)$/);
  if (exact) { const v = +exact[1]; return { min: v - 0.50, max: v + 0.50 }; }
  return null;
}

// ── txNormKey ─────────────────────────────────────────────────────────────────
function txNormKey(t) {
  if (t.merchant_name && t.merchant_name.trim().length >= 3)
    return t.merchant_name.trim().toLowerCase();
  const raw = (t.name || '').trim();
  return raw
    .replace(/\s+\d[\d\s\-\/]{2,}$/, '')
    .replace(/\s+(ref|#|id|no\.?|ppd id)\s*\S+$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .toLowerCase();
}

// ── isAutoExcluded ────────────────────────────────────────────────────────────
function isAutoExcluded(t) {
  if (t.amount <= 0) return true;
  const name = (t.merchant_name || t.name || '').toLowerCase();
  if (name.includes('jpmorgan') || name.includes('jp morgan')) return false;
  if (name.includes('zelle')) return false;
  if (/\b(payroll|direct deposit|salary|wages|paycheck)\b/.test(name)) return true;
  if (/\bpayment\b/.test(name)) return true;
  // Chase credit card payment via SoFi ("CHASE CREDIT CRD CARDMEMBER SERV")
  if (name.includes('cardmember serv')) return true;
  if (/\b(transfer|wire transfer|ach transfer|online transfer|account transfer|funds transfer|bank transfer|interbank)\b/.test(name))
    return true;
  return false;
}

// ── isTransferTx ──────────────────────────────────────────────────────────────
const OWN_ACCOUNT_MASKS = ['1111', '2222'];

// Minimal state stub used by isTransferTx / isExcludedFromSpending
let _state = { txOverrides: {}, merchantCatRules: {}, spendingExclusions: {} };

function isTransferTx(tx) {
  if (_state.txOverrides[tx.transaction_id]) return false;
  const name = (tx.name || tx.merchant_name || '').toLowerCase();
  if (name.includes('zelle')) return false;
  if (name.includes('jpmorgan') || name.includes('jp morgan')) return false;
  const primary = (tx.personal_finance_category?.primary || '').toUpperCase();
  const leg0    = (tx.category?.[0] || '').toLowerCase();
  if (primary === 'TRANSFER_IN')  return true;
  if (primary === 'TRANSFER_OUT') return true;
  if (primary === 'INCOME')       return true;
  if (leg0 === 'transfer')        return true;
  if (OWN_ACCOUNT_MASKS.some(mask => name.includes(mask))) return true;
  if (/fidelity/i.test(tx.institution_name || '') &&
      /\b(contribution|rollover|sweep|transfer|journal|reinvest|dividend reinvest|money market)\b/.test(name)) return true;
  if (/\b(credit card payment|card payment|autopay payment)\b/.test(name)) return true;
  // SoFi → Chase credit card payment ("CHASE CREDIT CRD CARDMEMBER SERV")
  if (name.includes('cardmember serv')) return true;
  return false;
}

// ── isExcludedFromSpending ────────────────────────────────────────────────────
function isExcludedFromSpending(t) {
  const ov = _state.spendingExclusions[t.transaction_id];
  if (ov === 'spending' || ov === false)                               return false;
  if (ov === 'payment' || ov === 'deposit' || ov === 'transfer' ||
      ov === 'excluded' || ov === true)                                return true;
  return isAutoExcluded(t);
}

// ── getSpendTagState ──────────────────────────────────────────────────────────
function getSpendTagState(override, autoEx, t) {
  if (override === 'payment' || override === true)
    return { cls: 'auto-excl', text: '⊘ Payment — not spending', excluded: true };
  if (override === 'deposit')
    return { cls: 'auto-excl', text: '⊘ Income / Deposit — not spending', excluded: true };
  if (override === 'transfer')
    return { cls: 'auto-excl', text: '↔ Transfer — not spending', excluded: true };
  if (override === 'excluded')
    return { cls: 'manual-excl', text: '⊘ Excluded', excluded: true };
  if (override === 'spending' || override === false)
    return { cls: 'force-incl', text: '✓ Counting as spending', excluded: false };
  if (autoEx) {
    const isDeposit = t && t.amount <= 0;
    const isPayroll = t && /\b(payroll|direct deposit|salary|wages|paycheck)\b/.test((t.merchant_name || t.name || '').toLowerCase());
    const label = isPayroll ? 'Income / Deposit' : isDeposit ? 'Deposit' : 'Payment';
    return { cls: 'auto-excl', text: `⊘ ${label} — not spending`, excluded: true };
  }
  return { cls: 'counting', text: '✓ Counting as spending', excluded: false };
}

// ── mapToCustomCategory (keyword paths only) ──────────────────────────────────
function mapToCustomCategory(tx) {
  // Per-transaction override wins first
  if (_state.txOverrides[tx.transaction_id]) return _state.txOverrides[tx.transaction_id];
  // Sticky merchant rule wins second
  const normKey = txNormKey(tx);
  if (normKey && _state.merchantCatRules[normKey]) return _state.merchantCatRules[normKey];
  const name    = (tx.merchant_name || tx.name || '').toLowerCase();
  const primary = (tx.personal_finance_category?.primary || '').toUpperCase();
  const leg0    = (tx.category?.[0] || '').toLowerCase();

  // Car
  if (primary === 'TRANSPORTATION') return 'car';
  if (/\b(gas station|fuel|shell|chevron|bp |exxon|mobil|texaco|sunoco|marathon|valero|costco gas|parking|toll|dmv|auto repair|oil change|jiffy lube|firestone|midas|autozone|advance auto|napa auto|carmax|toyota|honda|ford|bmw|tesla|lyft|uber|zipcar|enterprise|hertz|avis)\b/.test(name)) return 'car';

  // Grocery
  if (primary === 'GROCERIES') return 'grocery';
  if (/\b(walmart|costco|target|trader joe|whole foods|kroger|safeway|albertsons|aldi|publix|heb|wegmans|meijer|stop.?shop|market basket|food lion|sprouts|fresh market|grocery|supermarket)\b/.test(name)) return 'grocery';

  // Food
  if (primary === 'FOOD_AND_DRINK') return 'food';
  if (/\b(restaurant|doordash|grubhub|uber eats|ubereats|seamless|postmates|instacart|pizza|burger|taco|sushi|mcdonald|starbucks|chipotle|dunkin|coffee|cafe|diner|bakery|sandwich|chick.?fil|domino|panera|subway|wendy|kfc|popeyes|panda express)\b/.test(name)) return 'food';

  // House
  if (['HOME_IMPROVEMENT','UTILITIES','RENT_AND_UTILITIES'].includes(primary)) return 'house';
  if (/\b(rent|mortgage|electric|water bill|gas bill|internet|cable|comcast|xfinity|spectrum|at&t|verizon home|pg&e|con ed|home depot|lowe.?s|ikea|wayfair|ace hardware|menards|plumber|electrician|hvac|pest control|hoa|jpmorgan|jp morgan)\b/.test(name)) return 'house';

  // Insurance
  if (primary === 'INSURANCE') return 'insurance';
  if (/\b(insurance|geico|allstate|state farm|progressive|liberty mutual|nationwide|farmers|usaa|aetna|cigna|unitedhealth|anthem|bcbs|blue cross|blue shield|humana|kaiser|oscar health|metlife|prudential)\b/.test(name)) return 'insurance';

  // Kids
  if (/\b(school|tuition|daycare|childcare|preschool|kindergarten|toys r us|baby|diaper|pampers|huggies|gymboree|children)\b/.test(name)) return 'kids';

  return 'misc';
}

// ─────────────────────────────────────────────────────────────────────────────
//  Test helpers
// ─────────────────────────────────────────────────────────────────────────────
function tx(overrides = {}) {
  return {
    transaction_id: 'tx_test',
    name:           'Test Transaction',
    merchant_name:  null,
    amount:         42.00,
    date:           '2026-04-01',
    pending:        false,
    personal_finance_category: null,
    category:       [],
    institution_name: 'Test Bank',
    ...overrides,
  };
}

function resetState() {
  _state = { txOverrides: {}, merchantCatRules: {}, spendingExclusions: {} };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Tests: esc()
// ─────────────────────────────────────────────────────────────────────────────
describe('esc()', () => {
  test('escapes ampersand', () => assert.equal(esc('Tom & Jerry'), 'Tom &amp; Jerry'));
  test('escapes less-than', () => assert.equal(esc('<script>'), '&lt;script&gt;'));
  test('escapes double-quote', () => assert.equal(esc('"hello"'), '&quot;hello&quot;'));
  test('escapes single-quote', () => assert.equal(esc("it's"), 'it&#39;s'));
  test('escapes combined attack vector', () =>
    assert.equal(esc('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
  test('handles null gracefully', () => assert.equal(esc(null), ''));
  test('handles undefined gracefully', () => assert.equal(esc(undefined), ''));
  test('handles numbers', () => assert.equal(esc(42), '42'));
  test('returns plain strings unchanged', () => assert.equal(esc('hello world'), 'hello world'));
});

// ─────────────────────────────────────────────────────────────────────────────
//  Tests: parseAmountFilter()
// ─────────────────────────────────────────────────────────────────────────────
describe('parseAmountFilter()', () => {
  test('empty string returns null', () => assert.equal(parseAmountFilter(''), null));
  test('whitespace returns null',   () => assert.equal(parseAmountFilter('   '), null));
  test('invalid string returns null', () => assert.equal(parseAmountFilter('abc'), null));

  test('exact amount gives ±0.50 window', () => {
    const f = parseAmountFilter('50');
    assert.equal(f.min, 49.5);
    assert.equal(f.max, 50.5);
  });

  test('exact decimal amount', () => {
    const f = parseAmountFilter('25.99');
    assert.equal(f.min, 25.49);
    assert.equal(f.max, 26.49);
  });

  test('range 20-100', () => {
    const f = parseAmountFilter('20-100');
    assert.equal(f.min, 20);
    assert.equal(f.max, 100);
  });

  test('range with spaces "20 - 100"', () => {
    const f = parseAmountFilter('20 - 100');
    assert.equal(f.min, 20);
    assert.equal(f.max, 100);
  });

  test('greater-than >50', () => {
    const f = parseAmountFilter('>50');
    assert.equal(f.min, 50);
    assert.equal(f.max, Infinity);
  });

  test('greater-than with space "> 50"', () => {
    const f = parseAmountFilter('> 50');
    assert.equal(f.min, 50);
    assert.equal(f.max, Infinity);
  });

  test('less-than <100', () => {
    const f = parseAmountFilter('<100');
    assert.equal(f.min, 0);
    assert.equal(f.max, 100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Tests: txNormKey()
// ─────────────────────────────────────────────────────────────────────────────
describe('txNormKey()', () => {
  test('uses merchant_name when >= 3 chars', () =>
    assert.equal(txNormKey({ merchant_name: 'Starbucks', name: 'STARBUCKS #1234' }), 'starbucks'));

  test('falls back to name when merchant_name is short', () =>
    assert.equal(txNormKey({ merchant_name: 'AB', name: 'PAYROLL 12345' }), 'payroll'));

  test('falls back to name when merchant_name is null', () =>
    assert.equal(txNormKey({ merchant_name: null, name: 'PAYROLL 12345' }), 'payroll'));

  test('strips trailing reference numbers from name', () =>
    assert.equal(txNormKey({ name: 'PAYROLL 12345' }), 'payroll'));

  test('strips trailing ref codes', () =>
    assert.equal(txNormKey({ name: 'ACH PAYMENT REF 9988XXYY' }), 'ach payment'));

  test('two transactions with same merchant normalise identically', () => {
    const a = { name: 'PAYROLL 0001', merchant_name: null };
    const b = { name: 'PAYROLL 9999', merchant_name: null };
    assert.equal(txNormKey(a), txNormKey(b));
  });

  test('empty name returns empty string', () =>
    assert.equal(txNormKey({ name: '', merchant_name: null }), ''));
});

// ─────────────────────────────────────────────────────────────────────────────
//  Tests: isAutoExcluded()
// ─────────────────────────────────────────────────────────────────────────────
describe('isAutoExcluded()', () => {
  test('credits (amount <= 0) are excluded', () =>
    assert.equal(isAutoExcluded(tx({ amount: -100 })), true));

  test('zero amount is excluded', () =>
    assert.equal(isAutoExcluded(tx({ amount: 0 })), true));

  test('normal debit spending is NOT excluded', () =>
    assert.equal(isAutoExcluded(tx({ amount: 45, name: 'STARBUCKS' })), false));

  test('payroll is excluded', () =>
    assert.equal(isAutoExcluded(tx({ amount: 2000, name: 'PAYROLL DIRECT DEPOSIT' })), true));

  test('direct deposit is excluded', () =>
    assert.equal(isAutoExcluded(tx({ amount: 1500, name: 'DIRECT DEPOSIT EMPLOYER' })), true));

  test('salary is excluded', () =>
    assert.equal(isAutoExcluded(tx({ amount: 5000, name: 'SALARY PAYMENT' })), true));

  test('"payment" in name is excluded', () =>
    assert.equal(isAutoExcluded(tx({ amount: 200, name: 'CREDIT CARD PAYMENT' })), true));

  test('transfer is excluded', () =>
    assert.equal(isAutoExcluded(tx({ amount: 500, name: 'ONLINE TRANSFER TO SAVINGS' })), true));

  test('ACH transfer is excluded', () =>
    assert.equal(isAutoExcluded(tx({ amount: 100, name: 'ACH TRANSFER BANK' })), true));

  // Special carve-outs
  test('Zelle is NOT auto-excluded even with "transfer" context', () =>
    assert.equal(isAutoExcluded(tx({ amount: 50, name: 'ZELLE PAYMENT TO JOHN' })), false));

  test('JPMorgan Chase is NOT auto-excluded', () =>
    assert.equal(isAutoExcluded(tx({ amount: 2300, name: 'JPMORGAN CHASE MORTGAGE' })), false));

  test('JP Morgan (with space) is NOT auto-excluded', () =>
    assert.equal(isAutoExcluded(tx({ amount: 2300, name: 'JP MORGAN CHASE' })), false));

  test('merchant_name takes priority over name for Zelle', () =>
    assert.equal(isAutoExcluded(tx({ amount: 80, merchant_name: 'Zelle', name: 'TRANSFER OUT' })), false));
});

// ─────────────────────────────────────────────────────────────────────────────
//  Tests: isTransferTx()
// ─────────────────────────────────────────────────────────────────────────────
describe('isTransferTx()', () => {
  beforeEach(resetState);

  test('TRANSFER_OUT category → hard transfer', () =>
    assert.equal(isTransferTx(tx({ personal_finance_category: { primary: 'TRANSFER_OUT' } })), true));

  test('TRANSFER_IN category → hard transfer', () =>
    assert.equal(isTransferTx(tx({ personal_finance_category: { primary: 'TRANSFER_IN' } })), true));

  test('INCOME category → hard transfer', () =>
    assert.equal(isTransferTx(tx({ personal_finance_category: { primary: 'INCOME' } })), true));

  test('Plaid legacy category[0] = "transfer" → hard transfer', () =>
    assert.equal(isTransferTx(tx({ category: ['Transfer', 'Internal Account Transfer'] })), true));

  test('own account mask in name → hard transfer', () =>
    assert.equal(isTransferTx(tx({ name: 'FROM CHECKING 1111' })), true));

  test('credit card payment keyword → hard transfer', () =>
    assert.equal(isTransferTx(tx({ name: 'AUTOPAY PAYMENT VISA' })), true));

  test('Fidelity sweep → hard transfer', () =>
    assert.equal(isTransferTx(tx({ name: 'fidelity money market sweep', institution_name: 'Fidelity' })), true));

  test('Zelle is NEVER a hard transfer', () =>
    assert.equal(isTransferTx(tx({ name: 'ZELLE PAYMENT', personal_finance_category: { primary: 'TRANSFER_OUT' } })), false));

  test('JPMorgan Chase is NEVER a hard transfer', () =>
    assert.equal(isTransferTx(tx({ name: 'JPMORGAN CHASE MORTGAGE', personal_finance_category: { primary: 'TRANSFER_OUT' } })), false));

  test('user category override bypasses hard-transfer logic', () => {
    resetState();
    _state.txOverrides['tx_test'] = 'house';
    assert.equal(isTransferTx(tx({ personal_finance_category: { primary: 'TRANSFER_OUT' } })), false);
    resetState();
  });

  test('normal grocery purchase is NOT a transfer', () =>
    assert.equal(isTransferTx(tx({ name: 'Whole Foods', amount: 85 })), false));

  test('JP Morgan (with space, no Chase) is NEVER a hard transfer', () =>
    assert.equal(isTransferTx(tx({ name: 'JP MORGAN SAVINGS', personal_finance_category: { primary: 'TRANSFER_OUT' } })), false));

  test('own account mask 2222 → hard transfer', () =>
    assert.equal(isTransferTx(tx({ name: 'TRANSFER TO SAVINGS 2222' })), true));
});

// ─────────────────────────────────────────────────────────────────────────────
//  Tests: isExcludedFromSpending()
// ─────────────────────────────────────────────────────────────────────────────
describe('isExcludedFromSpending()', () => {
  test('no override → delegates to isAutoExcluded (normal debit = not excluded)', () => {
    resetState();
    assert.equal(isExcludedFromSpending(tx({ amount: 50, name: 'Coffee' })), false);
  });

  test('no override → delegates to isAutoExcluded (deposit = excluded)', () => {
    resetState();
    assert.equal(isExcludedFromSpending(tx({ amount: -1000, name: 'Salary' })), true);
  });

  test('override="spending" forces inclusion', () => {
    resetState();
    _state.spendingExclusions['tx_test'] = 'spending';
    assert.equal(isExcludedFromSpending(tx({ amount: -100 })), false);
    resetState();
  });

  test('legacy override=false forces inclusion', () => {
    resetState();
    _state.spendingExclusions['tx_test'] = false;
    assert.equal(isExcludedFromSpending(tx({ amount: -100 })), false);
    resetState();
  });

  test('override="payment" forces exclusion', () => {
    resetState();
    _state.spendingExclusions['tx_test'] = 'payment';
    assert.equal(isExcludedFromSpending(tx({ amount: 50, name: 'Coffee' })), true);
    resetState();
  });

  test('override="deposit" forces exclusion', () => {
    resetState();
    _state.spendingExclusions['tx_test'] = 'deposit';
    assert.equal(isExcludedFromSpending(tx({ amount: 50 })), true);
    resetState();
  });

  test('override="transfer" forces exclusion', () => {
    resetState();
    _state.spendingExclusions['tx_test'] = 'transfer';
    assert.equal(isExcludedFromSpending(tx({ amount: 50 })), true);
    resetState();
  });

  test('override="excluded" forces exclusion', () => {
    resetState();
    _state.spendingExclusions['tx_test'] = 'excluded';
    assert.equal(isExcludedFromSpending(tx({ amount: 50 })), true);
    resetState();
  });

  test('legacy override=true forces exclusion', () => {
    resetState();
    _state.spendingExclusions['tx_test'] = true;
    assert.equal(isExcludedFromSpending(tx({ amount: 50, name: 'Coffee' })), true);
    resetState();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Tests: getSpendTagState()
// ─────────────────────────────────────────────────────────────────────────────
describe('getSpendTagState()', () => {
  test('override=payment → excluded pill', () => {
    const s = getSpendTagState('payment', false, tx());
    assert.equal(s.excluded, true);
    assert.ok(s.text.includes('Payment'));
  });

  test('override=deposit → excluded pill', () => {
    const s = getSpendTagState('deposit', false, tx());
    assert.equal(s.excluded, true);
    assert.ok(s.text.includes('Deposit'));
  });

  test('override=transfer → excluded pill', () => {
    const s = getSpendTagState('transfer', false, tx());
    assert.equal(s.excluded, true);
    assert.ok(s.text.includes('Transfer'));
  });

  test('override=spending → included pill', () => {
    const s = getSpendTagState('spending', false, tx());
    assert.equal(s.excluded, false);
    assert.equal(s.cls, 'force-incl');
  });

  test('legacy override=false → included pill', () => {
    const s = getSpendTagState(false, false, tx());
    assert.equal(s.excluded, false);
    assert.equal(s.cls, 'force-incl');
  });

  test('legacy override=true → excluded (payment) pill', () => {
    const s = getSpendTagState(true, false, tx());
    assert.equal(s.excluded, true);
  });

  test('no override, auto-excluded deposit → deposit label', () => {
    const s = getSpendTagState(undefined, true, tx({ amount: -100 }));
    assert.equal(s.excluded, true);
    assert.ok(s.text.includes('Deposit'));
  });

  test('no override, auto-excluded payroll → income label', () => {
    const s = getSpendTagState(undefined, true, tx({ amount: 2000, name: 'PAYROLL' }));
    assert.equal(s.excluded, true);
    assert.ok(s.text.includes('Income'));
  });

  test('no override, not auto-excluded → counting pill', () => {
    const s = getSpendTagState(undefined, false, tx({ amount: 50 }));
    assert.equal(s.excluded, false);
    assert.equal(s.cls, 'counting');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Tests: mapToCustomCategory()
// ─────────────────────────────────────────────────────────────────────────────
describe('mapToCustomCategory()', () => {
  test('user override wins over auto-detection', () => {
    resetState();
    _state.txOverrides['tx_test'] = 'kids';
    assert.equal(mapToCustomCategory(tx({ name: 'STARBUCKS' })), 'kids');
    resetState();
  });

  // Car
  test('Uber → car', () =>
    assert.equal(mapToCustomCategory(tx({ name: 'Uber' })), 'car'));
  test('Gas station → car', () =>
    assert.equal(mapToCustomCategory(tx({ name: 'Shell Gas Station' })), 'car'));
  test('TRANSPORTATION primary → car', () =>
    assert.equal(mapToCustomCategory(tx({ personal_finance_category: { primary: 'TRANSPORTATION' } })), 'car'));

  // Grocery
  test('Whole Foods → grocery', () =>
    assert.equal(mapToCustomCategory(tx({ name: 'Whole Foods' })), 'grocery'));
  test('Costco → grocery', () =>
    assert.equal(mapToCustomCategory(tx({ name: 'COSTCO WAREHOUSE' })), 'grocery'));
  test('GROCERIES primary → grocery', () =>
    assert.equal(mapToCustomCategory(tx({ personal_finance_category: { primary: 'GROCERIES' } })), 'grocery'));

  // Food
  test('Starbucks → food', () =>
    assert.equal(mapToCustomCategory(tx({ name: 'Starbucks' })), 'food'));
  test('DoorDash → food', () =>
    assert.equal(mapToCustomCategory(tx({ name: 'DOORDASH*ORDER' })), 'food'));
  test('FOOD_AND_DRINK primary → food', () =>
    assert.equal(mapToCustomCategory(tx({ personal_finance_category: { primary: 'FOOD_AND_DRINK' } })), 'food'));

  // House
  test('UTILITIES primary → house', () =>
    assert.equal(mapToCustomCategory(tx({ personal_finance_category: { primary: 'UTILITIES' } })), 'house'));
  test('rent keyword → house', () =>
    assert.equal(mapToCustomCategory(tx({ name: 'RENT PAYMENT APT 4B' })), 'house'));
  test('Comcast → house', () =>
    assert.equal(mapToCustomCategory(tx({ name: 'Comcast Cable' })), 'house'));
  test('JPMorgan Chase → house', () =>
    assert.equal(mapToCustomCategory(tx({ name: 'JPMORGAN CHASE MORTGAGE' })), 'house'));

  // Insurance
  test('GEICO → insurance', () =>
    assert.equal(mapToCustomCategory(tx({ name: 'GEICO AUTO INSURANCE' })), 'insurance'));
  test('INSURANCE primary → insurance', () =>
    assert.equal(mapToCustomCategory(tx({ personal_finance_category: { primary: 'INSURANCE' } })), 'insurance'));

  // Kids
  test('Daycare → kids', () =>
    assert.equal(mapToCustomCategory(tx({ name: 'HAPPY KIDS DAYCARE' })), 'kids'));

  // Fallback
  test('unknown merchant → misc', () =>
    assert.equal(mapToCustomCategory(tx({ name: 'RANDOM SHOP XYZ' })), 'misc'));

  // merchant_name takes priority over name for category detection
  test('merchant_name used for category lookup when set', () =>
    assert.equal(mapToCustomCategory(tx({ merchant_name: 'Starbucks', name: 'RANDOM 1234' })), 'food'));
});

// ─────────────────────────────────────────────────────────────────────────────
//  Additional edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('parseAmountFilter() — edge cases', () => {
  test('returns null for negative sign alone', () =>
    assert.equal(parseAmountFilter('-'), null));

  test('returns null for operator only', () =>
    assert.equal(parseAmountFilter('>'), null));

  test('zero exact amount', () => {
    const f = parseAmountFilter('0');
    assert.equal(f.min, -0.5);
    assert.equal(f.max, 0.5);
  });

  test('range where min equals max is valid', () => {
    const f = parseAmountFilter('50-50');
    assert.equal(f.min, 50);
    assert.equal(f.max, 50);
  });
});

describe('isAutoExcluded() — edge cases', () => {
  test('"wages" keyword is excluded', () =>
    assert.equal(isAutoExcluded(tx({ amount: 1200, name: 'WAGES EMPLOYER' })), true));

  test('"paycheck" keyword is excluded', () =>
    assert.equal(isAutoExcluded(tx({ amount: 800, name: 'PAYCHECK DEPOSIT' })), true));

  test('"interbank" keyword is excluded', () =>
    assert.equal(isAutoExcluded(tx({ amount: 500, name: 'INTERBANK WIRE' })), true));

  test('"wire transfer" keyword is excluded', () =>
    assert.equal(isAutoExcluded(tx({ amount: 5000, name: 'WIRE TRANSFER OUTBOUND' })), true));

  test('positive amount with unrelated name is not excluded', () =>
    assert.equal(isAutoExcluded(tx({ amount: 12.5, name: 'Amazon.com' })), false));
});

describe('txNormKey() — edge cases', () => {
  test('merchant_name exactly 3 chars is used', () =>
    assert.equal(txNormKey({ merchant_name: 'Heb', name: 'HEB STORE #101' }), 'heb'));

  test('merchant_name of 2 chars falls back to name', () =>
    assert.equal(txNormKey({ merchant_name: 'XY', name: 'XY STORE 12345' }), 'xy store'));

  test('name with only whitespace returns empty string', () =>
    assert.equal(txNormKey({ name: '   ', merchant_name: null }), ''));
});

describe('getSpendTagState() — edge cases', () => {
  test('override=excluded → manual-excl pill', () => {
    const s = getSpendTagState('excluded', false, tx());
    assert.equal(s.excluded, true);
    assert.equal(s.cls, 'manual-excl');
  });

  test('auto-excluded non-deposit non-payroll → Payment label', () => {
    const s = getSpendTagState(undefined, true, tx({ amount: 200, name: 'CREDIT CARD PAYMENT' }));
    assert.equal(s.excluded, true);
    assert.ok(s.text.includes('Payment'));
  });
});

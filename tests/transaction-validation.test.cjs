const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const validation = require('../transaction-validation.js');
const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
assert.ok(html.indexOf('id="reviewList"') < html.indexOf('id="dropZone"'));
assert.match(html, /Add selected transactions/);
assert.match(html, /TransactionReview\.createBackup/);
assert.match(html, /TransactionReview\.restoreBackup/);
assert.match(html, /const result = await reviewStore\.approveSelected/);
assert.match(html, /selectedSet\.has\(candidate\.id\) \? ' checked' : ''/);
assert.match(html, /saveToFirestore\(\{ throwOnFailure: true, snapshot: proposed, acceptedStateChange: true \}\)/);
assert.match(html, /async function copyBudgetsFromMonth\(\)/);
assert.match(html, /await commitAcceptedState\(proposed, previous\)/);
assert.match(html, /async function addCategory\(\)/);
assert.match(html, /getIdTokenResult\(true\)/);
assert.match(html, /loadProtectedReview/);
assert.match(html, /service\.stage\(/);
assert.match(html, /service\.edit\(/);
assert.match(html, /service\.restore\(/);
assert.match(html, /nextReview = await service\.loadReview\(\)/);
assert.match(html, /service\.reset\(/);
assert.match(html, /db\.runTransaction/);
assert.match(html, /Cloud data changed in another session/);
// Compile the actual application script as well as exercising its parser functions.
const app = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
new vm.Script(app);
const context = vm.createContext({ TransactionValidation: validation,
    accountMap: {}, getDefaultCategory: () => null, normalizeMerchant: text => text });
for (const name of ['parseBankStatement', 'parseImportData', 'parseDate', 'parseAmount']) {
    const start = app.indexOf(`        function ${name}(`);
    const end = app.indexOf('\n        function ', start + 1);
    vm.runInContext(app.slice(start, end), context);
}
assert.equal(validation.date('2/29/2024'), '2024-02-29');
for (const invalid of ['2/29/2025', '13/45/2026', '2026-04-31', '<img>', '2026-1-01']) assert.equal(validation.date(invalid), '');
assert.equal(validation.minorUnits('($1,234.56)'), -123456);
assert.equal(validation.minorUnits('0'), 0);
assert.equal(validation.minorUnits('90071992547409.91'), 9007199254740991);
assert.ok(Number.isNaN(validation.minorUnits('90071992547409.92')));
assert.ok(Number.isNaN(validation.minorUnits('9007199254740991.00')));
for (const invalid of ['', '12.34.56', 'abc', '1,23', '1.005', 'Infinity', '(-1)']) assert.ok(Number.isNaN(validation.minorUnits(invalid)), invalid);
assert.deepEqual(validation.split(-25, ['10', '15']), [-10, -15]);
assert.deepEqual(validation.split('0.30', ['0.10', '0.20']), [0.1, 0.2]);
assert.throws(() => validation.split('1', ['0.99']));
assert.throws(() => validation.split('1', ['-1']));
const rows = [['Transaction Date', 'Description', 'Amount'], ['10/01/2026', 'Expense', '-100'], ['10/02/2026', 'Refund', '25']];
const bank = name => context.parseBankStatement(rows, name, 'chase', 'CFF');
assert.equal(bank('chase.csv').transactions[0].amount, bank('renamed.csv').transactions[0].amount);
assert.equal(bank('a.csv').transactions.reduce((sum, t) => sum + t.amount, 0), 75);
assert.throws(() => context.parseBankStatement(rows, 'chase.csv'));
assert.throws(() => context.parseBankStatement([rows[0], ['13/45/2026', 'Bad', '2']], '', 'chase', 'CFF'));
assert.throws(() => context.parseBankStatement([rows[0], ['10/01/2026', 'Bad', '12.34.56']], '', 'chase', 'CFF'));
const deposit = [rows[0], ['10/01/2026', 'Remote online deposit', '25']];
assert.equal(context.parseBankStatement(deposit, '', 'chase', 'Checking Account').transactions.length, 1);
assert.equal(context.parseBankStatement(deposit, '', 'chase', 'CFF').transactions.length, 0);
const capital = [['Transaction Date', 'Description', 'Debit', 'Credit'], ['10/01/2026', 'Expense', '100', ''], ['10/02/2026', 'Refund', '', '25']];
assert.equal(context.parseBankStatement(capital, '', 'capital-one', 'Ven X').transactions.reduce((sum, t) => sum + t.amount, 0), 75);
assert.throws(() => context.parseBankStatement(capital, '', 'chase', 'CFF'));
const historical = [
    ['Expenses Budget'], ['header'],
    ['Groceries', '0', '', '', '', '', 'Expense', 'Store', 'Groceries', '100', '10/01/2026', 'CFF'],
    ['Refunds', '-25', '', '', '', '', 'Refund', 'Store', 'Groceries', '-25', '10/02/2026', 'CFF'],
];
const history = context.parseImportData(historical, 'October 2026.csv');
assert.equal(history.transactions.reduce((sum, t) => sum + t.amount, 0), 75);
assert.equal(history.budgets['2026-10'].Groceries, 0);
assert.equal(history.budgets['2026-10'].Refunds, -25);
assert.throws(() => context.parseImportData([
    ['Expenses Budget'], ['header'], ['Groceries', '0', '', '', '', '', 'Expense', 'Store', 'Groceries', '100', '13/45/2026', 'CFF'],
], 'October 2026.csv'), /Invalid historical expense row/);
const malicious = `\"><img src=x onerror=alert(1)>&'`;
let rendered = '';
const renderContext = vm.createContext({
    document: { getElementById: () => ({ set innerHTML(value) { rendered = value; } }) },
    transactions: [{ date: malicious, description: malicious, merchant: malicious, category: malicious, account: malicious, amount: 1 }],
});
vm.runInContext(app.slice(app.indexOf('        function escapeHTML'), app.indexOf("        const STORAGE_KEY")), renderContext);
vm.runInContext('function getFilteredTransactions() { return transactions; }', renderContext);
const renderStart = app.indexOf('        function renderTransactions(');
const renderEnd = app.indexOf('\n        let editingTransactionIndex', renderStart);
vm.runInContext(app.slice(renderStart, renderEnd), renderContext);
vm.runInContext('renderTransactions()', renderContext);
assert.ok(!rendered.includes('<img'));
assert.equal((rendered.match(/&lt;img/g) || []).length, 5);
assert.ok(rendered.includes('&quot;&gt;&lt;img'));
const reviewNodes = {
    reviewList: { innerHTML: '' },
    reviewStatus: { textContent: '' },
    addSelectedTransactions: { disabled: false },
    deferSelectedTransactions: { disabled: false },
    rejectSelectedTransactions: { disabled: false },
    cancelReview: { disabled: false },
};
const reviewContext = vm.createContext({
    document: {
        getElementById: id => reviewNodes[id],
        querySelectorAll: () => [{ dataset: { reviewId: 'candidate-1' } }],
    },
    bankSyncError: '',
    reviewStore: { list: () => [{ id: 'candidate-1', amount: -4.25, description: 'Coffee', date: '2026-10-01', account: 'CFF', source: 'bank-csv', category: 'Restaurants' }] },
});
vm.runInContext(app.slice(app.indexOf('        function escapeHTML'), app.indexOf("        const STORAGE_KEY")), reviewContext);
const reviewStart = app.indexOf('        function reviewSelectionIds');
const reviewEnd = app.indexOf('\n        function stageReviewTransactions', reviewStart);
vm.runInContext(app.slice(reviewStart, reviewEnd), reviewContext);
vm.runInContext('renderReviewInbox()', reviewContext);
assert.match(reviewNodes.reviewList.innerHTML, /data-review-id="candidate-1"[^>]* checked/);

// Exercise the concrete proposal/persistence path with a delayed save. The
// accepted state and browser storage remain unchanged until acknowledgement,
// and a rejected save leaves the candidate's accepted counterpart absent.
(async () => {
const persistenceStart = app.indexOf('        function addReviewCategoriesToState');
const persistenceEnd = app.indexOf('\n        function selectedReviewBudgetBatches', persistenceStart);
const persistenceContext = vm.createContext({
    categoryColorPalette: ['#3498db'],
    localStorage: { writes: [], setItem(key, value) { this.writes.push([key, value]); } },
    TRANS_DATA_KEY: 'transactions', CAT_DATA_KEY: 'categories', BUDGET_DATA_KEY: 'budgets', STORAGE_KEY: 'merchantDefaults', CAT_GROUPS_KEY: 'groups', CAT_COLORS_KEY: 'colors', CAT_ORDER_KEY: 'order',
    transactions: [{ sourceIdentity: 'old', sourceRevision: '1', date: '2026-10-01', description: 'Old', amount: -1, category: 'Old', account: 'CFF' }],
    categories: [{ name: 'Old', type: 'expense' }], budgets: {}, merchantDefaults: {}, categoryGroups: [], categoryColors: {}, categoryOrder: [],
    currentUser: { uid: 'u1' }, authGeneration: 1,
});
vm.runInContext(`let saveGateResolve; let saveGateReject; let saveCalls = 0;
function saveToFirestore(options) { saveCalls++; return new Promise((resolve, reject) => { saveGateResolve = resolve; saveGateReject = reject; }); }`, persistenceContext);
vm.runInContext(app.slice(persistenceStart, persistenceEnd), persistenceContext);
const candidate = { id: 'new@1', sourceIdentity: 'new', sourceRevision: '1', date: '2026-10-02', description: 'New', amount: -2, category: 'NewCat', account: 'CFF', payment_method: 'CFF', type: 'expense', revision: 1 };
const pendingPersist = vm.runInContext(`persistApprovedReview([${JSON.stringify(candidate)}], [], {})`, persistenceContext);
await new Promise(resolve => setImmediate(resolve));
assert.equal(vm.runInContext('transactions.length', persistenceContext), 1);
assert.equal(vm.runInContext('saveCalls', persistenceContext), 1);
vm.runInContext('saveGateResolve(true)', persistenceContext);
await pendingPersist;
assert.equal(vm.runInContext('transactions.length', persistenceContext), 2);

// Context cloning is shallow for the test objects; create a fresh VM for the
// failure case so its state and storage are independent.
const failedContext = vm.createContext({
    categoryColorPalette: ['#3498db'], localStorage: { writes: [], setItem(key, value) { this.writes.push([key, value]); } },
    TRANS_DATA_KEY: 'transactions', CAT_DATA_KEY: 'categories', BUDGET_DATA_KEY: 'budgets', STORAGE_KEY: 'merchantDefaults', CAT_GROUPS_KEY: 'groups', CAT_COLORS_KEY: 'colors', CAT_ORDER_KEY: 'order',
    transactions: [{ sourceIdentity: 'old', sourceRevision: '1', date: '2026-10-01', description: 'Old', amount: -1, category: 'Old', account: 'CFF' }], categories: [{ name: 'Old', type: 'expense' }], budgets: {}, merchantDefaults: {}, categoryGroups: [], categoryColors: {}, categoryOrder: [], currentUser: { uid: 'u1' }, authGeneration: 1,
});
vm.runInContext('function saveToFirestore() { return Promise.reject(new Error("durable failure")); }', failedContext);
vm.runInContext(app.slice(persistenceStart, persistenceEnd), failedContext);
await assert.rejects(() => vm.runInContext(`persistApprovedReview([${JSON.stringify(candidate)}], [], {})`, failedContext), /durable failure/);
assert.equal(vm.runInContext('transactions.length', failedContext), 1);

const conflictContext = vm.createContext({
    categoryColorPalette: ['#3498db'], localStorage: { writes: [], setItem() {} },
    TRANS_DATA_KEY: 'transactions', CAT_DATA_KEY: 'categories', BUDGET_DATA_KEY: 'budgets', STORAGE_KEY: 'merchantDefaults', CAT_GROUPS_KEY: 'groups', CAT_COLORS_KEY: 'colors', CAT_ORDER_KEY: 'order',
    transactions: [{ sourceIdentity: 'old', sourceRevision: '1', date: '2026-10-01', description: 'Old', amount: -1, category: 'Old', account: 'CFF' }], categories: [{ name: 'Old', type: 'expense' }], budgets: {}, merchantDefaults: {}, categoryGroups: [], categoryColors: {}, categoryOrder: [], currentUser: { uid: 'u1' }, authGeneration: 1,
});
vm.runInContext('let resolveConflictSave; function saveToFirestore() { return new Promise(resolve => { resolveConflictSave = resolve; }); }', conflictContext);
vm.runInContext(app.slice(persistenceStart, persistenceEnd), conflictContext);
const conflictPersist = vm.runInContext(`persistApprovedReview([${JSON.stringify(candidate)}], [], {})`, conflictContext);
await new Promise(resolve => setImmediate(resolve));
vm.runInContext('transactions[0].description = "concurrent edit"; resolveConflictSave(true)', conflictContext);
await assert.rejects(() => conflictPersist, /conflicted with another local change/);
assert.equal(vm.runInContext('transactions[0].description', conflictContext), 'concurrent edit');
console.log('PASS: actual application compiles; strict dates, amounts, source adapters, signed spending, deposit parity, exact signed splits, and hostile transaction rendering.');
})().catch(error => { console.error(error); process.exitCode = 1; });

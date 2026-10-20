const assert = require('node:assert/strict');
const review = require('../transaction-review.js');

const record = (overrides = {}) => ({
    date: '2026-10-01',
    description: 'Coffee Shop',
    amount: -4.25,
    category: 'Restaurants',
    merchant: 'Coffee Shop',
    account: 'CFF',
    payment_method: 'CFF',
    type: 'expense',
    ...overrides,
});

;(async () => {
const store = new review.ReviewStore();
assert.throws(() => review.normalizeCandidate(record({ date: '2026-02-30' }), 'synthetic', 0, 'invalid-date'), /real YYYY-MM-DD/);
assert.throws(() => review.normalizeCandidate(record({ amount: -1.005 }), 'synthetic', 0, 'invalid-amount'), /at most two decimal places/);
const first = store.stage([record({ sourceId: 'provider-1' })], { source: 'synthetic', batchId: 'batch-1' });
assert.equal(first.length, 1);
assert.equal(store.list().length, 1);
assert.equal(store.list()[0].status, 'pending');

// The same source revision is idempotent; a legitimate identical purchase has
// a different source identity and remains visible with an overlap flag.
assert.equal(store.stage([record({ sourceId: 'provider-1' })], { source: 'synthetic', batchId: 'retry' }).length, 0);
const second = store.stage([record({ sourceId: 'provider-2' })], { source: 'synthetic', batchId: 'batch-2' });
assert.equal(second.length, 1);
assert.deepEqual(second[0].overlap, [first[0].id]);
const fuzzyStore = new review.ReviewStore();
const csvPurchase = fuzzyStore.stage([record({ sourceId: 'csv-purchase', date: '2026-10-09', merchant: 'National Car Rental', description: 'National Car Rental', amount: -147.23 })], { source: 'bank-csv', batchId: 'fuzzy-csv' })[0];
const providerPurchase = fuzzyStore.stage([record({ sourceId: 'provider-purchase', date: '2026-10-10', merchant: 'National Car Rental VenX', description: 'NATIONAL CAR RENTAL #123', amount: -147.23 })], { source: 'bank-provider', batchId: 'fuzzy-provider' })[0];
assert.deepEqual(providerPurchase.overlap, [csvPurchase.id]);
assert.equal(providerPurchase.overlapDetails[0].dateDeltaDays, 1);
assert.equal(providerPurchase.overlapDetails[0].reason, 'nearby date and merchant tokens');
assert.equal(providerPurchase.overlapDetails[0].matched.description, 'National Car Rental');
assert.equal(fuzzyStore.stage([record({ sourceId: 'wrong-account', date: '2026-10-10', merchant: 'National Car Rental VenX', description: 'NATIONAL CAR RENTAL #123', account: 'CFU', payment_method: 'CFU', amount: -147.23 })], { source: 'bank-provider', batchId: 'wrong-account' })[0].overlap.length, 0);
assert.equal(fuzzyStore.stage([record({ sourceId: 'wrong-date', date: '2026-10-20', merchant: 'National Car Rental VenX', description: 'NATIONAL CAR RENTAL #123', amount: -147.23 })], { source: 'bank-provider', batchId: 'wrong-date' })[0].overlap.length, 0);
const recomputeCandidate = fuzzyStore.stage([record({ sourceId: 'recompute', date: '2026-10-10', merchant: 'Other Merchant', description: 'Other Merchant', amount: -147.23 })], { source: 'bank-csv', batchId: 'recompute' })[0];
assert.equal(recomputeCandidate.overlap.length, 0);
const recomputed = fuzzyStore.edit(recomputeCandidate.id, { merchant: 'National Car Rental', description: 'National Car Rental terminal' }, recomputeCandidate.revision);
assert.ok(recomputed.overlap.includes(csvPurchase.id));
assert.ok(fuzzyStore.get(providerPurchase.id).overlap.includes(recomputed.id));
const fuzzyBackup = review.createBackup({ transactions: [], categories: [{ name: 'Restaurants' }], budgets: {}, merchantDefaults: {}, review: fuzzyStore.exportReview() });
const fuzzyRestored = new review.ReviewStore();
fuzzyRestored.restoreReview(fuzzyBackup.review);
assert.equal(fuzzyRestored.get(providerPurchase.id).overlapDetails[0].matched.description, 'National Car Rental');

// Hydration upgrades an untouched legacy checking payroll row while keeping
// the provider's signed source snapshot. A later explicit expense edit is
// never reclassified by the compatibility rule, and overlap matching uses the
// corrected canonical amount.
const legacyPayroll = review.normalizeCandidate(record({
    source: 'bank-provider', sourceIdentity: 'plaid:chase:Checking:legacy-payroll', sourceRevision: '1',
    date: '2026-10-08', description: 'Employer Payroll', merchant: 'Employer Payroll',
    amount: -1250, account: 'Checking Account', payment_method: 'Checking Account', category: 'Transfer,Payroll', type: 'expense'
}), 'bank-provider', 0, 'legacy-payroll');
legacyPayroll.status = review.STATES.PENDING;
legacyPayroll.revision = 1;
legacyPayroll.reviewedRevision = 1;
legacyPayroll.sourceOriginal = { ...legacyPayroll };
delete legacyPayroll.sourceOriginal.status;
delete legacyPayroll.sourceOriginal.revision;
delete legacyPayroll.sourceOriginal.reviewedRevision;
legacyPayroll.sourceOriginal.amount = -1250;
const matchingLegacyCsv = review.normalizeCandidate(record({
    source: 'bank-csv', sourceIdentity: 'csv-payroll', sourceRevision: '1', date: '2026-10-08',
    description: 'Employer Payroll', merchant: 'Employer Payroll', amount: 1250,
    account: 'Checking Account', payment_method: 'Checking Account', category: 'Income', type: 'income'
}), 'bank-csv', 0, 'legacy-payroll-csv');
matchingLegacyCsv.status = review.STATES.PENDING;
matchingLegacyCsv.revision = 1;
matchingLegacyCsv.reviewedRevision = 1;
const reviewedExpense = review.normalizeCandidate(record({
    source: 'bank-provider', sourceIdentity: 'plaid:chase:Checking:reviewed-expense', sourceRevision: '1',
    date: '2026-10-08', description: 'Payroll reimbursement', amount: -42,
    account: 'Checking Account', payment_method: 'Checking Account', category: 'Transfer,Payroll', type: 'expense'
}), 'bank-provider', 0, 'reviewed-expense');
reviewedExpense.status = review.STATES.PENDING;
reviewedExpense.revision = 2;
reviewedExpense.reviewedRevision = 2;
reviewedExpense.sourceOriginal = { ...reviewedExpense };
const hydratedIncomeStore = new review.ReviewStore();
hydratedIncomeStore.restoreReview({ schemaVersion: review.VERSION, pending: [legacyPayroll, matchingLegacyCsv, reviewedExpense], rejected: [], accepted: [], audit: [], receipts: [], batchMeta: [] });
const hydratedPayroll = hydratedIncomeStore.get(legacyPayroll.id);
assert.deepEqual({ type: hydratedPayroll.type, amount: hydratedPayroll.amount, revision: hydratedPayroll.revision }, { type: 'income', amount: 1250, revision: 2 });
assert.equal(hydratedPayroll.sourceOriginal.amount, -1250);
assert.ok(hydratedPayroll.overlap.includes(matchingLegacyCsv.id), 'corrected income amount participates in overlap evidence');
assert.deepEqual({ type: hydratedIncomeStore.get(reviewedExpense.id).type, amount: hydratedIncomeStore.get(reviewedExpense.id).amount, revision: hydratedIncomeStore.get(reviewedExpense.id).revision }, { type: 'expense', amount: -42, revision: 2 });
const toggledReimbursement = hydratedIncomeStore.edit(legacyPayroll.id, { type: 'expense', amount: 1250 }, hydratedPayroll.revision);
assert.deepEqual({ type: toggledReimbursement.type, amount: toggledReimbursement.amount, revision: toggledReimbursement.revision }, { type: 'expense', amount: -1250, revision: 3 });
assert.equal(toggledReimbursement.sourceOriginal.amount, -1250);
const warningStore = new review.ReviewStore();
const warningRows = warningStore.stage([
    record({ sourceId: 'warning-csv', date: '2026-10-09', merchant: 'National Car Rental', description: 'National Car Rental', amount: -147.23 }),
    record({ sourceId: 'warning-provider', date: '2026-10-10', merchant: 'National Car Rental VenX', description: 'NATIONAL CAR RENTAL #123', amount: -147.23 })
], { source: 'bank-csv', batchId: 'warning-pending' });
await warningStore.approveSelected([warningRows[0].id], { online: true, authenticated: true, actor: 'reviewer@example.test', authorize: () => ({ actor: 'reviewer@example.test' }), acknowledge: () => true });
assert.equal(warningStore.get(warningRows[1].id).status, review.STATES.PENDING, 'an unselected pending overlap remains reviewable after the other row is explicitly added');
assert.equal(Object.prototype.hasOwnProperty.call(warningStore.get(warningRows[0].id), 'overlapDetails'), false, 'derived overlap evidence must not enter accepted review rows');
await assert.rejects(() => warningStore.approveSelected([warningRows[1].id], { online: true, authenticated: true, actor: 'reviewer@example.test', authorize: () => ({ actor: 'reviewer@example.test' }), acknowledge: () => true }), /Possible duplicate/);
const correction = store.stage([record({ sourceId: 'provider-2', sourceRevision: '2', amount: -4.5 })], { source: 'synthetic', batchId: 'correction' });
assert.equal(correction.length, 1);
assert.equal(store.get(second[0].id).status, 'superseded');
assert.equal(store.get(second[0].id).supersededBy, correction[0].id);

store.defer(first[0].id, 'reviewer@example.test');
assert.equal(store.get(first[0].id).status, 'deferred');
store.reject(first[0].id, 'reviewer@example.test');
assert.equal(store.get(first[0].id).status, 'rejected');
assert.equal(store.stage([record({ sourceId: 'provider-1' })], { source: 'synthetic', batchId: 'retry-2' }).length, 0);

// A revision changed after review must fail closed.
const third = store.stage([record({ sourceId: 'provider-3' })], { source: 'synthetic', batchId: 'batch-3' });
store.pending.get(third[0].id).reviewedRevision = 0;
await assert.rejects(() => store.approveSelected([third[0].id], { online: true, authenticated: true, actor: 'reviewer@example.test', authorize: () => ({ actor: 'reviewer@example.test' }), acknowledge: () => true }), /changed after review/);

let acknowledgements = 0;
const approved = await store.approveSelected([correction[0].id], {
    online: true,
    authenticated: true,
    actor: 'reviewer@example.test',
    authorize: () => ({ actor: 'reviewer@example.test' }),
    allowOverlap: true,
    idempotencyKey: 'approval-1',
    acknowledge: (payload, receipt) => {
        acknowledgements++;
        assert.equal(payload[0].sourceRevision, '2');
        assert.equal(receipt.actor, 'reviewer@example.test');
        return true;
    },
});
assert.equal(approved.accepted.length, 1);
assert.equal(acknowledgements, 1);
const retry = await store.approveSelected([correction[0].id], {
    online: true, authenticated: true, actor: 'reviewer@example.test', allowOverlap: true,
    authorize: () => ({ actor: 'reviewer@example.test' }),
    idempotencyKey: 'approval-1', acknowledge: () => { throw new Error('must be idempotent'); },
});
assert.deepEqual(retry, approved);
assert.equal(store.get(correction[0].id).status, 'approved');

await assert.rejects(() => store.approveSelected([third[0].id], { online: false, authenticated: true, actor: 'x', authorize: () => ({ actor: 'x' }), acknowledge: () => true }), /online durable service/);
await assert.rejects(() => store.approveSelected([third[0].id], { online: true, authenticated: true, actor: 'reviewer@example.test', acknowledge: () => true }), /server authorization/);
await assert.rejects(() => store.approveSelected([third[0].id], {
    online: true, authenticated: true, actor: 'reviewer@example.test', authorize: () => ({ actor: 'reviewer@example.test' }),
    idempotencyKey: 'approval-1', acknowledge: () => true,
}), /different candidate selection/);

// Candidate edits and cancellation cannot race an outstanding durable acknowledgement.
const lockedStore = new review.ReviewStore();
const locked = lockedStore.stage([record({ sourceId: 'locked' })], { source: 'synthetic', batchId: 'locked-batch' });
let releaseApproval;
const approvalGate = new Promise(resolve => { releaseApproval = resolve; });
const running = lockedStore.approveSelected([locked[0].id], {
    online: true, authenticated: true, actor: 'reviewer@example.test', authorize: () => ({ actor: 'reviewer@example.test' }),
    acknowledge: () => approvalGate,
});
await new Promise(resolve => setImmediate(resolve));
assert.throws(() => lockedStore.edit(locked[0].id, { description: 'Changed' }), /locked/);
assert.throws(() => lockedStore.cancel(), /approval is in progress/);
releaseApproval(true);
await running;
store.pending.get(third[0].id).reviewedRevision = store.pending.get(third[0].id).revision;
const failedStore = new review.ReviewStore();
const failed = failedStore.stage([record({ sourceId: 'failed-save' })], { source: 'synthetic', batchId: 'failed-batch' });
await assert.rejects(() => failedStore.approveSelected([failed[0].id], {
    online: true, authenticated: true, actor: 'reviewer@example.test', authorize: () => ({ actor: 'reviewer@example.test' }),
    acknowledge: () => { throw new Error('persistence failed'); },
}), /persistence failed/);
assert.equal(failedStore.get(failed[0].id).status, 'pending');

const sync = new review.InMemorySyncRepository();
sync.acquireLease('chase', 'run-1', { now: 100, ttlMs: 10 });
assert.throws(() => sync.acquireLease('chase', 'run-2', { now: 105, ttlMs: 10 }), /already in progress/);
sync.releaseLease('chase', 'run-1');
sync.stagePage('run-1', [{ id: 'candidate-1' }]);
assert.throws(() => sync.publishCursor('run-1', 'cursor-1', ['candidate-1', 'missing']), /all candidates/);
sync.stagePage('run-1', [{ id: 'missing' }]);
assert.equal(sync.publishCursor('run-1', 'cursor-1', ['candidate-1', 'missing']).cursor, 'cursor-1');
assert.equal(sync.publishCursor('run-1', 'cursor-1', ['candidate-1', 'missing']).cursor, 'cursor-1');
const clock = { value: 0 };
const coordinator = new review.SyncCoordinator({ cooldownMs: 100, now: () => clock.value });
assert.equal(coordinator.status().state, 'eligible');
coordinator.begin('run-a');
assert.equal(coordinator.status().state, 'in-progress');
assert.throws(() => coordinator.begin('run-b'), /already in progress/);
coordinator.finish('run-a', true);
assert.equal(coordinator.status().state, 'cooldown');
clock.value = 100;
assert.equal(coordinator.status().state, 'eligible');

const backup = review.createBackup({ transactions: [record({ amount: 0 })], categories: [{ name: 'Zero' }], budgets: { Zero: { '2026-10': -25 } }, merchantDefaults: {}, categoryGroups: ['Household'], categoryColors: { Zero: '#000000' }, categoryOrder: ['Zero'], review: store.exportReview() });
assert.equal(backup.schemaVersion, 1);
assert.equal(review.restoreBackup(backup).budgets.Zero['2026-10'], -25);
assert.deepEqual(review.restoreBackup(backup).categoryGroups, ['Household']);
assert.equal(review.restoreBackup(backup).review.receipts.length, 1);
const hydrated = new review.ReviewStore();
hydrated.restoreReview(review.restoreBackup(backup).review);
assert.equal(hydrated.get(correction[0].id).status, 'approved');
assert.equal(hydrated.exportReview().receipts.length, 1);
assert.throws(() => review.validateSnapshot({ ...backup, providerTokens: ['secret'] }), /credentials/);
assert.throws(() => review.validateSnapshot({ ...backup, transactions: [{ date: '2026-02-30', description: 'bad', amount: 1, category: 'X' }] }), /transaction/);
assert.throws(() => hydrated.restoreReview({ ...backup.review, receipts: [{ ...backup.review.receipts[0], accepted: [] }] }), /receipt candidates/);
assert.throws(() => review.restoreBackup(backup, { requireApproval: true }), /explicit approval/);
assert.equal(review.restoreBackup(backup, { requireApproval: true, approved: true }).transactions[0].amount, 0);
const legacy = review.restoreBackup({
    transactions: [record({ amount: 1.25 })], categories: [{ name: 'Legacy', type: 'expense' }],
    budgets: { Legacy: { '2026-10': 50 } }, merchantDefaults: {}
});
assert.equal(legacy.migration.migratedFrom, 'legacy-four-field-backup');
assert.equal(legacy.acceptedHistoryDateCompatibility, true);
const legacyOpaque = review.restoreBackup({
    transactions: [record({ sourceId: 'legacy-four-field-opaque', date: 'Unknown' })],
    categories: [{ name: 'Legacy', type: 'expense' }], budgets: { Legacy: { '2026-10': 50 } }, merchantDefaults: {}
}, { requireApproval: true, approved: true });
assert.deepEqual(legacyOpaque.transactions.map(transaction => transaction.date), ['Unknown']);
assert.equal(legacyOpaque.acceptedHistoryDateCompatibility, true);
assert.throws(() => review.restoreBackup({ transactions: [], categories: [], budgets: {} }), /Legacy backup/);

// Accepted history may contain opaque dates from the pre-schema backup. The
// compatibility marker is emitted only by an explicit accepted-history export,
// preserves the exact strings, and survives repeated versioned round trips.
const opaqueHistory = {
    transactions: [
        record({ sourceId: 'legacy-opaque-unknown', date: 'Unknown' }),
        record({ sourceId: 'legacy-opaque-impossible', date: '2023-02-30' })
    ],
    categories: [{ name: 'Legacy', type: 'expense' }], budgets: { Legacy: { '2026-10': 50 } }, merchantDefaults: {}
};
assert.throws(() => review.createBackup(opaqueHistory, { app: 'budget-tool' }), /accepted history/);
const historyBackup = review.createBackup(opaqueHistory, { app: 'budget-tool' }, { acceptedHistory: true });
assert.deepEqual(historyBackup.metadata.acceptedHistoryDateCompatibility, { version: 1 });
assert.throws(() => review.validateSnapshot(historyBackup), /transaction/);
const restoredHistory = review.restoreBackup(historyBackup, { requireApproval: true, approved: true });
assert.equal(restoredHistory.acceptedHistoryDateCompatibility, true);
assert.deepEqual(restoredHistory.transactions.map(transaction => transaction.date), ['Unknown', '2023-02-30']);
const repeatedHistoryBackup = review.createBackup(restoredHistory, { app: 'budget-tool' }, { acceptedHistory: true });
assert.deepEqual(repeatedHistoryBackup.transactions, historyBackup.transactions);
const serializedHistoryBackup = JSON.parse(JSON.stringify(historyBackup));
assert.deepEqual(review.restoreBackup(serializedHistoryBackup).transactions, historyBackup.transactions);
assert.deepEqual(review.restoreBackup(repeatedHistoryBackup).transactions, historyBackup.transactions);
assert.throws(() => review.restoreBackup({ ...historyBackup, metadata: { acceptedHistoryDateCompatibility: { version: 2 } } }), /compatibility marker/);
assert.throws(() => review.restoreBackup({ ...historyBackup, metadata: [] }), /metadata/);
assert.throws(() => review.createBackup(opaqueHistory, [], { acceptedHistory: true }), /metadata/);
assert.throws(() => review.createBackup({ ...opaqueHistory, transactions: [{ ...opaqueHistory.transactions[0], date: null }] }, { app: 'budget-tool' }, { acceptedHistory: true }), /transaction/);

await assert.rejects(() => new review.DisabledProviderAdapter().fetchDelta(), /not configured/);
console.log('PASS: review staging, overlap flags, rejection markers, revision-bound idempotence, cursor gating, and credential-free backup/restore contracts.');
})().catch(error => { console.error(error); process.exitCode = 1; });

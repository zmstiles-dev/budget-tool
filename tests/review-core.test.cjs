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
assert.throws(() => review.restoreBackup({ transactions: [], categories: [], budgets: {} }), /Legacy backup/);

await assert.rejects(() => new review.DisabledProviderAdapter().fetchDelta(), /not configured/);
console.log('PASS: review staging, overlap flags, rejection markers, revision-bound idempotence, cursor gating, and credential-free backup/restore contracts.');
})().catch(error => { console.error(error); process.exitCode = 1; });

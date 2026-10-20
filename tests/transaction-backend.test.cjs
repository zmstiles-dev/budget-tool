const assert = require('node:assert/strict');
const { ProtectedReviewBackend, DurableProtectedReviewBackend, FirestoreReviewRepository, FirestoreSyncRepository, BrowserApprovalClient, verifyFirebaseAuthorization, createHttpHandler, createProtectedSyncSettings, OnOpenSyncService } = require('../transaction-backend.js');
const review = require('../transaction-review.js');

const auth = { uid: 'user-1', email: 'reviewer@example.test', tokenVerified: true, householdId: 'household-1' };
const other = { uid: 'user-2', email: 'other@example.test', tokenVerified: true, householdId: 'household-1' };
const record = (overrides = {}) => ({
    date: '2026-10-01', description: 'Coffee Shop', amount: -4.25,
    category: 'Restaurants', merchant: 'Coffee Shop', account: 'CFF',
    payment_method: 'CFF', type: 'expense', ...overrides,
});

;(async () => {
const backend = new ProtectedReviewBackend({ householdId: 'household-1', allowedUsers: ['reviewer@example.test'], initialState: { categories: [{ name: 'Restaurants', type: 'expense', color: '#3498db' }] } });
await assert.rejects(() => backend.listPending({ ...auth, tokenVerified: false }), /server authorization/);
await assert.rejects(() => backend.listPending(other), /not an approved app user/);
await assert.rejects(() => backend.listPending({ ...auth, householdId: 'other-household' }), /not a member/);

const staged = await backend.stage(auth, [record({ sourceId: 'provider-1' })], { source: 'synthetic', batchId: 'batch-1' });
assert.equal(staged.candidates.length, 1);
assert.equal((await backend.listPending(auth)).length, 1);
const candidate = staged.candidates[0];
const edited = await backend.edit(auth, candidate.id, { description: 'Edited Coffee' }, candidate.revision);
assert.equal(edited.revision, candidate.revision + 1);
assert.equal(edited.sourceOriginal.description, 'Coffee Shop');
assert.equal(Object.prototype.hasOwnProperty.call(edited.sourceOriginal, 'revision'), false);
await assert.rejects(() => backend.edit(auth, candidate.id, { description: 'stale' }, candidate.revision), /changed since/);

const request = { candidateIds: [candidate.id], revisions: [edited.revision], idempotencyKey: 'approval-1' };
const approved = await backend.approve(auth, request);
assert.equal(approved.ok, true);
assert.equal(approved.accepted[0].description, 'Edited Coffee');
assert.equal((await backend.listPending(auth)).length, 0);
const retry = await backend.approve(auth, request);
assert.deepEqual(retry, approved);
await assert.rejects(() => backend.approve(auth, { ...request, candidateIds: ['other-id'] }), /already bound/);

// A legacy provider payroll row is corrected only while it is still pending.
// Hydration bumps its candidate revision, keeps the signed provider snapshot,
// and leaves accepted history empty until the reviewer explicitly approves.
const legacyHydrationBackend = new ProtectedReviewBackend({ householdId: 'household-1', allowedUsers: ['reviewer@example.test'] });
const legacyHydrationCandidate = review.normalizeCandidate(record({
    source: 'bank-provider', sourceIdentity: 'plaid:chase:Checking:legacy-payroll', sourceRevision: '1',
    date: '2026-10-08', description: 'Employer Payroll', merchant: 'Employer Payroll',
    amount: -1250, account: 'Checking Account', payment_method: 'Checking Account', category: 'Transfer,Payroll', type: 'expense'
}), 'bank-provider', 0, 'legacy-payroll');
legacyHydrationCandidate.status = review.STATES.PENDING;
legacyHydrationCandidate.revision = 1;
legacyHydrationCandidate.reviewedRevision = 1;
legacyHydrationCandidate.sourceOriginal = { ...legacyHydrationCandidate, amount: -1250 };
delete legacyHydrationCandidate.sourceOriginal.status;
delete legacyHydrationCandidate.sourceOriginal.revision;
delete legacyHydrationCandidate.sourceOriginal.reviewedRevision;
legacyHydrationBackend.restoreState({
    pending: [[legacyHydrationCandidate.id, legacyHydrationCandidate]], rejected: [], accepted: [], approvedAmendments: [], receipts: [], batchMeta: [], audit: [], revision: 0,
    state: { categories: [], budgets: {}, merchantDefaults: {}, categoryGroups: [], categoryColors: {}, categoryOrder: [] }
});
const hydratedLegacyRows = await legacyHydrationBackend.listPending(auth);
assert.deepEqual({ type: hydratedLegacyRows[0].type, amount: hydratedLegacyRows[0].amount, revision: hydratedLegacyRows[0].revision }, { type: 'income', amount: 1250, revision: 2 });
assert.equal(hydratedLegacyRows[0].sourceOriginal.amount, -1250);
assert.equal(legacyHydrationBackend.accepted.size, 0);
const editedHydrated = await legacyHydrationBackend.edit(auth, hydratedLegacyRows[0].id, { description: 'Employer Payroll verified' }, hydratedLegacyRows[0].revision);
assert.equal(editedHydrated.revision, 3);
assert.equal(editedHydrated.amount, 1250);
assert.equal(editedHydrated.sourceOriginal.amount, -1250);
const toggledHydrated = await legacyHydrationBackend.edit(auth, editedHydrated.id, { type: 'expense', amount: 1250 }, editedHydrated.revision);
assert.equal(toggledHydrated.revision, 4);
assert.equal(toggledHydrated.type, 'expense');
assert.equal(toggledHydrated.amount, -1250, 'type toggle restores the raw negative reimbursement sign');
const approvedHydrated = await legacyHydrationBackend.approve(auth, { candidateIds: [toggledHydrated.id], revisions: [toggledHydrated.revision], idempotencyKey: 'legacy-payroll-approval' });
assert.equal(approvedHydrated.accepted[0].type, 'expense');
assert.equal(approvedHydrated.accepted[0].amount, -1250);

// Imported approval budgets must reject prototype-sensitive map keys before
// touching state. Exercise all three legacy JavaScript dictionary hazards
// using own enumerable keys, including an own __proto__ data property.
for (const unsafeCategory of ['__proto__', 'constructor', 'prototype']) {
    const pollutionBackend = new ProtectedReviewBackend({ householdId: 'household-1', allowedUsers: ['reviewer@example.test'] });
    const pollutionStage = await pollutionBackend.stage(auth, [record({ sourceId: `unsafe-budget-${unsafeCategory}` })], { source: 'synthetic' });
    const values = Object.create(null);
    Object.defineProperty(values, unsafeCategory, { value: 5, enumerable: true, configurable: true, writable: true });
    const budgets = Object.create(null);
    budgets['2026-10'] = values;
    await assert.rejects(() => pollutionBackend.approve(auth, {
        candidateIds: [pollutionStage.candidates[0].id], revisions: [1], idempotencyKey: `unsafe-budget-approval-${unsafeCategory}`,
        budgetBatches: [{ ids: [pollutionStage.candidates[0].id], budgets }]
    }), /unsafe map key/);
    assert.equal(Object.prototype['2026-10'], undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, '2026-10'), false);
    assert.equal((await pollutionBackend.listPending(auth)).length, 1);
}

const approvedOverlapBackend = new ProtectedReviewBackend({ householdId: 'household-1', allowedUsers: ['reviewer@example.test'] });
const approvedOverlapStage = await approvedOverlapBackend.stage(auth, [record({ sourceId: 'approved-overlap' })], { source: 'synthetic' });
await approvedOverlapBackend.approve(auth, { candidateIds: [approvedOverlapStage.candidates[0].id], revisions: [1], idempotencyKey: 'approved-overlap-approval' });
const duplicateApproved = await approvedOverlapBackend.stage(auth, [record({ sourceId: 'duplicate-approved' })], { source: 'synthetic' });
assert.deepEqual(duplicateApproved.candidates[0].overlap, [approvedOverlapStage.candidates[0].id]);
await assert.rejects(() => approvedOverlapBackend.approve(auth, { candidateIds: [duplicateApproved.candidates[0].id], revisions: [1], idempotencyKey: 'duplicate-approved-rejected' }), /Possible duplicate/);
await approvedOverlapBackend.approve(auth, { candidateIds: [duplicateApproved.candidates[0].id], revisions: [1], idempotencyKey: 'duplicate-approved-allowed', allowOverlap: true });
assert.equal((await approvedOverlapBackend.exportState(auth)).accepted.length, 2);

const fuzzyBackend = new ProtectedReviewBackend({ householdId: 'household-1', allowedUsers: ['reviewer@example.test'] });
const fuzzyCsv = await fuzzyBackend.stage(auth, [record({ source: 'bank-csv', sourceId: 'fuzzy-csv', date: '2026-10-09', merchant: 'National Car Rental', description: 'National Car Rental', amount: -147.23 })], { source: 'bank-csv' });
await fuzzyBackend.approve(auth, { candidateIds: [fuzzyCsv.candidates[0].id], revisions: [fuzzyCsv.candidates[0].revision], idempotencyKey: 'fuzzy-csv-accepted' });
const fuzzyProvider = await fuzzyBackend.stage(auth, [record({ source: 'bank-provider', sourceId: 'fuzzy-provider', date: '2026-10-10', merchant: 'National Car Rental VenX', description: 'NATIONAL CAR RENTAL #123', amount: -147.23 })], { source: 'bank-provider', serverIngest: true });
assert.deepEqual(fuzzyProvider.candidates[0].overlap, [fuzzyCsv.candidates[0].id]);
assert.equal(fuzzyProvider.candidates[0].overlapDetails[0].matched.description, 'National Car Rental');
await assert.rejects(() => fuzzyBackend.approve(auth, { candidateIds: [fuzzyProvider.candidates[0].id], revisions: [1], idempotencyKey: 'fuzzy-provider-rejected' }), /Possible duplicate/);
await fuzzyBackend.approve(auth, { candidateIds: [fuzzyProvider.candidates[0].id], revisions: [1], idempotencyKey: 'fuzzy-provider-allowed', allowOverlap: true });
for (const [, acceptedItem] of fuzzyBackend.accepted.entries()) {
    assert.equal(Object.prototype.hasOwnProperty.call(acceptedItem, 'overlapDetails'), false, 'derived overlap evidence must not enter canonical accepted rows');
}

const settingsValues = new Map([
    ['protectedAppConfig/transactionService', { allowed: true, householdId: 'household-1', cleanupPlan: { enabled: true, targetConnectionKey: 'capital-one' }, syncActivation: { enabled: true, cutoffDate: '2026-10-09', revision: 2, connections: { chase: {}, 'capital-one': {} } } }],
    ['protectedConnections/chase', { householdId: 'household-1', ownerUid: auth.uid }],
    ['protectedConnections/capital-one', { householdId: 'household-1', ownerUid: auth.uid }]
]);
const settingsDb = {
    collection(name) { return { doc(id) { const key = `${name}/${id}`; return { key, async get() { return { exists: settingsValues.has(key), data: () => settingsValues.get(key) }; } }; } }; },
    async runTransaction(callback) {
        const tx = { get: ref => ref.get(), set: (ref, value) => settingsValues.set(ref.key, value) };
        return callback(tx);
    }
};
const syncSettings = createProtectedSyncSettings({ db: settingsDb, householdId: 'household-1', clock: () => '2026-10-20T12:00:00.000Z' });
assert.deepEqual(await syncSettings.read(auth), { ready: true, cutoffDate: '2026-10-09', revision: 2, actor: auth.uid });
const changedSettings = await syncSettings.update(auth, '2026-10-10', 2);
assert.deepEqual(changedSettings, { ok: true, cutoffDate: '2026-10-10', revision: 3 });
assert.equal(settingsValues.get('protectedAppConfig/transactionService').syncActivation.cutoffDate, '2026-10-09');
assert.deepEqual(settingsValues.get('protectedAppConfig/transactionService').cleanupPlan, { enabled: true, targetConnectionKey: 'capital-one' });
await assert.rejects(() => syncSettings.update(auth, '2026-10-09', 3), /only move forward/);
await assert.rejects(() => syncSettings.update(auth, '2026-10-21', 3), /future/);
await assert.rejects(() => syncSettings.update(auth, '2026-10-11', 2), /changed since/);
await assert.rejects(() => syncSettings.update({ ...auth, uid: 'other-user' }, '2026-10-11', 3), /not authorized for this provider connection/);
const settingsHandler = createHttpHandler({ backend: new ProtectedReviewBackend({ householdId: 'household-1', allowedUsers: ['reviewer@example.test'] }), authenticate: async () => auth, syncSettings, allowedOrigins: ['https://budget.example.test'] });
const settingsGetResponse = await new Promise(async resolve => { const output = { statusCode: 0, headers: {}, body: '', setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body || ''; resolve(this); } }; await settingsHandler({ method: 'GET', url: '/sync-settings', headers: { origin: 'https://budget.example.test' } }, output); });
assert.equal(settingsGetResponse.statusCode, 200);
assert.equal(JSON.parse(settingsGetResponse.body).cutoffDate, '2026-10-10');
settingsValues.get('protectedAppConfig/transactionService').syncSettings = { cutoffDate: 'not-a-date', revision: 4 };
await assert.rejects(() => syncSettings.read(auth), /Sync activation is not ready/);
settingsValues.get('protectedAppConfig/transactionService').syncSettings = { cutoffDate: '2026-10-10', revision: 3 };
const numericClockSettings = createProtectedSyncSettings({ db: settingsDb, householdId: 'household-1', clock: () => Date.parse('2026-10-20T12:00:00.000Z') });
assert.equal((await numericClockSettings.update(auth, '2026-10-11', 3)).revision, 4);

// Matching pending rows are also an explicit duplicate decision. Approval
// recomputes against current accepted history, rather than trusting the overlap
// index captured when the review row was staged.
const duplicatePendingBackend = new ProtectedReviewBackend({ householdId: 'household-1', allowedUsers: ['reviewer@example.test'] });
const duplicatePending = await duplicatePendingBackend.stage(auth, [record({ sourceId: 'duplicate-pending-a' }), record({ sourceId: 'duplicate-pending-b' })], { source: 'historical-csv' });
assert.equal(duplicatePending.candidates.length, 2);
await assert.rejects(() => duplicatePendingBackend.approve(auth, {
    candidateIds: duplicatePending.candidates.map(item => item.id),
    revisions: duplicatePending.candidates.map(item => item.revision),
    idempotencyKey: 'duplicate-pending-rejected'
}), /Possible duplicate/);
await duplicatePendingBackend.approve(auth, {
    candidateIds: duplicatePending.candidates.map(item => item.id),
    revisions: duplicatePending.candidates.map(item => item.revision),
    idempotencyKey: 'duplicate-pending-allowed', allowOverlap: true
});

const currentHistoryBackend = new ProtectedReviewBackend({
    householdId: 'household-1', allowedUsers: ['reviewer@example.test'],
    initialState: { transactions: [record({ sourceId: 'current-history' })] }
});
const currentHistoryStage = await currentHistoryBackend.stage(auth, [record({ sourceId: 'current-history-candidate' })], { source: 'historical-csv' });
const currentHistoryKey = [...currentHistoryBackend.accepted.keys()][0];
currentHistoryBackend.accepted.get(currentHistoryKey).amount = -99.99;
await currentHistoryBackend.approve(auth, { candidateIds: [currentHistoryStage.candidates[0].id], revisions: [currentHistoryStage.candidates[0].revision], idempotencyKey: 'current-history-approval' });
assert.equal((await currentHistoryBackend.exportState(auth)).accepted.length, 2);
const lateHistoryBackend = new ProtectedReviewBackend({
    householdId: 'household-1', allowedUsers: ['reviewer@example.test'],
    initialState: { transactions: [record({ sourceId: 'late-history', amount: -99.99 })] }
});
const lateHistoryStage = await lateHistoryBackend.stage(auth, [record({ sourceId: 'late-history-candidate' })], { source: 'historical-csv' });
const lateHistoryKey = [...lateHistoryBackend.accepted.keys()][0];
lateHistoryBackend.accepted.get(lateHistoryKey).amount = -4.25;
await assert.rejects(() => lateHistoryBackend.approve(auth, {
    candidateIds: [lateHistoryStage.candidates[0].id], revisions: [lateHistoryStage.candidates[0].revision], idempotencyKey: 'late-history-rejected'
}), /Possible duplicate/);

const legacyOverlapBackend = new ProtectedReviewBackend({
    householdId: 'household-1', allowedUsers: ['reviewer@example.test'],
    initialState: { transactions: [record({ id: undefined, sourceIdentity: undefined, sourceRevision: undefined })] }
});
const legacyOverlap = await legacyOverlapBackend.stage(auth, [record({ sourceId: 'legacy-overlap' })], { source: 'historical-csv' });
assert.deepEqual(legacyOverlap.candidates[0].overlap, ['accepted:0']);
await assert.rejects(() => legacyOverlapBackend.approve(auth, { candidateIds: [legacyOverlap.candidates[0].id], revisions: [1], idempotencyKey: 'legacy-overlap-rejected' }), /Possible duplicate/);

// Rejected source revisions stay suppressed; a source correction supersedes
// the rejected marker and keeps the source identity's revision chain.
const rejectedStage = await backend.stage(auth, [record({ sourceId: 'provider-rejected' })], { source: 'synthetic', batchId: 'batch-rejected' });
await backend.reject(auth, rejectedStage.candidates[0].id, rejectedStage.candidates[0].revision);
assert.equal((await backend.stage(auth, [record({ sourceId: 'provider-rejected' })], { source: 'synthetic', batchId: 'retry-rejected' })).candidates.length, 0);
const correctedRejected = await backend.stage(auth, [record({ sourceId: 'provider-rejected', sourceRevision: '2', amount: -5.25 })], { source: 'synthetic', batchId: 'corrected-rejected' });
assert.equal(correctedRejected.candidates[0].revision, 2);

// A tiny Firestore-shaped fake proves the durable repository calls a real
// transaction boundary and preserves canonical state across backend objects.
const firestoreValues = new Map();
let transactionCalls = 0;
const fakeDb = {
    collection(name) { return { doc(id) { const key = `${name}/${id}`; return { key, async get() { return { exists: firestoreValues.has(key), data: () => firestoreValues.get(key) }; } }; } }; },
    async runTransaction(callback) {
        transactionCalls++;
        const tx = { get: ref => ref.get(), set: (ref, value) => { firestoreValues.set(ref.key, value); } };
        return callback(tx);
    }
};
const durableRepo = new FirestoreReviewRepository({ db: fakeDb, householdId: 'household-1' });
const durable = new DurableProtectedReviewBackend({ repository: durableRepo, householdId: 'household-1', allowedUsers: ['reviewer@example.test'] });
const durableStage = await durable.stage(auth, [record({ sourceId: 'durable-1' })], { source: 'synthetic', batchId: 'durable-batch' });
assert.equal(firestoreValues.has('shared/data'), false);
assert.equal(firestoreValues.get('protectedTransactionReview/household-1').revision, durableStage.revision);
const durableApproval = await durable.approve(auth, {
    candidateIds: [durableStage.candidates[0].id], revisions: [durableStage.candidates[0].revision], idempotencyKey: 'durable-approval',
    budgetBatches: [{ ids: [durableStage.candidates[0].id], budgets: { '2026-10': { Restaurants: 125 } } }]
});
assert.equal(durableApproval.state.budgets.Restaurants['2026-10'], 125);
assert.equal((await durable.listPending(auth)).length, 0);
assert.ok(firestoreValues.has('shared/data'));
assert.deepEqual(await durable.approve(auth, { candidateIds: [durableStage.candidates[0].id], revisions: [durableStage.candidates[0].revision], idempotencyKey: 'durable-approval' }), durableApproval);
const durableReload = new DurableProtectedReviewBackend({ repository: durableRepo, householdId: 'household-1', allowedUsers: ['reviewer@example.test'] });
assert.equal((await durableReload.exportState(auth)).accepted.length, 1);
const durableBeforeSave = await durableReload.exportState(auth);
const durableCanonical = {
    transactions: durableBeforeSave.accepted.map(entry => Array.isArray(entry) ? entry[1] : entry),
    ...durableBeforeSave.state
};
await assert.rejects(() => durableReload.saveAcceptedState(auth, durableCanonical), /revision is required/);
assert.equal((await durableReload.exportState(auth)).revision, durableBeforeSave.revision);
await durableReload.stage(auth, [record({ sourceId: 'pending-after-accepted' })], { source: 'historical-csv', batchId: 'pending-after-accepted' });
assert.equal((await durableReload.exportState(auth)).revision, durableApproval.revision);
assert.ok(transactionCalls >= 2);

// Ordinary accepted-state saves use a CAS and preserve unchanged legacy rows.
// Invalid rows are consumed as a multiset so a caller cannot duplicate or
// alter one while bypassing validation. Explicit historical restore is the
// only path that accepts an opaque date string.
const legacyRow = record({ sourceId: 'legacy-invalid', date: '2023-02-30' });
const legacyBackend = new ProtectedReviewBackend({ householdId: 'household-1', allowedUsers: ['reviewer@example.test'], initialState: { transactions: [legacyRow], categories: [{ name: 'Restaurants', type: 'expense' }], budgets: {}, merchantDefaults: {}, categoryGroups: [], categoryColors: {}, categoryOrder: [] } });
const legacyBefore = await legacyBackend.exportState(auth);
const legacyCanonical = { transactions: legacyBefore.accepted.map(entry => entry[1]), ...legacyBefore.state };
assert.throws(() => legacyBackend.saveAcceptedState(auth, legacyCanonical), /revision is required/);
assert.equal((await legacyBackend.exportState(auth)).revision, legacyBefore.revision);
assert.throws(() => legacyBackend.saveAcceptedState(auth, { ...legacyCanonical, transactions: [...legacyCanonical.transactions, legacyRow] }, legacyBefore.revision), /invalid or changed/);
assert.throws(() => legacyBackend.saveAcceptedState(auth, { ...legacyCanonical, transactions: [{ ...legacyRow, date: '2023-02-31' }] }, legacyBefore.revision), /invalid or changed/);
const settingsSave = await legacyBackend.saveAcceptedState(auth, { ...legacyCanonical, budgets: { Restaurants: { '2026-10': 20 } } }, legacyBefore.revision);
assert.equal(settingsSave.ok, true);
assert.deepEqual(settingsSave.state.transactions, [legacyRow]);
assert.deepEqual(settingsSave.state.budgets, { Restaurants: { '2026-10': 20 } });
const metadataRevision = settingsSave.revision;
assert.throws(() => legacyBackend.saveAcceptedState(auth, { ...settingsSave.state, budgets: { Restaurants: { invalidMonth: 20 } } }, metadataRevision), /budgets are invalid/);
assert.throws(() => legacyBackend.saveAcceptedState(auth, { ...settingsSave.state, categoryColors: { Restaurants: 'not-a-color' } }, metadataRevision), /category colors are invalid/);
assert.throws(() => legacyBackend.saveAcceptedState(auth, { ...settingsSave.state, merchantDefaults: { accessToken: 'must-not-persist' } }, metadataRevision), /credentials or provider tokens/);
assert.equal((await legacyBackend.exportState(auth)).revision, metadataRevision);
assert.throws(() => legacyBackend.replaceAccepted(auth, legacyCanonical, settingsSave.revision), /Backup transaction 1 is invalid/);
const historicalRestore = await legacyBackend.replaceAccepted(auth, { ...legacyCanonical, acceptedHistoryDateCompatibility: true }, settingsSave.revision);
assert.equal(historicalRestore.ok, true);
assert.equal(historicalRestore.state.transactions[0].date, '2023-02-30');
assert.equal(Object.prototype.hasOwnProperty.call(historicalRestore.state, 'acceptedHistoryDateCompatibility'), false);
const validLegacyEdit = await legacyBackend.saveAcceptedState(auth, { ...legacyCanonical, transactions: [{ ...legacyRow, date: '2026-10-02' }] }, historicalRestore.revision);
assert.equal(validLegacyEdit.state.transactions[0].date, '2026-10-02');

// Legacy accepted history can remain in canonical state even when its date
// predates strict review validation. Review metadata omits that row rather
// than fabricating a date or weakening restore validation.
const unknownLegacyRow = record({ sourceIdentity: 'legacy-unknown-date', date: 'Unknown', description: 'Synthetic legacy' });
const unknownLegacyBackend = new ProtectedReviewBackend({ householdId: 'household-1', allowedUsers: ['reviewer@example.test'], initialState: { transactions: [unknownLegacyRow] } });
const unknownLegacyReview = unknownLegacyBackend.exportReviewSnapshot();
assert.equal(unknownLegacyReview.accepted.length, 0);
assert.doesNotThrow(() => review.validateReviewSnapshot(unknownLegacyReview));
assert.deepEqual((await unknownLegacyBackend.exportState(auth)).accepted[0][1], unknownLegacyRow);

// A staged provider amendment is fenced by a server-owned digest of every
// accepted target, including split children. An ordinary save that changes a
// target must force the provider observation back through staging.
const amendmentFence = new ProtectedReviewBackend({ householdId: 'household-1', allowedUsers: ['reviewer@example.test'] });
const amendmentOriginal = await amendmentFence.stage(auth, [record({ source: 'bank-provider', sourceIdentity: 'provider:fenced', sourceRevision: '1' })], { source: 'bank-provider', serverIngest: true });
await amendmentFence.approve(auth, { candidateIds: [amendmentOriginal.candidates[0].id], revisions: [1], idempotencyKey: 'fenced-original' });
const amendmentPending = await amendmentFence.stage(auth, [record({ source: 'bank-provider', sourceIdentity: 'provider:fenced', sourceRevision: '2', description: 'Provider update', amendment: 'modified' })], { source: 'bank-provider', serverIngest: true });
assert.match(amendmentPending.candidates[0].targetAcceptedDigest, /^[a-f0-9]{8,64}$/);
const amendmentBeforeSave = await amendmentFence.exportState(auth);
await amendmentFence.saveAcceptedState(auth, {
    ...amendmentBeforeSave.state,
    transactions: amendmentBeforeSave.accepted.map(entry => ({ ...(Array.isArray(entry) ? entry[1] : entry), description: 'User edit while provider review was pending' }))
}, amendmentBeforeSave.revision);
await assert.rejects(() => amendmentFence.approve(auth, {
    candidateIds: [amendmentPending.candidates[0].id], revisions: [amendmentPending.candidates[0].revision], idempotencyKey: 'fenced-stale'
}), /Amendment target changed since review/);
assert.equal((await amendmentFence.listPending(auth)).length, 1);
const amendmentRestaged = await amendmentFence.stage(auth, [record({ source: 'bank-provider', sourceIdentity: 'provider:fenced', sourceRevision: '3', description: 'Provider update after re-review', amendment: 'modified' })], { source: 'bank-provider', serverIngest: true });
await amendmentFence.approve(auth, { candidateIds: [amendmentRestaged.candidates[0].id], revisions: [amendmentRestaged.candidates[0].revision], idempotencyKey: 'fenced-restaged' });
assert.equal((await amendmentFence.exportState(auth)).accepted[0][1].description, 'Provider update after re-review');
const missingDigestBackend = new ProtectedReviewBackend({ householdId: 'household-1', allowedUsers: ['reviewer@example.test'] });
const missingDigestOriginal = await missingDigestBackend.stage(auth, [record({ source: 'bank-provider', sourceIdentity: 'provider:missing-digest', sourceRevision: '1' })], { source: 'bank-provider', serverIngest: true });
await missingDigestBackend.approve(auth, { candidateIds: [missingDigestOriginal.candidates[0].id], revisions: [1], idempotencyKey: 'missing-digest-original' });
const missingDigestPending = await missingDigestBackend.stage(auth, [record({ source: 'bank-provider', sourceIdentity: 'provider:missing-digest', sourceRevision: '2', amendment: 'modified' })], { source: 'bank-provider', serverIngest: true });
delete missingDigestBackend.pending.get(missingDigestPending.candidates[0].id).targetAcceptedDigest;
await assert.rejects(() => missingDigestBackend.approve(auth, { candidateIds: [missingDigestPending.candidates[0].id], revisions: [1], idempotencyKey: 'missing-digest-approval' }), /Amendment target changed since review/);

const splitFence = new ProtectedReviewBackend({ householdId: 'household-1', allowedUsers: ['reviewer@example.test'] });
const splitSource = await splitFence.stage(auth, [record({ source: 'bank-provider', sourceIdentity: 'provider:split-fenced', sourceRevision: '1', amount: -10 })], { source: 'bank-provider', serverIngest: true });
const splitChildren = await splitFence.split(auth, splitSource.candidates[0].id, [{ category: 'Food', amount: '4.00' }, { category: 'Other', amount: '6.00' }], splitSource.candidates[0].revision);
await splitFence.approve(auth, { candidateIds: splitChildren.candidates.map(item => item.id), revisions: splitChildren.candidates.map(item => item.revision), idempotencyKey: 'split-fenced-original', allowOverlap: true });
const splitAmendment = await splitFence.stage(auth, [record({ source: 'bank-provider', sourceIdentity: 'provider:split-fenced', sourceRevision: '2', amount: -10, amendment: 'modified' })], { source: 'bank-provider', serverIngest: true });
assert.match(splitAmendment.candidates[0].targetAcceptedDigest, /^[a-f0-9]{8,64}$/);
const splitBeforeSave = await splitFence.exportState(auth);
await splitFence.saveAcceptedState(auth, {
    ...splitBeforeSave.state,
    transactions: splitBeforeSave.accepted.map((entry, index) => ({ ...(Array.isArray(entry) ? entry[1] : entry), description: index === 0 ? 'Changed split target' : (Array.isArray(entry) ? entry[1] : entry).description }))
}, splitBeforeSave.revision);
await assert.rejects(() => splitFence.approve(auth, {
    candidateIds: [splitAmendment.candidates[0].id], revisions: [splitAmendment.candidates[0].revision], idempotencyKey: 'split-fenced-stale'
}), /Amendment target changed since review/);

const durableSync = new FirestoreSyncRepository({ db: fakeDb });
await durableSync.acquireLease('durable-connection', 'durable-run', { now: 0, ttlMs: 100 });
await durableSync.stagePage('durable-run', [{ id: 'durable-observation' }]);
await durableSync.publishCursor('durable-run', 'cursor-1', ['durable-observation'], 'durable-connection');
assert.equal((await durableSync.getCursor('durable-connection')).cursor, 'cursor-1');
await durableSync.releaseLease('durable-connection', 'durable-run');

const rules = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'firestore.rules'), 'utf8');
assert.match(rules, /match \/protectedTransactionReview\/\{householdId\}/);
assert.match(rules, /match \/protectedAcceptedTransactions\/\{householdId\}/);
assert.match(rules, /allow read, write: if false;/);
assert.match(rules, /function existingRevision\(\)/);
assert.match(rules, /'revision' in resource\.data/);
assert.match(rules, /request\.resource\.data\.revision is int/);
assert.match(rules, /request\.resource\.data\.revision == 1/);
assert.match(rules, /request\.resource\.data\.revision == existingRevision\(\) \+ 1/);
const rulesRevision = value => Object.prototype.hasOwnProperty.call(value, 'revision') ? value.revision : 0;
const allowsSettingsUpdate = (before, after) => Array.isArray(before.transactions) && Array.isArray(after.transactions) &&
    JSON.stringify(before.transactions) === JSON.stringify(after.transactions) &&
    Number.isSafeInteger(rulesRevision(before)) && rulesRevision(before) >= 0 &&
    Number.isSafeInteger(after.revision) && after.revision >= 0 &&
    after.revision === rulesRevision(before) + 1;
assert.equal(allowsSettingsUpdate({ transactions: [] }, { transactions: [], revision: 1 }), true);
assert.equal(allowsSettingsUpdate({ transactions: [], revision: 1 }, { transactions: [], revision: 1 }), false);
assert.equal(allowsSettingsUpdate({ transactions: [], revision: 1 }, { transactions: [], revision: 3 }), false);
const httpHandler = createHttpHandler({ backend, authenticate: async () => auth });
const httpResponse = { statusCode: 0, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
await httpHandler({ method: 'GET', url: '/pending', headers: {} }, httpResponse);
assert.equal(httpResponse.statusCode, 200);
assert.equal(JSON.parse(httpResponse.body).length, 1);
const acceptedStateHandler = createHttpHandler({ backend: legacyBackend, authenticate: async () => auth });
const missingRevisionResponse = { statusCode: 0, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
await acceptedStateHandler({ method: 'POST', url: '/accepted-state', headers: {}, on(event, handler) { if (event === 'data') process.nextTick(() => handler(JSON.stringify({ state: validLegacyEdit.state }))); if (event === 'end') process.nextTick(handler); } }, missingRevisionResponse);
assert.equal(missingRevisionResponse.statusCode, 409);
assert.equal((await legacyBackend.exportState(auth)).revision, validLegacyEdit.revision);
const restoreBackend = new ProtectedReviewBackend({ householdId: 'household-1', allowedUsers: ['reviewer@example.test'], initialState: { transactions: [unknownLegacyRow], categories: [{ name: 'Restaurants', type: 'expense' }], budgets: {}, merchantDefaults: {}, categoryGroups: [], categoryColors: {}, categoryOrder: [] } });
const restoreHandler = createHttpHandler({ backend: restoreBackend, authenticate: async () => auth });
const restoreResponse = { statusCode: 0, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
const restoreState = { transactions: [unknownLegacyRow], categories: [{ name: 'Restaurants', type: 'expense' }], budgets: {}, merchantDefaults: {}, categoryGroups: [], categoryColors: {}, categoryOrder: [], acceptedHistoryDateCompatibility: true };
await restoreHandler({ method: 'POST', url: '/restore', headers: {}, on(event, handler) { if (event === 'data') process.nextTick(() => handler(JSON.stringify({ state: restoreState, expectedRevision: 0 }))); if (event === 'end') process.nextTick(handler); } }, restoreResponse);
assert.equal(restoreResponse.statusCode, 200);
assert.equal(JSON.parse(restoreResponse.body).state.transactions[0].date, 'Unknown');
assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(restoreResponse.body).state, 'acceptedHistoryDateCompatibility'), false);

const structuredFailureHandler = createHttpHandler({
    backend: { async listPending() { throw new Error('provider secret must never cross the HTTP boundary'); } },
    authenticate: async () => auth,
    errorDiagnostic: () => ({ stage: 'sync', status: 503, type: 'API_ERROR', code: 'PRODUCT_NOT_READY', request_id: 'synthetic-http-diagnostic' })
});
const structuredFailureResponse = { statusCode: 0, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
await structuredFailureHandler({ method: 'GET', url: '/pending', headers: {} }, structuredFailureResponse);
const structuredFailureBody = JSON.parse(structuredFailureResponse.body);
assert.equal(structuredFailureResponse.statusCode, 500);
assert.equal(structuredFailureBody.error, 'Approval service request failed.');
assert.deepEqual(structuredFailureBody.diagnostic, { stage: 'sync', status: 503, http_status: 500, type: 'API_ERROR', code: 'PRODUCT_NOT_READY', request_id: 'synthetic-http-diagnostic' });
assert.doesNotMatch(structuredFailureResponse.body, /provider secret/);

const admin = { auth: () => ({ verifyIdToken: async (token, checkRevoked) => { assert.equal(token, 'token'); assert.equal(checkRevoked, true); return { uid: 'user-1', email: 'reviewer@example.test', email_verified: true, auth_time: 123 }; } }) };
const verified = await verifyFirebaseAuthorization({ headers: { authorization: 'Bearer token' } }, { admin, allowedUsers: ['reviewer@example.test'], householdId: 'household-1' });
assert.equal(verified.tokenVerified, true);
await assert.rejects(() => verifyFirebaseAuthorization({ headers: {} }, { admin, allowedUsers: ['reviewer@example.test'], householdId: 'household-1' }), /Bearer/);

const clientCalls = [];
const client = new BrowserApprovalClient({
    endpoint: 'https://approval.test',
    auth: { currentUser: { getIdToken: async force => { assert.equal(force, true); return 'fresh-token'; } } },
    fetch: async (url, requestOptions) => { clientCalls.push({ url, requestOptions }); return { ok: true, status: 200, json: async () => ({ ok: true, state: { transactions: [], categories: [], budgets: {}, merchantDefaults: {}, categoryGroups: [], categoryColors: {}, categoryOrder: [] } }) }; }
});
await client.approve([{ id: 'client-id', revision: 1, sourceIdentity: 'synthetic:client-id', sourceRevision: '1', source: 'synthetic', date: '2026-10-01', description: 'Client', amount: -1, account: 'CFF', payment_method: 'CFF', category: 'Restaurants', type: 'expense' }], { candidateIds: ['client-id'], revisions: [1], idempotencyKey: 'client-key' }, {});
assert.match(clientCalls[0].requestOptions.headers.Authorization, /^Bearer /);
assert.equal(JSON.parse(clientCalls[0].requestOptions.body).candidates.length, 1);
const structuredClient = new BrowserApprovalClient({
    endpoint: 'https://approval.test',
    auth: { currentUser: { getIdToken: async () => 'fresh-token' } },
    fetch: async () => ({ ok: false, status: 503, json: async () => ({ error: 'raw provider detail must not escape', diagnostic: structuredFailureBody.diagnostic }) })
});
await assert.rejects(() => structuredClient.sync('sandbox-test'), error => {
    assert.equal(error.message, 'Approval service request failed.');
    assert.deepEqual(error.diagnostic, structuredFailureBody.diagnostic);
    return true;
});

// Exercise the deployed transport contract end to end: the HTTP handler emits
// the exact cooldown message and the real browser client preserves it while
// still redacting an unknown provider failure.
const transportState = { mode: 'cooldown', settingsMessage: null };
const transportHandler = createHttpHandler({
    backend,
    authenticate: async () => auth,
    syncService: {
        async runOnOpen() {
            if (transportState.mode === 'cooldown') throw new Error('Sync is inside its cooldown window.');
            throw new Error('provider secret must remain redacted');
        }
    },
    syncSettings: {
        async update() {
            throw new Error(transportState.settingsMessage || 'provider settings detail must remain redacted');
        }
    }
});
const transportFetch = async (url, requestOptions = {}) => {
    const parsed = new URL(url);
    const request = {
        method: requestOptions.method || 'GET',
        url: parsed.pathname,
        headers: requestOptions.headers || {},
        on(event, handler) {
            if (event === 'data' && requestOptions.body) process.nextTick(() => handler(requestOptions.body));
            if (event === 'end') process.nextTick(handler);
        }
    };
    const response = { statusCode: 0, headers: {}, body: '', setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body || ''; } };
    await transportHandler(request, response);
    return { ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, json: async () => JSON.parse(response.body) };
};
const transportClient = new BrowserApprovalClient({
    endpoint: 'https://approval.test',
    auth: { currentUser: { getIdToken: async () => 'fresh-token' } },
    fetch: transportFetch
});
await assert.rejects(() => transportClient.sync('chase'), error => {
    assert.equal(error.message, 'Sync is inside its cooldown window.');
    return true;
});
transportState.mode = 'provider-error';
await assert.rejects(() => transportClient.sync('chase'), error => {
    assert.equal(error.message, 'Approval service request failed.');
    return true;
});
for (const settingsMessage of [
    'Sync activation is not ready.', 'Sync settings are not configured.',
    'Sync settings revision is required.', 'Sync settings changed since they were loaded.',
    'Cutoff date must be a real YYYY-MM-DD date.', 'Cutoff date cannot be in the future.',
    'Cutoff date can only move forward; earlier dates require an explicit backfill operation.'
]) {
    transportState.settingsMessage = settingsMessage;
    await assert.rejects(() => transportClient.updateSyncSettings('2026-10-10', 2), error => {
        assert.equal(error.message, settingsMessage);
        return true;
    });
}
transportState.settingsMessage = null;
await assert.rejects(() => transportClient.updateSyncSettings('2026-10-10', 2), error => {
    assert.equal(error.message, 'Approval service request failed.');
    return true;
});
const malformedSuccessClient = new BrowserApprovalClient({
    endpoint: 'https://approval.test',
    auth: { currentUser: { getIdToken: async () => 'fresh-token' } },
    fetch: async () => ({ ok: true, status: 200, json: async () => { throw new Error('synthetic malformed success body'); } })
});
await assert.rejects(() => malformedSuccessClient.sync('sandbox-test'), error => {
    assert.equal(error.message, 'Approval service returned an invalid response.');
    assert.deepEqual(error.diagnostic, { stage: 'backend', status: 200, code: 'BACKEND_RESPONSE_INVALID_JSON' });
    return true;
});
const malformedShapeClient = new BrowserApprovalClient({
    endpoint: 'https://approval.test',
    auth: { currentUser: { getIdToken: async () => 'fresh-token' } },
    fetch: async () => ({ ok: true, status: 200, json: async () => [] })
});
await assert.rejects(() => malformedShapeClient.sync('sandbox-test'), error => {
    assert.equal(error.diagnostic.code, 'BACKEND_RESPONSE_INVALID_JSON');
    assert.equal(error.diagnostic.status, 200);
    return true;
});
const saveClientCalls = [];
const saveClient = new BrowserApprovalClient({
    endpoint: 'https://approval.test',
    auth: { currentUser: { getIdToken: async () => 'fresh-token' } },
    fetch: async (url, requestOptions) => {
        saveClientCalls.push({ url, requestOptions });
        return { ok: true, status: 200, json: async () => ({ ok: true, revision: 1, state: { transactions: [], categories: [], budgets: {}, merchantDefaults: {}, categoryGroups: [], categoryColors: {}, categoryOrder: [] } }) };
    }
});
await saveClient.saveAcceptedState({ transactions: [], categories: [], budgets: {}, merchantDefaults: {}, categoryGroups: [], categoryColors: {}, categoryOrder: [] }, 0);
assert.equal(new URL(saveClientCalls[0].url).pathname, '/accepted-state');
assert.equal(JSON.parse(saveClientCalls[0].requestOptions.body).expectedRevision, 0);

const failedBackend = new ProtectedReviewBackend({ householdId: 'household-1', allowedUsers: ['reviewer@example.test'] });
const failedStage = await failedBackend.stage(auth, [record({ sourceId: 'provider-fail' })], { source: 'synthetic', batchId: 'batch-fail' });
await assert.rejects(() => failedBackend.approve(auth, { candidateIds: [failedStage.candidates[0].id], revisions: [1], idempotencyKey: 'fail-1', beforeCommit: () => { throw new Error('simulated persistence failure'); } }), /simulated persistence failure/);
assert.equal((await failedBackend.listPending(auth)).length, 1);

const concurrentBackend = new ProtectedReviewBackend({ householdId: 'household-1', allowedUsers: ['reviewer@example.test'] });
const concurrentStage = await concurrentBackend.stage(auth, [record({ sourceId: 'provider-concurrent' })], { source: 'synthetic', batchId: 'batch-concurrent' });
const concurrentRequest = { candidateIds: [concurrentStage.candidates[0].id], revisions: [1], idempotencyKey: 'concurrent-1' };
const [first, second] = await Promise.all([concurrentBackend.approve(auth, concurrentRequest), concurrentBackend.approve(auth, concurrentRequest)]);
assert.deepEqual(second, first);
assert.equal((await concurrentBackend.listPending(auth)).length, 0);

const disabled = new OnOpenSyncService({ enabled: false });
await assert.rejects(() => disabled.runOnOpen(auth, 'chase'), /fail-closed/);
const unowned = new OnOpenSyncService({ enabled: true, cutoverDate: '2026-01-01', provider: { fetchDelta: async () => ({ pages: [], cursor: 'never' }) } });
await assert.rejects(() => unowned.runOnOpen(auth, 'unmapped'), /ownership is not configured/);
const clock = { value: 0 };
const provider = { fetchDelta: async () => ({ pages: [{ records: [{ id: 'sync-1' }] }, { records: [{ id: 'sync-2' }] }], cursor: 'cursor-2' }) };
const sync = new OnOpenSyncService({ enabled: true, cutoverDate: '2026-01-01', provider, cooldownMs: 100, clock: () => clock.value, connectionOwners: { chase: 'user-1' } });
const synced = await sync.runOnOpen(auth, 'chase', { runId: 'run-1', cursor: 'cursor-1' });
assert.equal(synced.staged, 2);
await assert.rejects(() => sync.runOnOpen({ ...other, email: 'reviewer@example.test' }, 'chase', { runId: 'wrong-owner' }), /authorized for this provider connection|cooldown/);
await assert.rejects(() => sync.runOnOpen(auth, 'chase', { runId: 'run-2', cursor: 'cursor-2' }), /cooldown/);
let readinessCalls = 0;
let readinessOpen = true;
let readinessProviderCalls = 0;
const guardedSync = new OnOpenSyncService({
    enabled: true,
    cutoverDate: '2026-01-01',
    syncReadiness: async () => {
        readinessCalls += 1;
        return { ready: readinessOpen, cutoffDate: '2026-01-01' };
    },
    provider: { fetchDelta: async () => { readinessProviderCalls += 1; return { pages: [{ records: [] }], cursor: 'guarded-cursor' }; } },
    clock: () => 1000,
    connectionOwners: { chase: 'user-1' }
});
await guardedSync.runOnOpen(auth, 'chase', { runId: 'guarded-1' });
readinessOpen = false;
await assert.rejects(() => guardedSync.runOnOpen(auth, 'chase', { runId: 'guarded-2' }), /activation is not ready/);
assert.equal(readinessCalls, 2);
assert.equal(readinessProviderCalls, 1, 'a disabled fresh activation check must prevent provider access');
clock.value = 100;
const failedProvider = new OnOpenSyncService({ enabled: true, cutoverDate: '2026-01-01', provider: { fetchDelta: async () => { throw new Error('provider failure'); } }, clock: () => clock.value, connectionOwners: { 'cap-one': 'user-1' } });
await assert.rejects(() => failedProvider.runOnOpen(auth, 'cap-one', { runId: 'run-fail' }), /provider failure/);

console.log('PASS: protected authenticated inbox, revision-bound edits, atomic idempotent approval, failure preservation, concurrent single-flight, and fail-closed on-open sync.');
})().catch(error => { console.error(error); process.exitCode = 1; });

const assert = require('node:assert/strict');
const { ProtectedReviewBackend, DurableProtectedReviewBackend, FirestoreReviewRepository, FirestoreSyncRepository, BrowserApprovalClient, verifyFirebaseAuthorization, createHttpHandler, OnOpenSyncService } = require('../transaction-backend.js');
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
clock.value = 100;
const failedProvider = new OnOpenSyncService({ enabled: true, cutoverDate: '2026-01-01', provider: { fetchDelta: async () => { throw new Error('provider failure'); } }, clock: () => clock.value, connectionOwners: { 'cap-one': 'user-1' } });
await assert.rejects(() => failedProvider.runOnOpen(auth, 'cap-one', { runId: 'run-fail' }), /provider failure/);

console.log('PASS: protected authenticated inbox, revision-bound edits, atomic idempotent approval, failure preservation, concurrent single-flight, and fail-closed on-open sync.');
})().catch(error => { console.error(error); process.exitCode = 1; });

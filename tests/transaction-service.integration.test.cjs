const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const review = require('../transaction-review.js');
const backendApi = require('../transaction-backend.js');
const { createBudgetService } = require('../transaction-service.js');
const appConfig = require('../transaction-config.js');

const auth = { uid: 'sync-user', email: 'reviewer@example.test', tokenVerified: true, householdId: 'household-1' };
const candidate = (overrides = {}) => ({
    date: '2026-10-10', description: 'Provider purchase', amount: -12.34,
    category: 'Restaurants', account: 'Checking Account', payment_method: 'Checking Account', type: 'expense', ...overrides
});

function fakeFirestore() {
    const values = new Map();
    return {
        values,
        collection(name) { return { doc(id) { const key = `${name}/${id}`; return { key, async get() { return { exists: values.has(key), data: () => values.get(key) }; } }; } }; },
        async runTransaction(callback) {
            const writes = [];
            const tx = { get: ref => ref.get(), set: (ref, value) => writes.push([ref, value]) };
            const result = await callback(tx);
            writes.forEach(([ref, value]) => values.set(ref.key, value));
            return result;
        }
    };
}

function request(method, url, body, origin) {
    const requestObject = new EventEmitter();
    requestObject.method = method;
    requestObject.url = url;
    requestObject.headers = origin ? { origin } : {};
    if (method !== 'GET' && method !== 'OPTIONS') process.nextTick(() => { requestObject.emit('data', JSON.stringify(body || {})); requestObject.emit('end'); });
    return requestObject;
}

function response() {
    return { statusCode: 0, headers: {}, body: '', setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body || ''; } };
}

;(async () => {
    const db = fakeFirestore();
    const repository = new backendApi.FirestoreReviewRepository({ db, householdId: 'household-1' });
    const protectedBackend = new backendApi.DurableProtectedReviewBackend({ repository, householdId: 'household-1', allowedUsers: [auth.email] });
    const staged = await protectedBackend.stage(auth, [candidate({ sourceId: 'reloadable' })], { source: 'bank-csv', batchId: 'reload-batch', batchMeta: { budgets: { '2026-10': { Restaurants: 90 } } } });
    await protectedBackend.approve(auth, { candidateIds: [staged.candidates[0].id], revisions: [staged.candidates[0].revision], idempotencyKey: 'reload-approval' });
    const reviewSnapshot = await protectedBackend.exportReview(auth);
    review.validateReviewSnapshot(reviewSnapshot);
    const hydrated = new review.ReviewStore();
    hydrated.restoreReview(reviewSnapshot);
    assert.equal(hydrated.exportReview().accepted.length, 1);
    assert.equal(reviewSnapshot.receipts.length, 1);

    const syncRepository = new review.InMemorySyncRepository({ cooldownMs: 100 });
    let providerCalls = 0;
    const provider = { fetchDelta: async () => { providerCalls += 1; return { pages: [{ records: [{ ...candidate({ sourceIdentity: 'plaid:1', sourceRevision: '1', id: 'plaid:1@1' }) }] }], cursor: 'cursor-1' }; } };
    const sync1 = new backendApi.OnOpenSyncService({ enabled: true, cutoverDate: '2026-01-01', provider, repository: syncRepository, reviewBackend: protectedBackend, connectionOwners: { chase: auth.uid }, cooldownMs: 100, clock: () => 0 });
    const sync2 = new backendApi.OnOpenSyncService({ enabled: true, cutoverDate: '2026-01-01', provider, repository: syncRepository, reviewBackend: protectedBackend, connectionOwners: { chase: auth.uid }, cooldownMs: 100, clock: () => 1 });
    const syncResult = await sync1.runOnOpen(auth, 'chase');
    assert.equal(syncResult.staged, 1);
    assert.equal((await protectedBackend.listPending(auth)).length, 1);
    await assert.rejects(() => sync2.runOnOpen(auth, 'chase'), /cooldown/);
    assert.equal(providerCalls, 1);

    const stale = new review.InMemorySyncRepository({ cooldownMs: 0 });
    await stale.acquireLease('chase', 'stale-run', { now: 0, ttlMs: 10 });
    stale.stagePage('stale-run', [{ id: 'stale-id' }]);
    assert.throws(() => stale.publishCursor('stale-run', 'cursor', ['stale-id'], 'chase', { now: 11 }), /expired/);

    const plaidCalls = [];
    const plaid = new backendApi.PlaidTransactionsSyncAdapter({
        client: { sync: async requestBody => {
            plaidCalls.push(requestBody.cursor || '');
            if (plaidCalls.length === 1) throw { response: { data: { error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' } } };
            if (plaidCalls.length === 2) return { added: [{ transaction_id: 'p1', date: '2026-10-01', amount: 3.25, account_id: 'Checking', currency_code: 'USD', name: 'Coffee' }], modified: [], removed: [], has_more: true, next_cursor: 'page-1' };
            return { added: [], modified: [], removed: [{ transaction_id: 'p2', date: '2026-10-02', amount: 8, account_id: 'Checking', currency_code: 'USD', name: 'Old shop' }], has_more: false, next_cursor: 'page-2' };
        } }, accountMap: { Checking: 'Checking Account' }, maxPages: 3, maxRetries: 0
    });
    const plaidResult = await plaid.fetchDelta({ accessToken: 'injected-test-token', cursor: 'start' });
    assert.deepEqual(plaidCalls, ['start', 'start', 'page-1']);
    assert.equal(plaidResult.pages.flatMap(page => page.records).length, 2);
    assert.equal(plaidResult.pages[1].records[0].amendment, 'removed');

    const signed = new backendApi.PlaidTransactionsSyncAdapter({
        accountMap: { Checking: 'Checking Account' },
        client: { sync: async () => ({ added: [{ transaction_id: 'expense', date: '2026-10-01', amount: 100, account_id: 'Checking', currency_code: 'USD', name: 'Expense' }], modified: [], removed: [{ transaction_id: 'refund', date: '2026-10-02', amount: -25, account_id: 'Checking', currency_code: 'USD', name: 'Refund' }], has_more: false, next_cursor: 'signed-cursor' }) }
    });
    const signedRecords = (await signed.fetchDelta({ accessToken: 'test', cursor: '', connectionKey: 'chase' })).pages[0].records;
    assert.equal(signedRecords.reduce((sum, item) => sum + item.amount, 0), 75);
    assert.equal(signedRecords[0].type, 'expense');
    assert.equal(signedRecords[1].type, 'expense');
    assert.equal(signedRecords.filter(item => item.type === 'expense').reduce((sum, item) => sum + item.amount, 0), 75);
    const unknownPlaidAccount = new backendApi.PlaidTransactionsSyncAdapter({
        accountMap: { Checking: 'Checking Account' },
        client: { sync: async () => ({ added: [{ transaction_id: 'unknown-account', date: '2026-10-01', amount: 1, account_id: 'NotMapped', currency_code: 'USD', name: 'Unknown account' }], modified: [], removed: [], has_more: false, next_cursor: 'unknown-account-cursor' }) }
    });
    await assert.rejects(() => unknownPlaidAccount.fetchDelta({ accessToken: 'test', cursor: '', connectionKey: 'chase' }), /account is not mapped/);
    const classifiedIncome = new backendApi.PlaidTransactionsSyncAdapter({
        accountMap: { Checking: 'Checking Account' }, classify: ({ id }) => id === 'income' ? 'income' : '',
        client: { sync: async () => ({ added: [{ transaction_id: 'income', date: '2026-10-01', amount: -25, account_id: 'Checking', currency_code: 'USD', name: 'Pay' }], modified: [], removed: [], has_more: false, next_cursor: 'classified-cursor' }) }
    });
    assert.equal((await classifiedIncome.fetchDelta({ accessToken: 'test', cursor: '', connectionKey: 'chase' })).pages[0].records[0].type, 'income');
    const sourceRevisionAdapter = amount => new backendApi.PlaidTransactionsSyncAdapter({
        accountMap: { Checking: 'Renamed display account' },
        client: { sync: async () => ({ added: [{ transaction_id: 'same-day', date: '2026-10-01', date_modified: '2026-10-17T12:00:00Z', amount, account_id: 'Checking', currency_code: 'USD', name: 'Same day change' }], modified: [], removed: [], has_more: false, next_cursor: `revision-${amount}` }) }
    });
    const firstObservation = (await sourceRevisionAdapter(100).fetchDelta({ accessToken: 'test', cursor: '', connectionKey: 'chase' })).pages[0].records[0];
    const changedObservation = (await sourceRevisionAdapter(101).fetchDelta({ accessToken: 'test', cursor: '', connectionKey: 'chase' })).pages[0].records[0];
    assert.equal(firstObservation.sourceIdentity, changedObservation.sourceIdentity);
    assert.notEqual(firstObservation.sourceRevision, changedObservation.sourceRevision);

    const defaultCutoffProvider = () => new backendApi.PlaidTransactionsSyncAdapter({
        accountMap: { Checking: 'Checking Account' },
        client: { sync: async () => ({
            added: [
                { transaction_id: 'default-08', date: '2026-10-08', amount: 8, account_id: 'Checking', currency_code: 'USD', name: 'Before default cutoff' },
                { transaction_id: 'default-09', date: '2026-10-09', amount: 9, account_id: 'Checking', currency_code: 'USD', name: 'On default cutoff' },
                { transaction_id: 'default-10', date: '2026-10-10', amount: 10, account_id: 'Checking', currency_code: 'USD', name: 'After default cutoff' }
            ],
            modified: [], removed: [], has_more: false, next_cursor: 'default-cutoff-cursor'
        }) }
    });
    const directDefaultCutoff = await defaultCutoffProvider().fetchDelta({ accessToken: 'test', cursor: '', connectionKey: 'chase', cutoverDate: appConfig.FIRST_SYNC_CUTOVER_DATE });
    assert.deepEqual(directDefaultCutoff.counts, { rawObservations: 3, skippedObservations: 0, cutoffExcluded: 1, resultingRecords: 2 });
    const defaultCutoffBackend = new backendApi.ProtectedReviewBackend({ householdId: 'household-1', allowedUsers: [auth.email] });
    const defaultCutoffService = createBudgetService({
        backend: defaultCutoffBackend,
        syncEnabled: true,
        provider: defaultCutoffProvider(),
        connectionOwners: { chase: auth.uid },
        connectionResolver: async () => ({ accessToken: 'synthetic-token' }),
        syncRepository: new review.InMemorySyncRepository({ cooldownMs: 0 }),
        clock: () => 20
    });
    assert.equal(defaultCutoffService.cutoverDate, '2026-10-09');
    const defaultCutoffRun = await defaultCutoffService.syncService.runOnOpen(auth, 'chase', { runId: 'default-cutoff-boundary' });
    assert.equal(defaultCutoffRun.staged, 2);
    const defaultCutoffPending = await defaultCutoffBackend.listPending(auth);
    assert.deepEqual(defaultCutoffPending.map(item => item.description).sort(), ['On default cutoff', 'After default cutoff'].sort());

    // The initial cutover is a calendar-date gate for new observations. A
    // pre-cutover amendment for an already accepted provider identity remains
    // reviewable, and the accepted history itself is unchanged by sync.
    const cutoffBackend = new backendApi.ProtectedReviewBackend({ householdId: 'household-1', allowedUsers: [auth.email] });
    const acceptedBeforeCutover = await cutoffBackend.stage(auth, [candidate({
        source: 'bank-provider', sourceIdentity: 'plaid:chase:Checking:existing-old', sourceRevision: 'accepted-1',
        date: '2026-10-10', description: 'Existing accepted purchase', amount: -20
    })], { source: 'bank-provider', serverIngest: true });
    await cutoffBackend.approve(auth, { candidateIds: [acceptedBeforeCutover.candidates[0].id], revisions: [acceptedBeforeCutover.candidates[0].revision], idempotencyKey: 'cutover-existing' });
    const acceptedHistoryBeforeCutover = (await cutoffBackend.exportState(auth)).accepted;
    await cutoffBackend.stage(auth, [candidate({
        source: 'bank-provider', sourceIdentity: 'plaid:chase:Checking:pending-old', sourceRevision: 'pending-1',
        date: '2026-10-10', description: 'Existing pending purchase', amount: -9
    })], { source: 'bank-provider', serverIngest: true });
    const cutoffPlaid = new backendApi.PlaidTransactionsSyncAdapter({
        accountMap: { Checking: 'Checking Account' },
        client: { sync: async () => ({
            added: [
                { transaction_id: 'new-15', date: '2026-10-15', amount: 15, account_id: 'Checking', currency_code: 'USD', name: 'Before cutover' },
                { transaction_id: 'new-16', date: '2026-10-16', amount: 16, account_id: 'Checking', currency_code: 'USD', name: 'On cutover' },
                { transaction_id: 'new-17', date: '2026-10-17', amount: 17, account_id: 'Checking', currency_code: 'USD', name: 'After cutover' }
            ],
            modified: [
                { transaction_id: 'existing-old', date: '2026-10-10', amount: -18, account_id: 'Checking', currency_code: 'USD', name: 'Existing changed' },
                { transaction_id: 'pending-old', date: '2026-10-10', amount: -8, account_id: 'Checking', currency_code: 'USD', name: 'Pending changed' },
                { transaction_id: 'unknown-old', date: '2026-10-10', amount: -7, account_id: 'Checking', currency_code: 'USD', name: 'Unknown old change' }
            ],
            removed: [], has_more: false, next_cursor: 'cutover-cursor'
        }) }
    });
    const cutoffSync = new backendApi.OnOpenSyncService({
        enabled: true, cutoverDate: '2026-10-16', provider: cutoffPlaid,
        repository: new review.InMemorySyncRepository({ cooldownMs: 0 }), reviewBackend: cutoffBackend,
        connectionOwners: { chase: auth.uid }, connectionResolver: async () => ({ accessToken: 'synthetic-token' }), clock: () => 10
    });
    const cutoffResult = await cutoffSync.runOnOpen(auth, 'chase', { runId: 'cutover-boundary' });
    assert.equal(cutoffResult.staged, 4);
    const cutoffPending = await cutoffBackend.listPending(auth);
    assert.deepEqual(cutoffPending.map(item => item.description).sort(), ['Existing changed', 'Pending changed', 'After cutover', 'On cutover'].sort());
    assert.equal(cutoffPending.some(item => item.description === 'Before cutover'), false);
    assert.equal(cutoffPending.some(item => item.description === 'Unknown old change'), false);
    assert.deepEqual((await cutoffBackend.exportState(auth)).accepted, acceptedHistoryBeforeCutover);

    const defaultComposition = createBudgetService({ backend: cutoffBackend });
    assert.equal(defaultComposition.cutoverDate, appConfig.FIRST_SYNC_CUTOVER_DATE);
    assert.equal(defaultComposition.syncService.cutoverDate, '2026-10-09');
    assert.equal(defaultComposition.syncService.enabled, appConfig.DEFAULT_SYNC_ENABLED);
    assert.deepEqual(defaultComposition.accountAliases, appConfig.legacyAccountAliases);
    assert.deepEqual(defaultComposition.syncService.accountAliases, appConfig.legacyAccountAliases);
    const explicitComposition = createBudgetService({ backend: cutoffBackend, cutoverDate: '2026-11-01', syncEnabled: true });
    assert.equal(explicitComposition.syncService.cutoverDate, '2026-11-01');
    const invalidComposition = createBudgetService({ backend: cutoffBackend, cutoverDate: null, syncEnabled: true, connectionOwners: { chase: auth.uid } });
    await assert.rejects(() => invalidComposition.syncService.runOnOpen(auth, 'chase'), /fail-closed/);

    const service = createBudgetService({ backend: protectedBackend, syncService: sync1, authenticate: async () => auth, allowedOrigins: ['https://budget.example.test'] });
    const preflight = response();
    await service.handler(request('OPTIONS', '/review', {}, 'https://budget.example.test'), preflight);
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers['Access-Control-Allow-Origin'], 'https://budget.example.test');
    const rejectedCors = response();
    await service.handler(request('OPTIONS', '/review', {}, 'https://evil.example.test'), rejectedCors);
    assert.equal(rejectedCors.statusCode, 403);
    const reviewResponse = response();
    await service.handler(request('GET', '/review', {}, 'https://budget.example.test'), reviewResponse);
    assert.equal(reviewResponse.statusCode, 200);
    review.validateReviewSnapshot(JSON.parse(reviewResponse.body));
    const protectedState = await protectedBackend.exportState(auth);
    const acceptedState = {
        ...protectedState.state,
        transactions: protectedState.accepted.map(entry => Array.isArray(entry) ? entry[1] : entry)
    };
    const acceptedStateResponse = response();
    await service.handler(request('POST', '/accepted-state', { state: acceptedState, expectedRevision: protectedState.revision }, 'https://budget.example.test'), acceptedStateResponse);
    assert.equal(acceptedStateResponse.statusCode, 200);
    assert.equal(JSON.parse(acceptedStateResponse.body).ok, true);
    const httpAmendmentStageResponse = response();
    await service.handler(request('POST', '/stage', {
        source: 'bank-csv',
        records: [candidate({ source: 'bank-csv', sourceIdentity: 'bank-csv:reloadable', sourceRevision: '2', description: 'HTTP provider update', amendment: 'modified' })]
    }, 'https://budget.example.test'), httpAmendmentStageResponse);
    assert.equal(httpAmendmentStageResponse.statusCode, 200);
    const httpAmendment = JSON.parse(httpAmendmentStageResponse.body).candidates[0];
    const httpFenceState = await protectedBackend.exportState(auth);
    await service.handler(request('POST', '/accepted-state', {
        state: {
            ...httpFenceState.state,
            transactions: httpFenceState.accepted.map(entry => ({ ...(Array.isArray(entry) ? entry[1] : entry), description: 'HTTP user edit while review was pending' }))
        },
        expectedRevision: httpFenceState.revision
    }, 'https://budget.example.test'), response());
    const httpAmendmentApprovalResponse = response();
    await service.handler(request('POST', '/approve', {
        candidateIds: [httpAmendment.id], revisions: [httpAmendment.revision], idempotencyKey: 'http-amendment-stale'
    }, 'https://budget.example.test'), httpAmendmentApprovalResponse);
    assert.equal(httpAmendmentApprovalResponse.statusCode, 409);
    assert.equal((await protectedBackend.listPending(auth)).some(item => item.id === httpAmendment.id), true);

    const legacyDb = fakeFirestore();
    const unknownLegacy = candidate({ sourceIdentity: 'legacy-unknown-date', date: 'Unknown', description: 'Synthetic legacy' });
    legacyDb.values.set('shared/data', { transactions: [unknownLegacy], categories: [], budgets: {}, merchantDefaults: {}, categoryGroups: [], categoryColors: {}, categoryOrder: [], revision: 0 });
    const legacyRepository = new backendApi.FirestoreReviewRepository({ db: legacyDb, householdId: 'household-1' });
    const legacyDurable = new backendApi.DurableProtectedReviewBackend({ repository: legacyRepository, householdId: 'household-1', allowedUsers: [auth.email] });
    const legacyService = createBudgetService({ backend: legacyDurable, authenticate: async () => auth, allowedOrigins: ['https://budget.example.test'] });
    const legacyReviewResponse = response();
    await legacyService.handler(request('GET', '/review', {}, 'https://budget.example.test'), legacyReviewResponse);
    assert.equal(legacyReviewResponse.statusCode, 200);
    assert.equal(JSON.parse(legacyReviewResponse.body).accepted.length, 0);
    assert.deepEqual((await legacyDurable.exportState(auth)).accepted[0][1], unknownLegacy);

    let restoreCalls = 0;
    const largeRestore = backendApi.createHttpHandler({
        backend: { replaceAccepted: async () => { restoreCalls += 1; return { ok: true }; } },
        authenticate: async () => auth,
        allowedOrigins: ['https://budget.example.test']
    });
    const largeRestoreResponse = response();
    await largeRestore(request('POST', '/restore', { state: { description: 'x'.repeat(600000) } }, 'https://budget.example.test'), largeRestoreResponse);
    assert.equal(largeRestoreResponse.statusCode, 200);
    assert.equal(restoreCalls, 1);
    const boundedRestore = backendApi.createHttpHandler({
        backend: { replaceAccepted: async () => { restoreCalls += 1; return { ok: true }; } },
        authenticate: async () => auth,
        allowedOrigins: ['https://budget.example.test'], maxBodyBytes: 100
    });
    const oversizedResponse = response();
    await boundedRestore(request('POST', '/restore', { state: { description: 'x'.repeat(600) } }, 'https://budget.example.test'), oversizedResponse);
    assert.equal(oversizedResponse.statusCode, 409);
    assert.equal(restoreCalls, 1);

    const splitBackend = new backendApi.ProtectedReviewBackend({ householdId: 'household-1', allowedUsers: [auth.email] });
    const splitStage = await splitBackend.stage(auth, [candidate({ sourceId: 'split-source', amount: -10 })], { source: 'bank-csv' });
    const split = await splitBackend.split(auth, splitStage.candidates[0].id, [{ category: 'Food', amount: '4.25' }, { category: 'Other', amount: '5.75' }], splitStage.candidates[0].revision);
    assert.equal(split.candidates.reduce((sum, item) => sum + item.amount, 0), -10);
    assert.equal(split.candidates[0].parentSourceIdentity, splitStage.candidates[0].sourceIdentity);
    await assert.rejects(() => splitBackend.split(auth, split.candidates[0].id, [{ category: 'Food', amount: '4.24' }, { category: 'Other', amount: '5.75' }], 1), /conserve/);

    const amendmentBackend = new backendApi.ProtectedReviewBackend({ householdId: 'household-1', allowedUsers: [auth.email] });
    const original = await amendmentBackend.stage(auth, [candidate({ sourceIdentity: 'plaid:chase:checking:amend', sourceRevision: '1', amount: 100, source: 'bank-provider' })], { source: 'bank-provider', serverIngest: true });
    await amendmentBackend.approve(auth, { candidateIds: [original.candidates[0].id], revisions: [1], idempotencyKey: 'amend-original' });
    const modified = await amendmentBackend.stage(auth, [candidate({ sourceIdentity: 'plaid:chase:checking:amend', sourceRevision: '2', amount: 75, source: 'bank-provider', amendment: 'modified' })], { source: 'bank-provider', serverIngest: true });
    assert.equal((await amendmentBackend.exportState(auth)).accepted.length, 1);
    await amendmentBackend.approve(auth, { candidateIds: [modified.candidates[0].id], revisions: [1], idempotencyKey: 'amend-modified' });
    assert.equal((await amendmentBackend.exportState(auth)).accepted[0][1].amount, 75);
    const removed = await amendmentBackend.stage(auth, [candidate({ sourceIdentity: 'plaid:chase:checking:amend', sourceRevision: '3', amount: 75, source: 'bank-provider', amendment: 'removed' })], { source: 'bank-provider', serverIngest: true });
    await amendmentBackend.approve(auth, { candidateIds: [removed.candidates[0].id], revisions: [1], idempotencyKey: 'amend-removed' });
    assert.equal((await amendmentBackend.exportState(auth)).accepted.length, 0);
    review.validateReviewSnapshot(amendmentBackend.exportReviewSnapshot());

    const durableAmendDb = fakeFirestore();
    const durableAmend = new backendApi.DurableProtectedReviewBackend({ repository: new backendApi.FirestoreReviewRepository({ db: durableAmendDb, householdId: 'household-1' }), householdId: 'household-1', allowedUsers: [auth.email] });
    const durableOriginal = await durableAmend.stage(auth, [candidate({ source: 'bank-provider', sourceIdentity: 'plaid:durable:amend', sourceRevision: '1', amount: 100 })], { source: 'bank-provider', serverIngest: true });
    await durableAmend.approve(auth, { candidateIds: [durableOriginal.candidates[0].id], revisions: [1], idempotencyKey: 'durable-amend-original' });
    const durableModified = await durableAmend.stage(auth, [candidate({ source: 'bank-provider', sourceIdentity: 'plaid:durable:amend', sourceRevision: '2', amount: 75, amendment: 'modified' })], { source: 'bank-provider', serverIngest: true });
    const durableBeforeSave = await durableAmend.exportState(auth);
    await durableAmend.saveAcceptedState(auth, {
        ...durableBeforeSave.state,
        transactions: durableBeforeSave.accepted.map(entry => ({ ...(Array.isArray(entry) ? entry[1] : entry), description: 'Durable user edit while provider review was pending' }))
    }, durableBeforeSave.revision);
    await assert.rejects(() => durableAmend.approve(auth, { candidateIds: [durableModified.candidates[0].id], revisions: [1], idempotencyKey: 'durable-amend-stale' }), /Amendment target changed since review/);
    const durableRestaged = await durableAmend.stage(auth, [candidate({ source: 'bank-provider', sourceIdentity: 'plaid:durable:amend', sourceRevision: '3', amount: 75, amendment: 'modified' })], { source: 'bank-provider', serverIngest: true });
    await durableAmend.approve(auth, { candidateIds: [durableRestaged.candidates[0].id], revisions: [durableRestaged.candidates[0].revision], idempotencyKey: 'durable-amend-modified' });
    const durableRemoved = await durableAmend.stage(auth, [candidate({ source: 'bank-provider', sourceIdentity: 'plaid:durable:amend', sourceRevision: '4', amount: 75, amendment: 'removed' })], { source: 'bank-provider', serverIngest: true });
    await durableAmend.approve(auth, { candidateIds: [durableRemoved.candidates[0].id], revisions: [durableRemoved.candidates[0].revision], idempotencyKey: 'durable-amend-removed' });
    assert.equal((await durableAmend.exportState(auth)).accepted.length, 0);
    review.validateReviewSnapshot(await durableAmend.exportReview(auth));
    const durablePostAmendSave = await durableAmend.exportState(auth);
    await durableAmend.saveAcceptedState(auth, { ...durablePostAmendSave.state, transactions: [] }, durablePostAmendSave.revision);
    review.validateReviewSnapshot(await durableAmend.exportReview(auth));

    const inlineDurableDb = fakeFirestore();
    const inlineDurable = new backendApi.DurableProtectedReviewBackend({ repository: new backendApi.FirestoreReviewRepository({ db: inlineDurableDb, householdId: 'household-1' }), householdId: 'household-1', allowedUsers: [auth.email] });
    const inlineApproval = await inlineDurable.approve(auth, {
        candidates: [candidate({ source: 'bank-csv', sourceId: 'durable-inline', account: 'Checking Account' })],
        idempotencyKey: 'durable-inline-approval'
    });
    assert.equal(inlineApproval.ok, true);
    assert.equal((await inlineDurable.exportState(auth)).accepted.length, 1);
    const inlineSubsetDb = fakeFirestore();
    const inlineSubsetDurable = new backendApi.DurableProtectedReviewBackend({ repository: new backendApi.FirestoreReviewRepository({ db: inlineSubsetDb, householdId: 'household-1' }), householdId: 'household-1', allowedUsers: [auth.email] });
    const inlineA = candidate({ source: 'bank-csv', sourceId: 'inline-subset-a' });
    const inlineB = candidate({ source: 'bank-csv', sourceId: 'inline-subset-b', description: 'Second inline row' });
    await assert.rejects(() => inlineSubsetDurable.approve(auth, {
        candidates: [inlineA, inlineB], candidateIds: ['bank-csv:inline-subset-a@1'], revisions: [1], idempotencyKey: 'inline-subset-rejected'
    }), /staged review selection/);
    assert.equal((await inlineSubsetDurable.listPending(auth)).length, 0);
    await assert.rejects(() => inlineSubsetDurable.approve(auth, {
        candidates: [inlineA], candidateIds: ['bank-csv:inline-subset-a@1'], revisions: [2], idempotencyKey: 'inline-stale-rejected'
    }), /staged review selection/);
    assert.equal((await inlineSubsetDurable.listPending(auth)).length, 0);

    // A durable stage can commit before its response reaches the browser. A
    // retry carrying the reviewed body may recover that server-pending row,
    // but an altered body must be rejected without consuming it.
    const lostStageDb = fakeFirestore();
    const lostStageDurable = new backendApi.DurableProtectedReviewBackend({ repository: new backendApi.FirestoreReviewRepository({ db: lostStageDb, householdId: 'household-1' }), householdId: 'household-1', allowedUsers: [auth.email] });
    const lostStage = await lostStageDurable.stage(auth, [candidate({ source: 'bank-csv', sourceId: 'lost-stage-response' })], { source: 'bank-csv', batchId: 'lost-stage-batch' });
    const lostStageApproval = await lostStageDurable.approve(auth, {
        candidates: [lostStage.candidates[0]], candidateIds: [lostStage.candidates[0].id], revisions: [lostStage.candidates[0].revision],
        idempotencyKey: 'lost-stage-response-approval'
    });
    assert.equal(lostStageApproval.ok, true);
    assert.equal((await lostStageDurable.exportState(auth)).accepted.length, 1);
    const alteredStageDb = fakeFirestore();
    const alteredStageDurable = new backendApi.DurableProtectedReviewBackend({ repository: new backendApi.FirestoreReviewRepository({ db: alteredStageDb, householdId: 'household-1' }), householdId: 'household-1', allowedUsers: [auth.email] });
    const alteredStage = await alteredStageDurable.stage(auth, [candidate({ source: 'bank-csv', sourceId: 'altered-stage-response' })], { source: 'bank-csv', batchId: 'altered-stage-batch' });
    await assert.rejects(() => alteredStageDurable.approve(auth, {
        candidates: [{ ...alteredStage.candidates[0], description: 'Tampered after stage' }], candidateIds: [alteredStage.candidates[0].id], revisions: [alteredStage.candidates[0].revision],
        idempotencyKey: 'altered-stage-response-approval'
    }), /changed since review/);
    assert.equal((await alteredStageDurable.listPending(auth)).length, 1);

    // Exercise the same HTTP and BrowserApprovalClient path. The stage body
    // is sent to the real handler, its response is intentionally discarded,
    // and the client retries approval with no stagedIds cache.
    const browserLossDb = fakeFirestore();
    const browserLossBackend = new backendApi.DurableProtectedReviewBackend({ repository: new backendApi.FirestoreReviewRepository({ db: browserLossDb, householdId: 'household-1' }), householdId: 'household-1', allowedUsers: [auth.email] });
    const browserLossService = createBudgetService({ backend: browserLossBackend, authenticate: async () => auth, allowedOrigins: ['https://budget.example.test'] });
    const browserAuth = { currentUser: { async getIdToken() { return 'synthetic-browser-token'; } } };
    const browserFetch = async (url, options) => {
        const path = new URL(url).pathname;
        const parsed = options && options.body ? JSON.parse(options.body) : {};
        const incoming = request(options && options.method || 'GET', path, parsed, 'https://budget.example.test');
        incoming.headers.authorization = 'Bearer synthetic-browser-token';
        const outgoing = response();
        await browserLossService.handler(incoming, outgoing);
        return { ok: outgoing.statusCode >= 200 && outgoing.statusCode < 300, status: outgoing.statusCode, async json() { return JSON.parse(outgoing.body || '{}'); } };
    };
    const browserClient = new backendApi.BrowserApprovalClient({ endpoint: 'http://synthetic.local', auth: browserAuth, fetch: browserFetch });
    const browserStageRecord = candidate({ source: 'bank-csv', sourceId: 'browser-lost-stage' });
    const lostStageHttpRequest = request('POST', '/stage', { source: 'bank-csv', records: [browserStageRecord] }, 'https://budget.example.test');
    lostStageHttpRequest.headers.authorization = 'Bearer synthetic-browser-token';
    const lostStageHttpResponse = response();
    await browserLossService.handler(lostStageHttpRequest, lostStageHttpResponse);
    assert.equal(lostStageHttpResponse.statusCode, 200);
    const browserStagedCandidate = JSON.parse(lostStageHttpResponse.body).candidates[0];
    const browserLossApproval = await browserClient.approve([browserStagedCandidate], {
        candidateIds: [browserStagedCandidate.id], revisions: [browserStagedCandidate.revision], idempotencyKey: 'browser-lost-stage-approval'
    });
    assert.equal(browserLossApproval.ok, true);
    assert.equal((await browserLossBackend.exportState(auth)).accepted.length, 1);

    // Ordinary settings saves retain receipts and amendment history. Deleting
    // a receipt-bound accepted row archives only the protected review record,
    // so audit remains bound while canonical totals stay empty. Explicit
    // reset invalidates receipts and cannot resurrect the prior row.
    const receiptLifecycle = new backendApi.ProtectedReviewBackend({ householdId: 'household-1', allowedUsers: [auth.email] });
    const receiptStage = await receiptLifecycle.stage(auth, [candidate({ source: 'bank-csv', sourceId: 'receipt-lifecycle' })], { source: 'bank-csv' });
    const receiptRequest = { candidateIds: [receiptStage.candidates[0].id], revisions: [receiptStage.candidates[0].revision], idempotencyKey: 'receipt-lifecycle-approval' };
    await receiptLifecycle.approve(auth, receiptRequest);
    let receiptState = await receiptLifecycle.exportState(auth);
    await receiptLifecycle.saveAcceptedState(auth, { ...receiptState.state, transactions: receiptState.accepted.map(entry => entry[1]) }, receiptState.revision);
    review.validateReviewSnapshot(receiptLifecycle.exportReviewSnapshot());
    receiptState = await receiptLifecycle.exportState(auth);
    await receiptLifecycle.saveAcceptedState(auth, { ...receiptState.state, transactions: [] }, receiptState.revision);
    const archivedReceiptReview = receiptLifecycle.exportReviewSnapshot();
    review.validateReviewSnapshot(archivedReceiptReview);
    assert.equal(receiptLifecycle.canonicalState().transactions.length, 0);
    assert.equal(archivedReceiptReview.receipts.length, 1);
    const replayAfterDelete = await receiptLifecycle.approve(auth, receiptRequest);
    assert.equal(replayAfterDelete.ok, true);
    assert.equal(replayAfterDelete.state.transactions.length, 0);
    const resetRevision = (await receiptLifecycle.exportState(auth)).revision;
    await receiptLifecycle.resetAccepted(auth, resetRevision);
    assert.equal(receiptLifecycle.exportReviewSnapshot().receipts.length, 0);
    await assert.rejects(() => receiptLifecycle.approve(auth, receiptRequest), /Every candidate must remain pending/);
    const restoreStage = await receiptLifecycle.stage(auth, [candidate({ source: 'bank-csv', sourceId: 'restore-receipt-lifecycle' })], { source: 'bank-csv' });
    const restoreRequest = { candidateIds: [restoreStage.candidates[0].id], revisions: [restoreStage.candidates[0].revision], idempotencyKey: 'restore-receipt-lifecycle-approval' };
    await receiptLifecycle.approve(auth, restoreRequest);
    const restoreState = await receiptLifecycle.exportState(auth);
    await receiptLifecycle.replaceAccepted(auth, { ...restoreState.state, transactions: [] }, restoreState.revision);
    assert.equal(receiptLifecycle.exportReviewSnapshot().receipts.length, 0);
    await assert.rejects(() => receiptLifecycle.approve(auth, restoreRequest), /Every candidate must remain pending/);

    const pendingBackend = new backendApi.ProtectedReviewBackend({ householdId: 'household-1', allowedUsers: [auth.email] });
    const pendingStage = await pendingBackend.stage(auth, [candidate({ source: 'bank-provider', sourceIdentity: 'plaid:chase:checking:pending-link', sourceRevision: 'pending', providerPending: true })], { source: 'bank-provider', serverIngest: true });
    await assert.rejects(() => pendingBackend.approve(auth, { candidateIds: [pendingStage.candidates[0].id], revisions: [1], idempotencyKey: 'pending-approval' }), /must post/);
    const posted = await pendingBackend.stage(auth, [candidate({ source: 'bank-provider', sourceIdentity: 'plaid:chase:checking:pending-link', sourceRevision: 'posted', providerPending: false, amount: 15 })], { source: 'bank-provider', serverIngest: true });
    assert.equal(posted.candidates.length, 1);
    assert.equal((await pendingBackend.listPending(auth)).some(item => item.sourceRevision === 'pending'), false);

    const largeHistory = Array.from({ length: 700 }, (_, index) => ({
        sourceIdentity: `legacy:${index}`, sourceRevision: '1', id: `legacy:${index}@1`,
        date: '2026-10-01', description: 'legacy '.repeat(180), amount: 1,
        category: 'Legacy', account: 'Checking', payment_method: 'Checking', type: 'expense'
    }));
    const compactBackend = new backendApi.ProtectedReviewBackend({
        householdId: 'household-1', allowedUsers: [auth.email],
        initialState: { transactions: largeHistory, categories: [{ name: 'Legacy', type: 'expense' }], budgets: {}, merchantDefaults: {} }
    });
    const compactStage = await compactBackend.stage(auth, [candidate({ sourceIdentity: 'small-approval', sourceRevision: '1', id: 'small-approval@1' })], { source: 'bank-csv' });
    await compactBackend.approve(auth, { candidateIds: [compactStage.candidates[0].id], revisions: [1], idempotencyKey: 'compact-receipt' });
    const compactReceipt = compactBackend.exportState().receipts[0][1];
    assert.equal(Object.prototype.hasOwnProperty.call(compactReceipt, 'result'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(compactReceipt, 'state'), false);
    assert.ok(JSON.stringify(compactReceipt).length < 20000);
    assert.ok(JSON.stringify(compactBackend.canonicalState()).length > JSON.stringify(compactReceipt).length * 10);

    console.log('PASS: durable review hydration, cross-instance sync cooldown/fencing, injected Plaid pagination, authenticated CORS/body limits, on-open inbox staging, compact receipts, and signed split conservation.');
})().catch(error => { console.error(error); process.exitCode = 1; });

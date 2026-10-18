'use strict';

/*
 * Local-only Netlify composition check. This test is intentionally not a
 * launcher: the existing sanitized emulator launcher supplies Auth and
 * Firestore on 9099/8088. The default Web entry is exercised with gates off,
 * while the same real Admin14 clients and Web adapter run an injected Plaid
 * provider for the synthetic Link/vault lifecycle. No provider request leaves
 * this process.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const netlifyRequire = createRequire(path.join(root, 'netlify', 'package.json'));
const { cert, initializeApp } = netlifyRequire('firebase-admin/app');
const { getAuth } = netlifyRequire('firebase-admin/auth');
const { getFirestore } = netlifyRequire('firebase-admin/firestore');

const AUTH_HOST = '127.0.0.1:9099';
const FIRESTORE_HOST = '127.0.0.1:8088';
const PRODUCTION_PROJECT = 'budget-tool-sync';
const EMULATOR_PROJECT = String(process.env.GCLOUD_PROJECT || PRODUCTION_PROJECT).trim() || PRODUCTION_PROJECT;
assert.ok(new Set([PRODUCTION_PROJECT, 'demo-budget-tool']).has(EMULATOR_PROJECT), `Unexpected local emulator project: ${EMULATOR_PROJECT}`);
const AUTH_PROJECT = EMULATOR_PROJECT;
const SITE_ID = 'site-netlify-emulator';
const SITE_HOST = 'netlify-emulator.example';
const ORIGIN = 'https://zmstiles-dev.github.io';
const HOUSEHOLD = 'stiles-budget';
const UID = 'netlify-emulator-user';
const EMAIL = 'netlify-emulator@example.test';
const PASSWORD = 'netlify-emulator-password-1';
const REVIEWER_UID = 'netlify-emulator-reviewer';
const REVIEWER_EMAIL = 'netlify-emulator-reviewer@example.test';
const REVIEWER_PASSWORD = 'netlify-emulator-reviewer-password-1';
const ITEM_ID = 'synthetic-item-netlify';
const EXCHANGE_ID = 'netlify-exchange-1';
const PRIVATE_KEY = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } }).privateKey;
const OLD_KEY = Buffer.alloc(32, 31).toString('base64url');
const NEW_KEY = Buffer.alloc(32, 32).toString('base64url');

function assertEnvironment() {
    assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, AUTH_HOST);
    assert.equal(process.env.FIRESTORE_EMULATOR_HOST, FIRESTORE_HOST);
}

async function idToken(auth, identity = { uid: UID, email: EMAIL, password: PASSWORD }) {
    let lastBody;
    for (const key of [AUTH_PROJECT, 'demo-budget-tool']) {
        const passwordResponse = await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${key}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: identity.email, password: identity.password, returnSecureToken: true })
        });
        const passwordBody = await passwordResponse.json();
        if (passwordResponse.ok && passwordBody.idToken) return passwordBody.idToken;
        lastBody = passwordBody;
        const customToken = await auth.createCustomToken(identity.uid);
        const customResponse = await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${key}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: customToken, returnSecureToken: true })
        });
        const customBody = await customResponse.json();
        if (customResponse.ok && customBody.idToken) return customBody.idToken;
        lastBody = customBody;
    }
    assert.fail(`Auth emulator sign-in failed: ${JSON.stringify(lastBody)}`);
}

function context() {
    return { deploy: { context: 'production', published: true }, site: { id: SITE_ID, url: `https://${SITE_HOST}` } };
}

function environment(overrides = {}) {
    return {
        BUDGET_NETLIFY_SITE_ID: SITE_ID,
        BUDGET_NETLIFY_SITE_HOST: SITE_HOST,
        BUDGET_FIREBASE_PROJECT_ID: PRODUCTION_PROJECT,
        FIREBASE_AUTH_EMULATOR_HOST: AUTH_HOST,
        FIRESTORE_EMULATOR_HOST: FIRESTORE_HOST,
        BUDGET_FIREBASE_CLIENT_EMAIL: 'budget-transactions-runtime@budget-tool-sync.iam.gserviceaccount.com',
        BUDGET_FIREBASE_PRIVATE_KEY: PRIVATE_KEY.replaceAll('\n', '\\n'),
        BUDGET_HOUSEHOLD_ID: HOUSEHOLD,
        BUDGET_CONNECTION_KEYS: 'chase',
        BUDGET_ACTIVE_CONNECTION_KEYS: '',
        BUDGET_EXPECTED_INSTITUTION_CHASE: 'ins-synthetic',
        BUDGET_LINK_ENABLED: 'true',
        BUDGET_SYNC_ENABLED: 'false',
        BUDGET_PLAID_CLIENT_ID: 'synthetic-client-id',
        BUDGET_PLAID_CLIENT_SECRET: 'synthetic-client-secret',
        BUDGET_TOKEN_CURRENT_KEY_ID: 'old',
        BUDGET_TOKEN_KEYRING_JSON: JSON.stringify({ old: OLD_KEY }),
        PLAID_REDIRECT_URI: `${ORIGIN}/oauth/callback`,
        ...overrides
    };
}

async function call(handler, url, token, body, method = 'POST') {
    const response = await handler(new Request(url, {
        method,
        headers: { Origin: ORIGIN, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }), context());
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : {} };
}

function fakePlaid(calls) {
    return {
        async linkTokenCreate() { calls.link += 1; return { data: { link_token: 'synthetic-link-token' } }; },
        async itemPublicTokenExchange() { calls.exchange += 1; return { data: { access_token: 'synthetic-access-token', item_id: ITEM_ID } }; },
        async itemGet() { calls.item += 1; return { data: { item: { institution_id: 'ins-synthetic' } } }; },
        async accountsGet() { calls.accounts += 1; return { data: { accounts: [{ account_id: 'synthetic-checking', name: 'Checking Account', official_name: 'Synthetic Checking', type: 'depository', subtype: 'checking', mask: '0820', balances: { iso_currency_code: 'USD' } }] } }; },
        async transactionsSync(request) {
            calls.sync += 1;
            assert.equal(request.count, 500);
            if (!request.cursor) return { added: [{ transaction_id: 'synthetic-provider-tx-1', account_id: 'synthetic-checking', date: '2026-10-10', name: 'Synthetic Bank Purchase', merchant_name: 'Synthetic Merchant', amount: 12.34, iso_currency_code: 'USD', pending: false }], modified: [], removed: [], has_more: false, next_cursor: 'cursor-1' };
            if (request.cursor === 'cursor-1') return { added: [{ transaction_id: 'synthetic-provider-tx-2', account_id: 'synthetic-checking', date: '2026-10-11', name: 'Synthetic Rejected Purchase', merchant_name: 'Synthetic Merchant 2', amount: 8.76, iso_currency_code: 'USD', pending: false }], modified: [], removed: [], has_more: false, next_cursor: 'cursor-2' };
            return { added: [], modified: [], removed: [], has_more: false, next_cursor: 'cursor-2' };
        }
    };
}

async function clearSyntheticState(db) {
    // The composite local verification sequence intentionally reuses one
    // emulator for the rules matrix and this fixture. Clear only the fixed
    // synthetic paths so an earlier rules document cannot masquerade as an
    // accepted production transaction or a prior Link attempt.
    for (const pathName of [
        'shared/data',
        `protectedTransactionReview/${HOUSEHOLD}`,
        'protectedSyncRuns/synthetic-sync-1',
        'protectedSyncRuns/synthetic-sync-2',
        `protectedAppUsers/${UID}`,
        `protectedAppUsers/${REVIEWER_UID}`,
        'protectedAppConfig/transactionService',
        'protectedConnections/chase',
        'protectedProviderTokens/chase/versions/1',
        'protectedProviderTokens/chase',
        'protectedProviderTokens/quota-slot/versions/1',
        'protectedProviderTokens/quota-slot'
    ]) {
        const segments = pathName.split('/');
        let reference = db.collection(segments.shift());
        while (segments.length > 1) reference = reference.doc(segments.shift()).collection(segments.shift());
        await reference.doc(segments[0]).delete().catch(() => {});
    }
}

;(async () => {
    assertEnvironment();
    execFileSync(process.execPath, ['scripts/prepare-netlify.cjs'], { cwd: root, stdio: 'pipe' });
    const runtime = await import(`file://${path.join(root, 'netlify', 'functions', 'budgetTransactions.mjs').replaceAll('\\', '/')}`);
    assert.equal(typeof runtime.default, 'function');
    assert.equal('handler' in runtime, false, 'the Netlify entry must use the v2 default export');
    const app = initializeApp({ projectId: EMULATOR_PROJECT, credential: cert({ projectId: EMULATOR_PROJECT, clientEmail: 'budget-transactions-runtime@budget-tool-sync.iam.gserviceaccount.com', privateKey: PRIVATE_KEY }) }, 'netlify-emulator-test');
    const auth = getAuth(app);
    const db = getFirestore(app);
    const firebase = { app, auth, db };
    const calls = { link: 0, exchange: 0, item: 0, accounts: 0, sync: 0 };
    const plaid = fakePlaid(calls);
    const oldEnvironment = {};
    const processKeys = ['BUDGET_NETLIFY_SITE_ID', 'BUDGET_NETLIFY_SITE_HOST', 'BUDGET_FIREBASE_PROJECT_ID', 'BUDGET_FIREBASE_CLIENT_EMAIL', 'BUDGET_FIREBASE_PRIVATE_KEY', 'BUDGET_HOUSEHOLD_ID', 'BUDGET_CONNECTION_KEYS', 'BUDGET_ACTIVE_CONNECTION_KEYS', 'BUDGET_LINK_ENABLED', 'BUDGET_SYNC_ENABLED'];
    for (const key of processKeys) oldEnvironment[key] = process.env[key];
    let defaultReview;
    try {
        await clearSyntheticState(db);
        try { await auth.deleteUser(UID); } catch (_) { /* fresh emulator */ }
        try { await auth.deleteUser(REVIEWER_UID); } catch (_) { /* fresh emulator */ }
        await auth.createUser({ uid: UID, email: EMAIL, password: PASSWORD, emailVerified: true });
        await auth.createUser({ uid: REVIEWER_UID, email: REVIEWER_EMAIL, password: REVIEWER_PASSWORD, emailVerified: true });
        assert.equal((await auth.getUser(UID)).uid, UID);
        await db.collection('protectedAppConfig').doc('transactionService').set({ allowed: true, householdId: HOUSEHOLD });
        await db.collection('protectedAppUsers').doc(UID).set({ allowed: true, uid: UID, email: EMAIL, householdId: HOUSEHOLD });
        await db.collection('protectedAppUsers').doc(REVIEWER_UID).set({ allowed: true, uid: REVIEWER_UID, email: REVIEWER_EMAIL, householdId: HOUSEHOLD });
        const token = await idToken(auth);
        const reviewerToken = await idToken(auth, { uid: REVIEWER_UID, email: REVIEWER_EMAIL, password: REVIEWER_PASSWORD });

        // Exercise the actual default Web entry with provider gates off. The
        // default entry reads only the Firebase auth/review configuration.
        const reviewEnvironment = environment({ BUDGET_LINK_ENABLED: 'false', BUDGET_SYNC_ENABLED: 'false' });
        for (const key of processKeys) process.env[key] = reviewEnvironment[key];
        defaultReview = await call(runtime.default, `https://${SITE_HOST}/review`, token, undefined, 'GET');
        assert.equal(defaultReview.response.status, EMULATOR_PROJECT === PRODUCTION_PROJECT ? 200 : 401, JSON.stringify(defaultReview.body));
        if (EMULATOR_PROJECT === PRODUCTION_PROJECT) assert.deepEqual(defaultReview.body.pending, []);

        // Historical backup restore is exercised through the real Netlify Web
        // entry and Admin14/Firestore emulator, then repeated through a fresh
        // handler composition. The opaque date remains canonical history but
        // is intentionally absent from strict review metadata.
        const historyHandler = runtime.createNetlifyHandler({ environment: reviewEnvironment, firebase });
        const historyState = {
            transactions: [{ sourceId: 'netlify-legacy-history', date: 'Unknown', description: 'Historical transaction', amount: -3.25, category: 'Restaurants', account: 'Checking', payment_method: 'Checking', type: 'expense' }],
            categories: [{ name: 'Restaurants', type: 'expense' }], budgets: {}, merchantDefaults: {}, categoryGroups: [], categoryColors: {}, categoryOrder: [],
            acceptedHistoryDateCompatibility: true
        };
        const firstHistoryRestore = await call(historyHandler, `https://${SITE_HOST}/.netlify/functions/budgetTransactions/restore`, token, { state: historyState, expectedRevision: 0 });
        assert.equal(firstHistoryRestore.response.status, 200, JSON.stringify(firstHistoryRestore.body));
        assert.equal(firstHistoryRestore.body.state.transactions[0].date, 'Unknown');
        assert.equal(Object.prototype.hasOwnProperty.call(firstHistoryRestore.body.state, 'acceptedHistoryDateCompatibility'), false);
        const persistedHistory = await db.collection('shared').doc('data').get();
        assert.equal(persistedHistory.exists, true);
        assert.equal(persistedHistory.data().transactions[0].date, 'Unknown');
        assert.equal(Object.prototype.hasOwnProperty.call(persistedHistory.data(), 'acceptedHistoryDateCompatibility'), false);
        const freshHistoryHandler = runtime.createNetlifyHandler({ environment: reviewEnvironment, firebase });
        const repeatedHistoryRestore = await call(freshHistoryHandler, `https://${SITE_HOST}/.netlify/functions/budgetTransactions/restore`, token, { state: historyState, expectedRevision: firstHistoryRestore.body.revision });
        assert.equal(repeatedHistoryRestore.response.status, 200, JSON.stringify(repeatedHistoryRestore.body));
        assert.equal(repeatedHistoryRestore.body.state.transactions[0].date, 'Unknown');
        const reloadedHistory = await db.collection('shared').doc('data').get();
        assert.equal(reloadedHistory.data().transactions[0].date, 'Unknown');
        const historyReview = await call(freshHistoryHandler, `https://${SITE_HOST}/.netlify/functions/budgetTransactions/review`, reviewerToken, undefined, 'GET');
        assert.equal(historyReview.response.status, 200, JSON.stringify(historyReview.body));
        assert.deepEqual(historyReview.body.accepted, [], 'opaque historical rows must remain outside strict review metadata');
        await db.collection('shared').doc('data').delete();

        const providerEnvironment = environment();
        const handler = runtime.createNetlifyHandler({
            environment: providerEnvironment,
            firebase,
            plaidClient: plaid,
            context: context()
        });
        const link = await call(handler, `https://${SITE_HOST}/.netlify/functions/budgetTransactions/link-token`, token, { connectionKey: 'chase', sessionId: 'netlify-session-1' });
        assert.equal(link.response.status, 200);
        assert.equal(link.body.linkToken, 'synthetic-link-token');
        assert.equal(calls.link, 1);

        const service = await runtime.createRuntime({ environment: providerEnvironment, context: context(), firebase, plaidClient: plaid });
        let interrupt = true;
        const stage = service.connections.stageExchange.bind(service.connections);
        service.connections.stageExchange = async (...args) => {
            if (interrupt) { interrupt = false; throw new Error('synthetic stage interruption'); }
            return stage(...args);
        };
        const interruptedHandler = runtime.createNetlifyHandler({ environment: providerEnvironment, firebase, plaidClient: plaid, createRuntime: async () => service });
        const interrupted = await call(interruptedHandler, `https://${SITE_HOST}/.netlify/functions/budgetTransactions/link-exchange`, token, { connectionKey: 'chase', publicToken: 'synthetic-public-token', requestId: EXCHANGE_ID });
        assert.equal(interrupted.response.status, 500);
        assert.equal(calls.exchange, 1);
        assert.equal((await db.collection('protectedProviderTokens').doc('chase').get()).data().latestVersion, 1);

        const vaultVersion = `projects/${PRODUCTION_PROJECT}/secrets/chase/versions/1`;
        assert.equal((await db.collection('protectedProviderTokens').doc('chase').get()).data().latestVersion, 1);
        // Rotate the immutable version while its exchange ledger is still
        // started, retire the old key in this fresh composition, and recover
        // through link-status without the lost public token.
        const rotationEnvironment = environment({ BUDGET_TOKEN_CURRENT_KEY_ID: 'new', BUDGET_TOKEN_KEYRING_JSON: JSON.stringify({ old: OLD_KEY, new: NEW_KEY }) });
        const rotationService = await runtime.createRuntime({ environment: rotationEnvironment, context: context(), firebase, plaidClient: plaid });
        const rotated = await rotationService.tokenStore.rewrapAccessToken('chase', vaultVersion);
        assert.equal(rotated.versionName, vaultVersion);
        assert.equal(rotated.keyId, 'new');
        const newOnlyEnvironment = environment({ BUDGET_TOKEN_CURRENT_KEY_ID: 'new', BUDGET_TOKEN_KEYRING_JSON: JSON.stringify({ new: NEW_KEY }) });
        const newOnly = await runtime.createRuntime({ environment: newOnlyEnvironment, context: context(), firebase, plaidClient: plaid });
        assert.equal(await newOnly.tokenStore.resolveAccessToken('chase', vaultVersion), 'synthetic-access-token');
        const newOnlyHandler = runtime.createNetlifyHandler({ environment: newOnlyEnvironment, firebase, plaidClient: plaid });
        const recoveredStatus = await call(newOnlyHandler, `https://${SITE_HOST}/.netlify/functions/budgetTransactions/link-status`, token, { connectionKey: 'chase', requestId: EXCHANGE_ID });
        assert.equal(recoveredStatus.response.status, 200, JSON.stringify(recoveredStatus.body));
        assert.equal(recoveredStatus.body.status, 'pending-binding');
        assert.equal(recoveredStatus.body.itemId, ITEM_ID);

        const recovered = await call(newOnlyHandler, `https://${SITE_HOST}/.netlify/functions/budgetTransactions/link-exchange`, token, { connectionKey: 'chase', requestId: EXCHANGE_ID });
        assert.equal(recovered.response.status, 200, JSON.stringify(recovered.body));
        assert.equal(recovered.body.status, 'pending-binding');
        assert.equal(calls.exchange, 1, 'recovery must not exchange the one-use public token again');

        const approved = await call(newOnlyHandler, `https://${SITE_HOST}/.netlify/functions/budgetTransactions/link-exchange`, token, { connectionKey: 'chase', requestId: EXCHANGE_ID, accountBindings: { 'synthetic-checking': 'Checking Account' } });
        assert.equal(approved.response.status, 200);
        assert.equal(approved.body.accountMap['synthetic-checking'], 'Checking Account');
        const vaultDoc = await db.collection('protectedProviderTokens').doc('chase').collection('versions').doc('1').get();
        assert.equal(vaultDoc.exists, true);
        assert.equal(Object.prototype.hasOwnProperty.call(vaultDoc.data(), 'accessToken'), false);

        // A new service composition can replay the completion without the
        // lost public token, and concurrent replays remain idempotent.
        const reloaded = runtime.createNetlifyHandler({ environment: providerEnvironment, firebase, plaidClient: plaid });
        const [replayA, replayB] = await Promise.all([
            call(reloaded, `https://${SITE_HOST}/.netlify/functions/budgetTransactions/link-exchange`, token, { connectionKey: 'chase', requestId: EXCHANGE_ID }),
            call(reloaded, `https://${SITE_HOST}/.netlify/functions/budgetTransactions/link-exchange`, token, { connectionKey: 'chase', requestId: EXCHANGE_ID })
        ]);
        assert.equal(replayA.response.status, 200);
        assert.equal(replayB.response.status, 200);
        assert.equal(calls.exchange, 1);

        // Enable only the already-bound synthetic connection in this emulator
        // fixture. Production activation remains separately gated by config.
        await db.collection('protectedConnections').doc('chase').update({ enabled: true });
        const syncEnvironment = environment({ BUDGET_ACTIVE_CONNECTION_KEYS: 'chase', BUDGET_SYNC_ENABLED: 'true', BUDGET_TOKEN_CURRENT_KEY_ID: 'new', BUDGET_TOKEN_KEYRING_JSON: JSON.stringify({ new: NEW_KEY }) });
        const syncHandler = runtime.createNetlifyHandler({ environment: syncEnvironment, firebase, plaidClient: plaid });
        const beforeSyncAccepted = await db.collection('shared').doc('data').get();
        assert.equal(beforeSyncAccepted.exists, false, 'provider observations must not alter accepted totals before approval');

        const syncOne = await call(syncHandler, `https://${SITE_HOST}/.netlify/functions/budgetTransactions/sync`, token, { connectionKey: 'chase', runId: 'synthetic-sync-1' });
        assert.equal(syncOne.response.status, 200, JSON.stringify(syncOne.body));
        assert.equal(syncOne.body.staged, 1);
        assert.equal(calls.sync, 1);
        const pendingAfterSync = (await db.collection('protectedTransactionReview').doc(HOUSEHOLD).get()).data();
        const firstCandidate = pendingAfterSync.pending.map(entry => entry.value).find(value => value.sourceIdentity.includes('synthetic-provider-tx-1'));
        assert.ok(firstCandidate, 'first provider observation must be durably pending');
        assert.equal((await db.collection('shared').doc('data').get()).exists, false);

        // A second existing approved app user can review the same household,
        // while the provider connection remains owned by the first user.
        const reviewerReview = await call(syncHandler, `https://${SITE_HOST}/.netlify/functions/budgetTransactions/review`, reviewerToken, undefined, 'GET');
        assert.equal(reviewerReview.response.status, 200);
        assert.equal(reviewerReview.body.pending.length, 1);
        const edited = await call(syncHandler, `https://${SITE_HOST}/.netlify/functions/budgetTransactions/edit`, reviewerToken, { candidateId: firstCandidate.id, patch: { category: 'Restaurants', merchant: 'Edited Synthetic Merchant' }, expectedRevision: firstCandidate.revision });
        assert.equal(edited.response.status, 200, JSON.stringify(edited.body));

        // The production cooldown is hours; advancing this emulator-only
        // clock field lets the bounded fixture exercise a second cursor page
        // without waiting or weakening the deployed default.
        await db.collection('protectedConnections').doc('chase').update({ cooldownUntil: 0 });
        const syncHandlerTwo = runtime.createNetlifyHandler({ environment: syncEnvironment, firebase, plaidClient: plaid });
        const syncTwo = await call(syncHandlerTwo, `https://${SITE_HOST}/.netlify/functions/budgetTransactions/sync`, token, { connectionKey: 'chase', runId: 'synthetic-sync-2' });
        assert.equal(syncTwo.response.status, 200, JSON.stringify(syncTwo.body));
        assert.equal(syncTwo.body.staged, 1);
        assert.equal(calls.sync, 2);
        const pendingBeforeReject = (await db.collection('protectedTransactionReview').doc(HOUSEHOLD).get()).data();
        const secondCandidate = pendingBeforeReject.pending.map(entry => entry.value).find(value => value.sourceIdentity.includes('synthetic-provider-tx-2'));
        assert.ok(secondCandidate, 'second provider observation must be durably pending');
        const rejected = await call(syncHandler, `https://${SITE_HOST}/.netlify/functions/budgetTransactions/reject`, reviewerToken, { candidateId: secondCandidate.id, expectedRevision: secondCandidate.revision });
        assert.equal(rejected.response.status, 200, JSON.stringify(rejected.body));
        const pendingAfterReject = (await db.collection('protectedTransactionReview').doc(HOUSEHOLD).get()).data();
        assert.equal(pendingAfterReject.pending.some(entry => entry.value.id === secondCandidate.id), false);
        assert.equal(pendingAfterReject.rejected.some(entry => entry.value.id === secondCandidate.id), true);

        const pendingBeforeApproval = (await db.collection('protectedTransactionReview').doc(HOUSEHOLD).get()).data();
        const editedCandidate = pendingBeforeApproval.pending.map(entry => entry.value).find(value => value.id === firstCandidate.id);
        assert.ok(editedCandidate);
        const approvalBody = { candidateIds: [editedCandidate.id], revisions: [editedCandidate.revision], idempotencyKey: 'synthetic-netlify-approval-1' };
        const [approvalA, approvalB] = await Promise.all([
            call(syncHandler, `https://${SITE_HOST}/.netlify/functions/budgetTransactions/approve`, token, approvalBody),
            call(syncHandler, `https://${SITE_HOST}/.netlify/functions/budgetTransactions/approve`, token, approvalBody)
        ]);
        assert.equal(approvalA.response.status, 200, JSON.stringify(approvalA.body));
        assert.equal(approvalB.response.status, 200, JSON.stringify(approvalB.body));
        const acceptedAfterApproval = await db.collection('shared').doc('data').get();
        assert.equal(acceptedAfterApproval.exists, true);
        assert.equal(acceptedAfterApproval.data().transactions.length, 1, 'concurrent approval must remain idempotent');
        assert.equal(acceptedAfterApproval.data().transactions[0].merchant, 'Edited Synthetic Merchant');

        const freshHandler = runtime.createNetlifyHandler({ environment: syncEnvironment, firebase, plaidClient: plaid });
        const reloadedReview = await call(freshHandler, `https://${SITE_HOST}/.netlify/functions/budgetTransactions/review`, reviewerToken, undefined, 'GET');
        assert.equal(reloadedReview.response.status, 200);
        assert.equal(reloadedReview.body.pending.length, 0);
        assert.equal(reloadedReview.body.accepted.length, 1);
        assert.equal(reloadedReview.body.accepted[0].merchant, 'Edited Synthetic Merchant');

        const versionData = (await db.collection('protectedProviderTokens').doc('chase').collection('versions').doc('1').get()).data();
        const ciphertext = Buffer.from(versionData.ciphertext, 'base64url');
        ciphertext[0] ^= 1;
        await db.collection('protectedProviderTokens').doc('chase').collection('versions').doc('1').set({ ...versionData, ciphertext: ciphertext.toString('base64url') });
        const freshAfterTamper = await runtime.createRuntime({ environment: environment({ BUDGET_TOKEN_CURRENT_KEY_ID: 'new', BUDGET_TOKEN_KEYRING_JSON: JSON.stringify({ new: NEW_KEY }) }), context: context(), firebase, plaidClient: plaid });
        await assert.rejects(() => freshAfterTamper.tokenStore.resolveAccessToken('chase', vaultVersion), /Secret resolution failed/);

        const quotaStore = new (require(path.join(root, 'netlify', 'functions', '_runtime', 'production-service.js')).FirestoreEncryptedTokenStore)({ db, projectId: PRODUCTION_PROJECT, householdId: HOUSEHOLD, keyring: { new: Buffer.from(NEW_KEY, 'base64url') }, currentKeyId: 'new', maxVersions: 1 });
        await quotaStore.setAccessToken('quota-slot', 'quota-token');
        await assert.rejects(() => quotaStore.setAccessToken('quota-slot', 'quota-token-2'), /Secret storage failed/);

        await db.collection('protectedAppUsers').doc(UID).set({ allowed: true, uid: UID, email: EMAIL, householdId: 'other-household' });
        const wrongHousehold = await call(reloaded, `https://${SITE_HOST}/review`, token, undefined, 'GET');
        assert.equal(wrongHousehold.response.status, 401, JSON.stringify(wrongHousehold.body));
        console.log('PASS: Netlify Web entry and context, real Admin14 Auth/Firestore emulator persistence, encrypted vault interruption/reload/replay/concurrency/rotation/tamper/quota checks, and protected household denial.');
    } finally {
        await db.collection('protectedTransactionReview').doc(HOUSEHOLD).delete().catch(() => {});
        await db.collection('shared').doc('data').delete().catch(() => {});
        await db.collection('protectedSyncRuns').doc('synthetic-sync-1').delete().catch(() => {});
        await db.collection('protectedSyncRuns').doc('synthetic-sync-2').delete().catch(() => {});
        await db.collection('protectedAppUsers').doc(UID).delete().catch(() => {});
        await db.collection('protectedAppUsers').doc(REVIEWER_UID).delete().catch(() => {});
        await db.collection('protectedAppConfig').doc('transactionService').delete().catch(() => {});
        await db.collection('protectedConnections').doc('chase').delete().catch(() => {});
        await db.collection('protectedProviderTokens').doc('chase').collection('versions').doc('1').delete().catch(() => {});
        await db.collection('protectedProviderTokens').doc('chase').delete().catch(() => {});
        await db.collection('protectedProviderTokens').doc('quota-slot').collection('versions').doc('1').delete().catch(() => {});
        await db.collection('protectedProviderTokens').doc('quota-slot').delete().catch(() => {});
        await auth.deleteUser(UID).catch(() => {});
        await auth.deleteUser(REVIEWER_UID).catch(() => {});
        await db.terminate().catch(() => {});
        await app.delete().catch(() => {});
        for (const key of processKeys) {
            if (oldEnvironment[key] === undefined) delete process.env[key];
            else process.env[key] = oldEnvironment[key];
        }
    }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

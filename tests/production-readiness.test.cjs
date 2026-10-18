'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PassThrough } = require('node:stream');
const production = require('../production-service.js');
const backend = require('../transaction-backend.js');
const projectRoot = path.resolve(__dirname, '..');

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

class FakeDb {
    constructor() { this.docs = new Map(); this.transactionQueue = Promise.resolve(); }
    collection(name) {
        return { doc: id => {
            const key = `${name}/${id}`;
            return {
                async get() {
                    const value = this.docs;
                    return { exists: value.has(key), data: () => clone(value.get(key)) };
                }
            };
        } };
    }

    async runTransaction(callback) {
        const run = this.transactionQueue.then(async () => {
            const writes = [];
            const transaction = {
                get: async reference => reference.get(),
                set: (reference, value) => writes.push([reference, value])
            };
            const result = await callback(transaction);
            for (const [reference, value] of writes) {
                if (reference.__key) this.docs.set(reference.__key, clone(value));
                else throw new Error('fake transaction reference key missing');
            }
            return result;
        });
        this.transactionQueue = run.catch(() => undefined);
        return run;
    }
}

// Keep fake refs simple and deterministic while retaining the Firestore API
// shape consumed by the production repository.
FakeDb.prototype.collection = function collection(name) {
    return { doc: id => {
        const key = `${name}/${id}`;
        return {
            __key: key,
            __id: id,
            async get() { return { exists: thisDb.docs.has(key), data: () => clone(thisDb.docs.get(key)) }; }
        };
    } };
};
let thisDb;

class FakeSecrets {
    constructor() { this.values = new Map(); this.addCalls = []; this.readCalls = []; }
    async addSecretVersion(request) {
        this.addCalls.push(request);
        const value = request.payload.data.toString('utf8');
        this.values.set(request.parent, value);
        return [{ name: `${request.parent}/versions/1` }];
    }
    async accessSecretVersion(request) {
        this.readCalls.push(request);
        const parent = request.name.replace(/\/versions\/(?:latest|\d+)$/, '');
        return [{ payload: { data: Buffer.from(this.values.get(parent) || '') } }];
    }
}

function response() {
    return { statusCode: 0, headers: {}, body: '', setHeader(name, value) { this.headers[name] = value; }, end(value) { this.body = value || ''; } };
}

function request(method, url, body, origin) {
    return { method, url, headers: origin ? { origin } : {}, ...(body === undefined ? {} : { body }) };
}

;(async () => {
    const db = new FakeDb();
    thisDb = db;
    const secrets = new FakeSecrets();
    const store = new production.SecretManagerTokenStore({ client: secrets, projectId: 'budget-tool-sync', secretNames: { chase: 'projects/budget-tool-sync/secrets/plaid-item-chase' }, cacheTtlMs: 60_000 });
    const connections = new production.FirestoreProviderConnectionRepository({ db, allowedConnectionKeys: ['chase'], clock: () => '2026-10-18T12:00:00.000Z' });
    const calls = { link: 0, exchange: 0, accounts: 0, linkRequests: [] };
    const plaid = {
        async linkTokenCreate(request) { calls.link += 1; calls.linkRequests.push(clone(request)); return { data: { link_token: 'link-token-synthetic' } }; },
        async itemPublicTokenExchange() { calls.exchange += 1; return { data: { access_token: 'access-token-never-returned', item_id: 'item-synthetic' } }; },
        async accountsGet() { calls.accounts += 1; return { data: { accounts: [{ account_id: 'provider-checking', name: 'Checking', type: 'depository', subtype: 'checking', mask: '1234567890120820' }] } }; }
    };
    const lifecycle = new production.PlaidLinkLifecycle({ client: plaid, connections, tokenStore: store, accountAliases: ['Checking Account'], redirectUri: 'https://zmstiles-dev.github.io/oauth/callback', clock: () => '2026-10-18T12:00:00.000Z' });
    const auth = { uid: 'existing-user', email: 'existing@example.test', householdId: 'household-1', tokenVerified: true };
    const link = await lifecycle.createLinkToken(auth, { connectionKey: 'chase' });
    assert.equal(link.connectionKey, 'chase');
    assert.equal(link.mode, 'create');
    assert.equal(link.linkToken, 'link-token-synthetic');
    assert.match(link.sessionId, /^[A-Za-z0-9_-]+$/);
    assert.equal(calls.linkRequests[0].redirect_uri, 'https://zmstiles-dev.github.io/oauth/callback');
    assert.equal(Object.prototype.hasOwnProperty.call(calls.linkRequests[0], 'institutions'), false, 'Link create must not send an undocumented institution request field.');
    const first = await lifecycle.exchange(auth, { connectionKey: 'chase', publicToken: 'public-synthetic', requestId: 'exchange-1', accountBindings: { 'provider-checking': 'Checking Account' } });
    assert.deepEqual(first, { connectionKey: 'chase', itemId: 'item-synthetic', accounts: [{ accountId: 'provider-checking', name: 'Checking', officialName: '', type: 'depository', subtype: 'checking', mask: '0820' }], accountMap: { 'provider-checking': 'Checking Account' } });
    assert.equal(calls.exchange, 1);
    await assert.rejects(() => connections.getAuthorized('chase', { ...auth, uid: 'recreated-user' }), /not authorized/);
    const replay = await lifecycle.exchange(auth, { connectionKey: 'chase', requestId: 'exchange-1', accountBindings: { 'provider-checking': 'Checking Account' } });
    assert.deepEqual(replay, first);
    assert.equal(calls.exchange, 1, 'same request ID must not create a second Item');
    const reloadedLifecycle = new production.PlaidLinkLifecycle({ client: plaid, connections: new production.FirestoreProviderConnectionRepository({ db, allowedConnectionKeys: ['chase'], clock: () => '2026-10-18T12:00:00.000Z' }), tokenStore: store, accountAliases: ['Checking Account'], redirectUri: 'https://zmstiles-dev.github.io/oauth/callback', clock: () => '2026-10-18T12:00:00.000Z' });
    assert.deepEqual(await reloadedLifecycle.exchange(auth, { connectionKey: 'chase', requestId: 'exchange-1' }), first);
    const persisted = (await db.collection('protectedConnections').doc('chase').get()).data();
    assert.equal(persisted.secretName, 'projects/budget-tool-sync/secrets/plaid-item-chase');
    assert.equal(persisted.secretVersion, 'projects/budget-tool-sync/secrets/plaid-item-chase/versions/1');
    assert.equal(Object.prototype.hasOwnProperty.call(persisted, 'accessToken'), false);
    assert.equal(JSON.stringify(persisted).includes('access-token-never-returned'), false);
    const updated = await lifecycle.update(auth, { connectionKey: 'chase' });
    assert.equal(updated.connectionKey, 'chase');
    assert.equal(updated.mode, 'update');
    assert.equal(updated.linkToken, 'link-token-synthetic');
    assert.match(updated.sessionId, /^[A-Za-z0-9_-]+$/);
    assert.equal(calls.link, 2);
    assert.equal(secrets.addCalls[0].payload.data.toString('utf8'), 'access-token-never-returned');
    assert.equal(secrets.readCalls[0].name, 'projects/budget-tool-sync/secrets/plaid-item-chase/versions/1');

    await assert.rejects(() => lifecycle.exchange(auth, { connectionKey: 'chase', publicToken: 'different', requestId: 'exchange-2', accountBindings: { unknown: 'Checking Account' } }), /cannot replace an existing Item/);
    await assert.rejects(() => lifecycle.createLinkToken(auth, { connectionKey: 'unknown' }), /not configured/);

    const pendingDb = new FakeDb();
    thisDb = pendingDb;
    const pendingSecrets = new FakeSecrets();
    const pendingStore = new production.SecretManagerTokenStore({ client: pendingSecrets, projectId: 'budget-tool-sync', secretNames: { chase: 'projects/budget-tool-sync/secrets/plaid-item-chase' } });
    const pendingConnections = new production.FirestoreProviderConnectionRepository({ db: pendingDb, allowedConnectionKeys: ['chase'], clock: () => '2026-10-18T12:00:00.000Z' });
    const pendingCalls = { exchange: 0, accounts: 0 };
    const pendingPlaid = {
        async itemPublicTokenExchange() { pendingCalls.exchange += 1; return { data: { access_token: 'pending-access-token', item_id: 'pending-item' } }; },
        async accountsGet() { pendingCalls.accounts += 1; return { data: { accounts: [{ account_id: 'provider-checking', name: 'Checking', type: 'depository', subtype: 'checking' }] } }; }
    };
    const pendingLifecycle = new production.PlaidLinkLifecycle({ client: pendingPlaid, connections: pendingConnections, tokenStore: pendingStore, accountAliases: ['Checking Account'], clock: () => '2026-10-18T12:00:00.000Z' });
    const pendingStart = await pendingLifecycle.exchange(auth, { connectionKey: 'chase', publicToken: 'public-pending', requestId: 'pending-1' });
    assert.equal(pendingStart.status, 'pending-binding');
    await assert.rejects(() => pendingLifecycle.exchange(auth, { connectionKey: 'chase', publicToken: 'public-other', requestId: 'pending-2' }), /requires reconciliation/);
    assert.equal(pendingCalls.exchange, 1, 'a different request ID cannot create a second unresolved Item for the slot');
    const pendingStatus = await pendingLifecycle.status(auth, { connectionKey: 'chase', requestId: 'pending-1' });
    assert.equal(pendingStatus.status, 'pending-binding');
    assert.equal(pendingStatus.accounts[0].accountId, 'provider-checking');
    await assert.rejects(() => pendingLifecycle.exchange(auth, { connectionKey: 'chase', requestId: 'pending-1', accountBindings: { wrong: 'Checking Account' } }), /unknown provider account ID/);
    const pendingRecord = (await pendingDb.collection('protectedConnections').doc('chase').get()).data();
    assert.equal(pendingRecord.enabled, undefined, 'pending binding must remain disabled');
    assert.equal(pendingRecord.pendingExchange.itemId, 'pending-item');
    assert.equal(Object.prototype.hasOwnProperty.call(pendingRecord.pendingExchange, 'accessToken'), false);
    await assert.rejects(() => pendingLifecycle.exchange(auth, { connectionKey: 'chase', publicToken: 'different-pending', requestId: 'pending-1', accountBindings: { 'provider-checking': 'Checking Account' } }), /requires reconciliation/);
    const corrected = await pendingLifecycle.exchange(auth, { connectionKey: 'chase', publicToken: 'public-pending', requestId: 'pending-1', accountBindings: { 'provider-checking': 'Checking Account' } });
    assert.equal(corrected.itemId, 'pending-item');
    assert.equal(pendingCalls.exchange, 1, 'retry after binding validation must reuse the pinned Item');
    assert.equal(pendingSecrets.addCalls.length, 1, 'retry after binding validation must not add another secret version');
    assert.equal(pendingCalls.accounts, 4, 'retry may refresh the validated provider account list');

    const ledgerDb = new FakeDb();
    thisDb = ledgerDb;
    const ledgerConnections = new production.FirestoreProviderConnectionRepository({ db: ledgerDb, allowedConnectionKeys: ['chase'], clock: () => '2026-10-18T12:00:00.000Z' });
    const ledgerBefore = {};
    for (let index = 0; index < production.MAX_EXCHANGE_LEDGER_ENTRIES; index += 1) {
        ledgerBefore[`receipt-${index}`] = { status: index === 0 ? 'started' : index === 1 ? 'pending-binding' : index === 2 ? 'needs-reconciliation' : 'complete', publicTokenDigest: `digest-${index}` };
    }
    ledgerDb.docs.set('protectedConnections/chase', { connectionKey: 'chase', householdId: auth.householdId, ownerUid: auth.uid, ownerEmail: auth.email, exchangeLedger: ledgerBefore });
    await assert.rejects(() => ledgerConnections.claimExchange('chase', auth, 'receipt-new', 'public-new'), /ledger is full/);
    const ledgerAfter = (await ledgerDb.collection('protectedConnections').doc('chase').get()).data();
    assert.deepEqual(ledgerAfter.exchangeLedger, ledgerBefore, 'a full exchange ledger must preserve every recoverable receipt without pruning');
    await assert.rejects(() => ledgerConnections.claimExchange('chase', auth, 'receipt-0', 'different-public'), /requires reconciliation/);
    assert.deepEqual((await ledgerDb.collection('protectedConnections').doc('chase').get()).data().exchangeLedger, ledgerBefore);

    const institutionDb = new FakeDb();
    thisDb = institutionDb;
    const institutionSecrets = new FakeSecrets();
    const institutionStore = new production.SecretManagerTokenStore({ client: institutionSecrets, projectId: 'budget-tool-sync', secretNames: { chase: 'projects/budget-tool-sync/secrets/plaid-item-chase' } });
    const institutionConnections = new production.FirestoreProviderConnectionRepository({ db: institutionDb, allowedConnectionKeys: ['chase'], clock: () => '2026-10-18T12:00:00.000Z' });
    let returnedInstitution = 'ins-unexpected';
    const institutionLifecycle = new production.PlaidLinkLifecycle({
        client: {
            async itemPublicTokenExchange() { return { data: { access_token: 'institution-access', item_id: 'institution-item' } }; },
            async itemGet() { return { data: { item: { institution_id: returnedInstitution } } }; },
            async accountsGet() { return { data: { accounts: [{ account_id: 'institution-checking', name: 'Checking', type: 'depository', subtype: 'checking' }] } }; }
        },
        connections: institutionConnections,
        tokenStore: institutionStore,
        accountAliases: ['Checking Account'],
        expectedInstitutions: { chase: 'ins-expected' },
        requireExpectedInstitutions: true,
        clock: () => '2026-10-18T12:00:00.000Z'
    });
    await assert.rejects(() => institutionLifecycle.exchange(auth, { connectionKey: 'chase', publicToken: 'institution-public', requestId: 'institution-1' }), /Provider institution is not configured/);
    const institutionPending = (await institutionDb.collection('protectedConnections').doc('chase').get()).data();
    assert.equal(institutionPending.pendingExchange.itemId, 'institution-item', 'Institution rejection must leave a recoverable disabled exchange.');
    returnedInstitution = 'ins-expected';
    const institutionRetry = await institutionLifecycle.exchange(auth, { connectionKey: 'chase', requestId: 'institution-1' });
    assert.equal(institutionRetry.status, 'pending-binding');
    assert.equal(institutionSecrets.addCalls.length, 1, 'Institution retry must reuse the pinned token version.');

    const reservationDb = new FakeDb();
    thisDb = reservationDb;
    let releaseLink;
    const linkGate = new Promise(resolve => { releaseLink = resolve; });
    let reservationLinkCalls = 0;
    const reservationLifecycle = new production.PlaidLinkLifecycle({
        client: { async linkTokenCreate() { reservationLinkCalls += 1; await linkGate; return { data: { link_token: 'reserved-link-token' } }; } },
        connections: new production.FirestoreProviderConnectionRepository({ db: reservationDb, allowedConnectionKeys: ['chase'], clock: () => '2026-10-18T12:00:00.000Z' }),
        tokenStore: pendingStore,
        accountAliases: ['Checking Account'],
        clock: () => '2026-10-18T12:00:00.000Z'
    });
    const firstLink = reservationLifecycle.createLinkToken(auth, { connectionKey: 'chase', sessionId: 'session-a' });
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(() => reservationLifecycle.createLinkToken(auth, { connectionKey: 'chase', sessionId: 'session-b' }), /already in progress/);
    releaseLink();
    const reservedResult = await firstLink;
    assert.equal(reservedResult.sessionId, 'session-a');
    assert.equal(reservationLinkCalls, 1, 'concurrent Link creation must reserve the slot before provider call');
    await assert.rejects(() => reservationLifecycle.createLinkToken({ ...auth, uid: 'other-user', email: 'other@example.test', householdId: 'other-household' }, { connectionKey: 'chase', sessionId: 'session-c' }), /configured for this household/);

    const admin = { auth: () => ({ verifyIdToken: async token => token === 'good' ? { uid: 'existing-user', email: 'existing@example.test', email_verified: true, auth_time: 1 } : (() => { throw new Error('bad token'); })() }) };
    const authenticate = production.createProductionAuthenticator({ admin, allowedUsers: ['existing@example.test'], householdId: 'household-1' });
    assert.deepEqual(await authenticate({ headers: { authorization: 'Bearer good' } }), { uid: 'existing-user', email: 'existing@example.test', householdId: 'household-1', tokenVerified: true, existingAppUser: true, authTime: 1 });
    await assert.rejects(() => authenticate({ headers: { authorization: 'Bearer bad' } }), /existing app user/);
    assert.throws(() => production.createProductionAuthenticator({ admin, householdId: 'household-1' }), /authorization is not configured/);
    const uidAdmin = { auth: () => ({ verifyIdToken: async token => ({ uid: token === 'uid-good' ? 'MixedCaseUid' : 'mixedcaseuid', email: 'uid@example.test', email_verified: true, auth_time: 2 }) }) };
    const uidAuthenticate = production.createProductionAuthenticator({ admin: uidAdmin, allowedUsers: ['MixedCaseUid'], householdId: 'household-1' });
    assert.equal((await uidAuthenticate({ headers: { authorization: 'Bearer uid-good' } })).uid, 'MixedCaseUid');
    await assert.rejects(() => uidAuthenticate({ headers: { authorization: 'Bearer uid-bad' } }), /existing app user/);
    const membershipDb = new FakeDb();
    thisDb = membershipDb;
    membershipDb.docs.set('protectedAppConfig/transactionService', { allowed: true, householdId: 'household-1' });
    membershipDb.docs.set('protectedAppUsers/MixedCaseUid', { allowed: true, uid: 'MixedCaseUid', email: 'uid@example.test', householdId: 'household-1' });
    const membershipResolver = production.createFirestoreExistingAppUserResolver({ db: membershipDb, householdId: 'household-1' });
    const membershipAuthenticate = production.createProductionAuthenticator({ admin: uidAdmin, householdId: 'household-1', existingAppUserResolver: membershipResolver });
    assert.equal((await membershipAuthenticate({ headers: { authorization: 'Bearer uid-good' } })).householdId, 'household-1');
    assert.equal((await membershipResolver({ uid: 'MixedCaseUid', email: 'uid@example.test', email_verified: true })).allowed, true, 'membership binding does not require a new household claim');
    assert.equal((await membershipResolver({ uid: 'MixedCaseUid', email: 'UID@EXAMPLE.TEST', email_verified: true })).allowed, false, 'uppercase token email must not diverge from Firestore rules');
    membershipDb.docs.set('protectedAppUsers/EmptyHouseholdUid', { allowed: true, uid: 'EmptyHouseholdUid', email: 'empty@example.test', householdId: '' });
    assert.equal((await membershipResolver({ uid: 'EmptyHouseholdUid', email: 'empty@example.test', email_verified: true })).allowed, false, 'empty household membership must fail closed');
    membershipDb.docs.set('protectedAppUsers/WhitespaceHouseholdUid', { allowed: true, uid: 'WhitespaceHouseholdUid', email: 'whitespace@example.test', householdId: ' household-1' });
    assert.equal((await membershipResolver({ uid: 'WhitespaceHouseholdUid', email: 'whitespace@example.test', email_verified: true })).allowed, false, 'whitespace household membership must match rules canonical form');
    membershipDb.docs.set('protectedAppUsers/WhitespaceUid', { allowed: true, uid: ' WhitespaceUid', email: 'uid@example.test', householdId: 'household-1' });
    assert.equal((await membershipResolver({ uid: 'WhitespaceUid', email: 'uid@example.test', email_verified: true })).allowed, false, 'whitespace UID binding must fail closed');
    membershipDb.docs.set('protectedAppUsers/OtherHouseholdUid', { allowed: true, uid: 'OtherHouseholdUid', email: 'uid@example.test', householdId: 'household-2' });
    const otherHouseholdResolver = production.createFirestoreExistingAppUserResolver({ db: membershipDb, householdId: 'household-1' });
    assert.equal((await otherHouseholdResolver({ uid: 'OtherHouseholdUid', email: 'uid@example.test', email_verified: true })).allowed, false, 'membership from another household must fail closed');
    membershipDb.docs.set('protectedAppUsers/MissingUid', { allowed: true, email: 'uid@example.test', householdId: 'household-1' });
    const missingUidResolver = production.createFirestoreExistingAppUserResolver({ db: membershipDb, householdId: 'household-1' });
    assert.equal((await missingUidResolver({ uid: 'MissingUid', email: 'uid@example.test', email_verified: true, household_id: 'household-1' })).allowed, false);

    const policyDb = new FakeDb();
    thisDb = policyDb;
    const policySecrets = new FakeSecrets();
    const policyStore = new production.SecretManagerTokenStore({ client: policySecrets, projectId: 'budget-tool-sync', secretNames: {
        chase: 'projects/budget-tool-sync/secrets/plaid-item-chase',
        'capital-one': 'projects/budget-tool-sync/secrets/plaid-item-capital-one'
    } });
    const policyConnections = new production.FirestoreProviderConnectionRepository({ db: policyDb, allowedConnectionKeys: ['chase', 'capital-one'], clock: () => '2026-10-18T12:00:00.000Z' });
    const policyPlaid = {
        async itemPublicTokenExchange(request) { return { data: { access_token: `policy-${request.public_token}`, item_id: `item-${request.public_token}` } }; },
        async accountsGet(request) { return { data: { accounts: [{ account_id: request.access_token.includes('capital') ? 'capital-card' : 'chase-card', name: 'Account', type: 'credit', subtype: 'credit card', balances: { iso_currency_code: 'USD' } }] } }; }
    };
    const policyLifecycle = new production.PlaidLinkLifecycle({
        client: policyPlaid,
        connections: policyConnections,
        tokenStore: policyStore,
        accountAliases: ['Checking Account', 'CFF', 'CFU', 'CSP', 'Ven X'],
        accountAliasesByConnection: { chase: ['Checking Account', 'CFF', 'CFU', 'CSP'], 'capital-one': ['Ven X'] },
        accountPolicies: { chase: { aliases: {
            'Checking Account': { types: ['depository'], subtypes: ['checking'], currency: 'USD' },
            CFF: { types: ['credit'], subtypes: ['credit card'], currency: 'USD' },
            CFU: { types: ['credit'], subtypes: ['credit card'], currency: 'USD' },
            CSP: { types: ['credit'], subtypes: ['credit card'], currency: 'USD' }
        } }, 'capital-one': { aliases: { 'Ven X': { types: ['credit'], subtypes: ['credit card'], currency: 'USD' } } } },
        clock: () => '2026-10-18T12:00:00.000Z'
    });
    const policyChase = await policyLifecycle.exchange(auth, { connectionKey: 'chase', publicToken: 'chase-public', requestId: 'policy-chase', accountBindings: { 'chase-card': 'CFF' } });
    assert.equal(policyChase.accountMap['chase-card'], 'CFF');
    await assert.rejects(() => policyLifecycle.exchange(auth, { connectionKey: 'capital-one', publicToken: 'capital-public', requestId: 'policy-capital', accountBindings: { 'capital-card': 'CFF' } }), /unsupported display account/);

    const syncRequests = [];
    const syncPages = Array.from({ length: 5 }, (_, index) => ({
        added: [{ transaction_id: `sync-${index + 1}`, date: '2026-10-10', amount: index + 1, account_id: 'provider-checking', currency_code: 'USD', name: `Synthetic page ${index + 1}`, category: 'Groceries' }],
        modified: [], removed: [], has_more: index < 4, next_cursor: `cursor-${index + 1}`
    }));
    const syncAdapter = new backend.PlaidTransactionsSyncAdapter({
        accountMap: { 'provider-checking': 'Checking Account' },
        maxRetries: 0,
        client: { async sync(payload, control) { syncRequests.push({ payload: clone(payload), control: clone(control) }); return syncPages[syncRequests.length - 1]; } }
    });
    const syncResult = await syncAdapter.fetchDelta({ connectionKey: 'chase', accessToken: 'server-only-access-token', cursor: '', cutoverDate: '2026-10-09', deadlineAt: Date.now() + 10000, signal: { aborted: false } });
    assert.equal(syncResult.pages.length, 5, 'initial sync must paginate beyond four pages');
    assert.equal(syncResult.cursor, 'cursor-5');
    assert.equal(syncResult.counts.resultingRecords, 5);
    assert.deepEqual(Object.keys(syncRequests[0].payload).sort(), ['access_token', 'count', 'cursor']);
    assert.equal(syncRequests[0].payload.access_token, 'server-only-access-token');
    assert.equal(syncRequests[0].payload.count, 500);
    assert.equal(Object.prototype.hasOwnProperty.call(syncRequests[0].payload, 'deadlineAt'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(syncRequests[0].payload, 'signal'), false);
    assert.equal(syncRequests[0].control.deadlineAt > Date.now(), true);

    const functionsEntry = require(path.join(projectRoot, 'functions', 'index.js'));
    const functionsSource = fs.readFileSync(path.join(projectRoot, 'functions', 'index.js'), 'utf8');
    assert.match(functionsSource, /const PINNED_MEMBERSHIP_COLLECTION = 'protectedAppUsers'/);
    assert.match(functionsSource, /const PINNED_CONFIG_COLLECTION = 'protectedAppConfig'/);
    assert.match(functionsSource, /const PINNED_CONFIG_DOCUMENT = 'transactionService'/);
    assert.match(functionsSource, /configuredRoster\.length/);
    assert.match(functionsSource, /allowedUsers: \[\]/);
    assert.match(functionsSource, /collection: PINNED_MEMBERSHIP_COLLECTION/);
    assert.match(functionsSource, /configCollection: PINNED_CONFIG_COLLECTION/);
    assert.match(functionsSource, /configDocument: PINNED_CONFIG_DOCUMENT/);
    const sdkRequests = [];
    class CapturingPlaidClient {
        constructor(configuration) { this.configuration = configuration; }
        async transactionsSync(payload, options) { sdkRequests.push({ payload: clone(payload), options: { ...options } }); return { data: { added: [], modified: [], removed: [], has_more: false, next_cursor: 'sdk-cursor' } }; }
    }
    const lazyClient = functionsEntry.lazyPlaidClient('synthetic-client-id', 'projects/budget-tool-sync/secrets/client', { resolveSecret: async () => 'synthetic-client-secret', PlaidApi: CapturingPlaidClient });
    await lazyClient.transactionsSync({ access_token: 'server-only-access-token', cursor: 'sdk-cursor-0', deadlineAt: Date.now() + 5000, signal: { aborted: false } }, { deadlineAt: Date.now() + 5000, signal: { aborted: false } });
    assert.deepEqual(Object.keys(sdkRequests[0].payload).sort(), ['access_token', 'count', 'cursor']);
    assert.equal(sdkRequests[0].payload.count, 500);
    assert.equal(Object.prototype.hasOwnProperty.call(sdkRequests[0].payload, 'deadlineAt'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(sdkRequests[0].payload, 'signal'), false);
    assert.ok(sdkRequests[0].options.timeout <= 5000 && sdkRequests[0].options.timeout > 0);

    const seenBodies = [];
    const productionHandler = production.createProductionHttpHandler({
        authenticate: async () => auth,
        linkEnabled: true,
        lifecycle: { createLinkToken: async (_auth, body) => ({ received: body }), exchange: async () => ({}), update: async () => ({}) },
        reviewHandler: async (req, res) => {
            const body = await production.readRequestBody(req);
            seenBodies.push(body);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
        }
    });
    const parsedResponse = response();
    await productionHandler(request('POST', '/link-token', { connectionKey: 'chase' }, production.PRODUCTION_ORIGIN), parsedResponse);
    assert.deepEqual(JSON.parse(parsedResponse.body), { received: { connectionKey: 'chase' } });
    assert.equal(parsedResponse.headers['Cache-Control'], 'no-store');
    const rawResponse = response();
    const raw = new PassThrough();
    Object.assign(raw, request('POST', '/review', undefined, production.PRODUCTION_ORIGIN));
    const reviewPromise = productionHandler(raw, rawResponse);
    raw.end(JSON.stringify({ hello: 'raw' }));
    await reviewPromise;
    assert.deepEqual(seenBodies, [{ hello: 'raw' }]);
    const corsResponse = response();
    await productionHandler(request('POST', '/link-token', {}, 'https://evil.example'), corsResponse);
    assert.equal(corsResponse.statusCode, 403);
    assert.equal(JSON.parse(corsResponse.body).error, 'CORS origin is not allowed.');

    const disabledResponse = response();
    const disabledHandler = production.createProductionHttpHandler({
        authenticate: async () => auth,
        lifecycle: { createLinkToken: async () => ({}) },
        reviewHandler: async () => {},
        linkEnabled: false
    });
    await disabledHandler(request('POST', '/link-token', {}, production.PRODUCTION_ORIGIN), disabledResponse);
    assert.equal(JSON.parse(disabledResponse.body).error, 'Provider Link operations are disabled by server configuration.');

    const browserRequests = [];
    const browserClient = new backend.BrowserApprovalClient({
        endpoint: 'https://functions.example',
        auth: { currentUser: { async getIdToken() { return 'fresh-token'; } } },
        fetch: async (url, options) => {
            browserRequests.push({ url, options });
            return { ok: true, async json() { return { ok: true }; } };
        }
    });
    await browserClient.createLinkToken('chase', 'session-browser');
    await browserClient.exchangeLink('chase', 'public-browser', { account: 'Checking Account' }, 'exchange-browser');
    await browserClient.linkStatus('chase', 'exchange-browser');
    await browserClient.updateLinkToken('chase');
    assert.deepEqual(browserRequests.map(value => new URL(value.url).pathname), ['/link-token', '/link-exchange', '/link-status', '/link-update']);
    assert.equal(JSON.parse(browserRequests[1].options.body).publicToken, 'public-browser');

    const browserSource = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
    const deploymentConfig = require(path.join(projectRoot, 'deployment-config.template.js'));
    assert.deepEqual(deploymentConfig, {
        TRANSACTION_APPROVAL_ENDPOINT: '',
        TRANSACTION_LINK_ENABLED: false,
        TRANSACTION_SYNC_ENABLED: false,
        TRANSACTION_LINK_CONNECTIONS: [],
        TRANSACTION_SYNC_CONNECTIONS: []
    });
    const deploymentPreview = JSON.parse(execFileSync(process.execPath, ['scripts/preview-deployment-config.cjs'], { cwd: projectRoot, encoding: 'utf8' }));
    assert.deepEqual(deploymentPreview, { endpoint: deploymentConfig.TRANSACTION_APPROVAL_ENDPOINT, linkEnabled: false, syncEnabled: false, linkConnections: [], syncConnections: [] });
    assert.match(browserSource, /deployment-config\.template\.js/);
    assert.match(browserSource, /receivedRedirectUri/);
    assert.match(browserSource, /sessionStorage/);
    assert.match(browserSource, /oauth_state_id/);
    assert.match(browserSource, /linkStatus/);
    assert.match(browserSource, /serverBacked === true/);
    assert.match(browserSource, /service\.listPending\(\)/);
    assert.match(browserSource, /standalone fallback/i);

    const packageOutput = path.join(projectRoot, 'functions', 'lib');
    const unexpectedOutput = path.join(packageOutput, 'unexpected-local-file.txt');
    fs.writeFileSync(unexpectedOutput, 'must not be removed silently');
    try {
        assert.throws(() => execFileSync(process.execPath, ['functions/prepare.js'], { cwd: projectRoot, stdio: 'pipe' }), /Unexpected deployment output entry/);
    } finally {
        fs.rmSync(unexpectedOutput, { force: true });
    }
    execFileSync(process.execPath, ['functions/prepare.js'], { cwd: projectRoot, stdio: 'pipe' });
    const packageManifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'functions', 'lib', 'manifest.json'), 'utf8'));
    assert.deepEqual(Object.keys(packageManifest.files).sort(), ['production-service.js', 'transaction-backend.js', 'transaction-config.js', 'transaction-review.js', 'transaction-service.js'].sort());
    assert.equal(fs.existsSync(path.join(projectRoot, 'functions', 'lib', 'budget-data.json')), false);
    const endpointMetadata = JSON.parse(execFileSync(process.execPath, ['-e', "const endpoint=require('./index.js').budgetTransactions.__endpoint; console.log(JSON.stringify({ region:endpoint.region, timeoutSeconds:endpoint.timeoutSeconds, concurrency:endpoint.concurrency, minInstances:endpoint.minInstances, maxInstances:endpoint.maxInstances, serviceAccountEmail:endpoint.serviceAccountEmail }));"], { cwd: path.join(projectRoot, 'functions'), encoding: 'utf8' }).trim());
    assert.deepEqual(endpointMetadata, { region: ['us-central1'], timeoutSeconds: 60, concurrency: 4, minInstances: 0, maxInstances: 1, serviceAccountEmail: 'budget-transactions-runtime@budget-tool-sync.iam.gserviceaccount.com' });
    const plaidMetadata = JSON.parse(execFileSync(process.execPath, ['-e', "const {Configuration,PlaidApi,PlaidEnvironments}=require('plaid'); const c=new Configuration({basePath:PlaidEnvironments.production,baseOptions:{timeout:10000,headers:{'PLAID-CLIENT-ID':'synthetic','PLAID-SECRET':'synthetic'}}}); const a=new PlaidApi(c); a.axios.request=async o=>{ console.log(JSON.stringify({ basePath:a.basePath, timeout:o.timeout })); return { data:{} }; }; a.accountsGet({ access_token:'synthetic' });"], { cwd: path.join(projectRoot, 'functions'), encoding: 'utf8' }).trim());
    assert.deepEqual(plaidMetadata, { basePath: 'https://production.plaid.com', timeout: 10000 });

    console.log('PASS: production parsed/raw body adapter, exact-origin CORS, existing-user auth, Secret Manager token references, durable Link exchange idempotence, update flow, and stable account bindings.');
})().catch(error => { console.error(error); process.exitCode = 1; });

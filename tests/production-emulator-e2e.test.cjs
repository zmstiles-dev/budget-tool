'use strict';

/*
 * Local-only production composition check. The Firebase Auth and Firestore
 * emulators provide the real Admin verification and transaction persistence;
 * Plaid and Secret Manager remain injected and never leave this process.
 */
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const path = require('node:path');
const { createRequire } = require('node:module');
const requireFunctionsDependency = createRequire(path.resolve(__dirname, '..', 'functions', 'package.json'));
const { cert, initializeApp } = requireFunctionsDependency('firebase-admin/app');
const { getAuth } = requireFunctionsDependency('firebase-admin/auth');
const { getFirestore } = requireFunctionsDependency('firebase-admin/firestore');
const production = require('../production-service.js');

const PROJECT_ID = 'demo-budget-tool';
const AUTH_HOST = '127.0.0.1:9099';
const FIRESTORE_HOST = '127.0.0.1:8088';
const ORIGIN = production.PRODUCTION_ORIGIN;
const EMAIL = 'production-integration@example.test';
const PASSWORD = 'production-integration-password-1';
const UID = 'production-integration-user';
const HOUSEHOLD = 'production-integration-household';
const ACCEPTED_DOCUMENT = 'production-integration-accepted';

function requireLocalEnvironment() {
    assert.equal(process.env.GCLOUD_PROJECT, PROJECT_ID);
    assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, AUTH_HOST);
    assert.equal(process.env.FIRESTORE_EMULATOR_HOST, FIRESTORE_HOST);
}

async function getIdToken() {
    const response = await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${PROJECT_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true })
    });
    const body = await response.json();
    assert.equal(response.ok, true, `Auth emulator sign-in failed (${response.status}).`);
    return body.idToken;
}

function response() {
    return { statusCode: 0, headers: {}, body: '', setHeader(name, value) { this.headers[name] = value; }, end(value) { this.body = value || ''; } };
}

async function call(handler, method, url, token, body) {
    const req = { method, url, headers: { origin: ORIGIN, authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body }) };
    const res = response();
    await handler(req, res);
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : {} };
}

;(async () => {
    requireLocalEnvironment();
    process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: PROJECT_ID });
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const app = initializeApp({ projectId: PROJECT_ID, credential: cert({ projectId: PROJECT_ID, clientEmail: 'synthetic-emulator@demo-budget-tool.invalid', privateKey }) });
    const auth = getAuth(app);
    const db = getFirestore(app);
    const adminAdapter = { auth: () => auth };
    let service;
    const secretValues = new Map();
    const secretManager = {
        async addSecretVersion(request) {
            const value = request.payload.data.toString('utf8');
            secretValues.set(request.parent, value);
            return [{ name: `${request.parent}/versions/1` }];
        },
        async accessSecretVersion(request) {
            const parent = request.name.replace(/\/versions\/(?:latest|\d+)$/, '');
            return [{ payload: { data: Buffer.from(secretValues.get(parent) || '') } }];
        }
    };
    try {
        try { await auth.deleteUser(UID); } catch (_) { /* fresh emulator or prior local run */ }
        await auth.createUser({ uid: UID, email: EMAIL, password: PASSWORD, emailVerified: true });
        await db.collection('protectedAppConfig').doc('transactionService').set({ allowed: true, householdId: HOUSEHOLD });
        await db.collection('protectedAppUsers').doc(UID).set({ allowed: true, uid: UID, email: EMAIL, householdId: HOUSEHOLD });
        service = production.createProductionService({
            db,
            admin: adminAdapter,
            projectId: PROJECT_ID,
            householdId: HOUSEHOLD,
            allowedUsers: [],
            existingAppUserResolver: production.createFirestoreExistingAppUserResolver({ db, householdId: HOUSEHOLD }),
            allowedConnectionKeys: ['chase'],
            secretManagerClient: secretManager,
            secretNames: { chase: `projects/${PROJECT_ID}/secrets/plaid-item-chase` },
            plaidClient: {
                async linkTokenCreate() { throw new Error('Provider Link is disabled in this integration test.'); },
                async itemPublicTokenExchange() { throw new Error('Provider Link is disabled in this integration test.'); },
                async accountsGet() { throw new Error('Provider Link is disabled in this integration test.'); }
            },
            accountAliases: ['Checking Account'],
            linkEnabled: false,
            syncEnabled: false,
            reviewCollection: 'protectedTransactionReview',
            acceptedCollection: 'shared',
            acceptedDocumentId: ACCEPTED_DOCUMENT
        });
        const token = await getIdToken();
        const review = await call(service.handler, 'GET', '/review', token);
        assert.equal(review.status, 200);
        assert.deepEqual(review.body.pending, []);

        const candidate = {
            sourceId: 'production-emulator-candidate', sourceIdentity: 'production-emulator-candidate', sourceRevision: '1',
            date: '2026-10-17', description: 'Production composition coffee', amount: -4.25,
            category: 'Restaurants', account: 'Checking Account', payment_method: 'Checking Account', type: 'expense'
        };
        const staged = await call(service.handler, 'POST', '/stage', token, { source: 'bank-csv', records: [candidate] });
        assert.equal(staged.status, 200);
        assert.equal(staged.body.candidates.length, 1);
        const stagedCandidate = staged.body.candidates[0];
        const persistedPending = await db.collection('protectedTransactionReview').doc(HOUSEHOLD).get();
        assert.equal(persistedPending.exists, true);
        assert.equal(persistedPending.data().pending.length, 1);

        const approval = { candidateIds: [stagedCandidate.id], revisions: [stagedCandidate.revision], idempotencyKey: 'production-emulator-approval-1' };
        const approved = await call(service.handler, 'POST', '/approve', token, approval);
        assert.equal(approved.status, 200);
        const acceptedRef = db.collection('shared').doc(ACCEPTED_DOCUMENT);
        const persistedAccepted = await acceptedRef.get();
        assert.equal(persistedAccepted.exists, true);
        assert.equal(persistedAccepted.data().transactions.length, 1);
        assert.equal(persistedAccepted.data().transactions[0].description, candidate.description);
        const replay = await call(service.handler, 'POST', '/approve', token, approval);
        assert.equal(replay.status, 200);
        assert.equal((await acceptedRef.get()).data().transactions.length, 1, 'durable production approval replay must remain idempotent');

        const unauthenticated = response();
        await service.handler({ method: 'GET', url: '/review', headers: { origin: ORIGIN } }, unauthenticated);
        assert.equal(unauthenticated.statusCode, 401);
        console.log('PASS: configured production service used emulator-verified Auth, Firestore durable review/approval persistence, injected provider/Secret Manager clients, and idempotent replay.');
    } finally {
        await db.collection('protectedTransactionReview').doc(HOUSEHOLD).delete().catch(() => {});
        await db.collection('shared').doc(ACCEPTED_DOCUMENT).delete().catch(() => {});
        await db.collection('protectedAppUsers').doc(UID).delete().catch(() => {});
        await db.collection('protectedAppConfig').doc('transactionService').delete().catch(() => {});
        await auth.deleteUser(UID).catch(() => {});
        await db.terminate().catch(() => {});
        await app.delete().catch(() => {});
    }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

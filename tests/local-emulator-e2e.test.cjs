'use strict';

/*
 * Local-only app exercise. The firebase CLI must start the demo Auth and
 * Firestore emulators before this file runs. The test refuses any non-loopback
 * or non-demo environment before initializing Admin SDK or serving the app.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.BUDGET_TOOL_PLAYWRIGHT_BROWSERS_PATH || 'D:\\Documents\\Codex\\.assistant-storage\\playwright-browsers';
const admin = require('firebase-admin');
const { chromium } = require('playwright');
const { createBudgetService } = require('../transaction-service.js');

const ROOT = path.resolve(__dirname, '..');
const PROJECT_ID = 'demo-budget-tool';
const AUTH_HOST = '127.0.0.1:9099';
const FIRESTORE_HOST = '127.0.0.1:8088';
const ALLOWED_EMAIL = 'captainicebow@gmail.com';
const ALLOWED_PASSWORD = 'local-e2e-password-1';
const UNAPPROVED_EMAIL = 'local-unapproved@example.test';
const UNAPPROVED_PASSWORD = 'local-e2e-password-2';
const UNVERIFIED_EMAIL = 'mgstiles13@gmail.com';
const UNVERIFIED_PASSWORD = 'local-e2e-password-3';

function requireLocalEnvironment() {
    if (process.env.GCLOUD_PROJECT !== PROJECT_ID) throw new Error('Local E2E requires GCLOUD_PROJECT=demo-budget-tool.');
    if (process.env.FIRESTORE_EMULATOR_HOST !== FIRESTORE_HOST) throw new Error('Local E2E requires FIRESTORE_EMULATOR_HOST=127.0.0.1:8088.');
    if (process.env.FIREBASE_AUTH_EMULATOR_HOST !== AUTH_HOST) throw new Error('Local E2E requires FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099.');
}

function initialState() {
    return {
        transactions: [],
        categories: [{ name: 'Restaurants', type: 'expense' }],
        budgets: {},
        merchantDefaults: {},
        categoryGroups: [],
        categoryColors: {},
        categoryOrder: [],
        revision: 0
    };
}

async function ensureUser(auth, user) {
    try { await auth.deleteUser(user.uid); } catch (_) { /* fresh emulator or prior test user */ }
    try {
        const existingByEmail = await auth.getUserByEmail(user.email);
        if (existingByEmail.uid !== user.uid) await auth.deleteUser(existingByEmail.uid);
    } catch (_) { /* fresh emulator or no conflicting email */ }
    return auth.createUser(user);
}

async function getIdToken(email, password) {
    const response = await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-budget-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true })
    });
    const body = await response.json();
    if (!response.ok || !body.idToken) throw new Error(`Auth emulator sign-in failed (${response.status}).`);
    return body.idToken;
}

function staticResponse(request, response) {
    const requested = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    const pathname = requested === '/' ? '/index.html' : requested;
    const assets = new Map([
        ['/index.html', ['index.html', 'text/html; charset=utf-8']],
        ['/deployment-config.template.js', ['deployment-config.template.js', 'application/javascript; charset=utf-8']],
        ['/transaction-config.js', ['transaction-config.js', 'application/javascript; charset=utf-8']],
        ['/transaction-validation.js', ['transaction-validation.js', 'application/javascript; charset=utf-8']],
        ['/transaction-review.js', ['transaction-review.js', 'application/javascript; charset=utf-8']],
        ['/transaction-backend.js', ['transaction-backend.js', 'application/javascript; charset=utf-8']],
        ['/transaction-service.js', ['transaction-service.js', 'application/javascript; charset=utf-8']]
    ]);
    const asset = assets.get(pathname);
    if (!asset) { response.writeHead(404); response.end(); return; }
    fs.readFile(path.join(ROOT, asset[0]), (error, contents) => {
        if (error) { response.writeHead(404); response.end(); return; }
        response.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store' });
        response.end(contents);
    });
}

function createAppServer(service) {
    const apiPaths = new Set(['/pending', '/review', '/stage', '/approve', '/accepted-state', '/edit', '/split', '/reject', '/defer', '/cancel', '/restore', '/reset', '/sync']);
    return http.createServer((request, response) => {
        const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
        if (apiPaths.has(pathname) || request.method === 'OPTIONS' && apiPaths.has(pathname)) return service.handler(request, response);
        return staticResponse(request, response);
    });
}

function firestoreDoc(db, collection, id) {
    return db.collection(collection).doc(id);
}

async function waitForDocument(db, collection, id, predicate) {
    let latest = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
        const snapshot = await firestoreDoc(db, collection, id).get();
        if (snapshot.exists) {
            latest = snapshot.data();
            if (predicate(latest)) return latest;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${collection}/${id}: ${JSON.stringify(latest)}`);
}

async function drainBrowserSaveQueue(page) {
    await page.evaluate(async () => {
        const queue = typeof firestoreSaveQueue !== 'undefined' ? firestoreSaveQueue : Promise.resolve();
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timed out draining browser Firestore save queue.')), 5000);
            Promise.resolve(queue).then(() => { clearTimeout(timeout); resolve(); }, error => { clearTimeout(timeout); reject(error); });
        });
    });
}

async function readJson(response) {
    const body = await response.json();
    return { status: response.status, body };
}

(async () => {
    requireLocalEnvironment();
    process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: PROJECT_ID });
    const app = admin.initializeApp({ projectId: PROJECT_ID });
    const auth = admin.auth(app);
    const db = admin.firestore(app);
    await ensureUser(auth, { uid: 'local-e2e-allowed', email: ALLOWED_EMAIL, password: ALLOWED_PASSWORD, emailVerified: true });
    await ensureUser(auth, { uid: 'local-e2e-unapproved', email: UNAPPROVED_EMAIL, password: UNAPPROVED_PASSWORD, emailVerified: true });
    await ensureUser(auth, { uid: 'local-e2e-unverified', email: UNVERIFIED_EMAIL, password: UNVERIFIED_PASSWORD, emailVerified: false });
    await firestoreDoc(db, 'protectedAppConfig', 'transactionService').set({ allowed: true, householdId: 'local-e2e-household' });
    await firestoreDoc(db, 'protectedAppUsers', 'local-e2e-allowed').set({ allowed: true, uid: 'local-e2e-allowed', email: ALLOWED_EMAIL, householdId: 'local-e2e-household' });
    await firestoreDoc(db, 'shared', 'data').set(initialState());
    const backendApi = require('../transaction-backend.js');

    let failNextCommit = false;
    let syncCalls = 0;
    const mockPlaid = new backendApi.PlaidTransactionsSyncAdapter({
        accountMap: { 'synthetic-account': 'Checking Account' },
        client: {
            async sync() {
                syncCalls += 1;
                return {
                    added: [{ transaction_id: 'txn-1', date: '2026-10-16', amount: 4.25, account_id: 'synthetic-account', currency_code: 'USD', name: 'Local emulator coffee', merchant_name: 'Local emulator coffee', category: 'Restaurants' }],
                    modified: [], removed: [], has_more: false, next_cursor: 'sandbox-test-cursor'
                };
            }
        }
    });
    const repositoryDb = {
        collection: name => db.collection(name),
        async runTransaction(callback) {
            if (!failNextCommit) return db.runTransaction(callback);
            const writes = [];
            const transaction = {
                get: reference => reference.get(),
                set: (reference, value) => writes.push([reference, value]),
                delete: reference => writes.push([reference, null])
            };
            try { await callback(transaction); } finally { failNextCommit = false; }
            throw new Error('Synthetic Firestore commit failure.');
        }
    };
    const composed = createBudgetService({
        db: repositoryDb,
        admin,
        householdId: 'local-e2e-household',
        allowedUsers: [ALLOWED_EMAIL, UNVERIFIED_EMAIL],
        allowedOrigins: [],
        syncEnabled: true,
        connectionOwners: { 'sandbox-test': 'local-e2e-allowed' },
        connectionResolver: async () => ({ accessToken: 'synthetic-plaid-token' }),
        provider: mockPlaid
    });

    let server;
    let browser;
    let page;
    let badPage;
    const dialogs = [];
    const pageErrors = [];
    try {
        server = createAppServer(composed);
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        const port = server.address().port;
        const origin = `http://127.0.0.1:${port}`;
        // CORS is exact-origin even though the browser calls this same origin.
        composed.handler = backendApi.createHttpHandler({
            backend: composed.backend,
            syncService: composed.syncService,
            admin,
            householdId: 'local-e2e-household',
            allowedUsers: [ALLOWED_EMAIL, UNVERIFIED_EMAIL],
            allowedOrigins: [origin]
        });
        browser = await chromium.launch({ headless: true });
        page = await browser.newPage();
        page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
        page.on('pageerror', error => pageErrors.push(error));
        await page.addInitScript(({ endpoint }) => {
            window.TRANSACTION_APPROVAL_ENDPOINT = endpoint;
            window.TRANSACTION_SYNC_ENABLED = true;
            window.TRANSACTION_SYNC_CONNECTIONS = ['sandbox-test'];
            window.__BUDGET_TOOL_LOCAL_EMULATOR__ = {
                projectId: 'demo-budget-tool',
                auth: { host: '127.0.0.1', port: 9099 },
                firestore: { host: '127.0.0.1', port: 8088 }
            };
        }, { endpoint: origin });
        await page.route('**/*', async route => {
            const requestUrl = new URL(route.request().url());
            if (requestUrl.hostname === '127.0.0.1' && [String(port), '9099', '8088'].includes(requestUrl.port)) return route.continue();
            const filename = requestUrl.pathname.split('/').pop();
            if (requestUrl.hostname === 'www.gstatic.com' && ['firebase-app-compat.js', 'firebase-auth-compat.js', 'firebase-firestore-compat.js'].includes(filename)) {
                const file = path.join(process.env.BUDGET_TOOL_LOCAL_DEPS || '', 'firebase', filename);
                return route.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(file) });
            }
            if (requestUrl.hostname === 'cdnjs.cloudflare.com') return route.fulfill({ contentType: 'application/javascript', body: 'window.Papa = { parse() {} };' });
            if (requestUrl.hostname === 'cdn.jsdelivr.net') return route.fulfill({ contentType: 'application/javascript', body: 'window.Chart = class { destroy() {} };' });
            return route.abort('blockedbyclient');
        });
        badPage = await browser.newPage();
        const badPageErrors = [];
        badPage.on('pageerror', error => badPageErrors.push(error));
        await badPage.addInitScript(() => {
            window.__BUDGET_TOOL_LOCAL_EMULATOR__ = {
                projectId: 'demo-budget-tool',
                auth: { host: '192.0.2.1', port: 9099 },
                firestore: { host: '127.0.0.1', port: 8088 }
            };
        });
        await badPage.route('**/*', async route => {
            const requestUrl = new URL(route.request().url());
            if (requestUrl.hostname === '127.0.0.1' && [String(port), '9099', '8088'].includes(requestUrl.port)) return route.continue();
            const filename = requestUrl.pathname.split('/').pop();
            if (requestUrl.hostname === 'www.gstatic.com' && ['firebase-app-compat.js', 'firebase-auth-compat.js', 'firebase-firestore-compat.js'].includes(filename)) {
                const file = path.join(process.env.BUDGET_TOOL_LOCAL_DEPS || '', 'firebase', filename);
                return route.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(file) });
            }
            if (requestUrl.hostname === 'cdnjs.cloudflare.com') return route.fulfill({ contentType: 'application/javascript', body: 'window.Papa = { parse() {} };' });
            if (requestUrl.hostname === 'cdn.jsdelivr.net') return route.fulfill({ contentType: 'application/javascript', body: 'window.Chart = class { destroy() {} };' });
            return route.abort('blockedbyclient');
        });
        await badPage.goto(`${origin}/index.html`);
        await badPage.waitForTimeout(200);
        assert.ok(badPageErrors.some(error => error.message.includes('127.0.0.1')), 'Invalid local emulator host was not rejected before Firebase initialization.');
        await page.goto(`${origin}/index.html`);
        await page.evaluate(async ({ email, password }) => {
            await firebase.auth().signInWithEmailAndPassword(email, password);
        }, { email: ALLOWED_EMAIL, password: ALLOWED_PASSWORD });
        await page.waitForFunction(() => document.querySelector('.app-layout').style.display === 'flex');
        assert.equal(await page.evaluate(() => window.transactionApprovalService.serverBacked), true);
        await page.locator('.nav-item[data-tab="import"]').click();
        await page.waitForFunction(() => document.querySelectorAll('.review-select').length === 1);
        assert.equal(syncCalls, 1);
        assert.deepEqual(await page.evaluate(() => ({ accepted: transactions.length, spending: getMonthCategorySpending('Restaurants', '2026-10') })), { accepted: 0, spending: 0 });
        const firstId = await page.evaluate(() => document.querySelector('.review-select').dataset.reviewId);
        await page.locator('.review-select').waitFor();
        await page.locator('.review-select').check();
        await page.waitForFunction(() => !document.getElementById('addSelectedTransactions').disabled);
        await page.locator('#addSelectedTransactions').click();
        await page.waitForFunction(() => document.querySelectorAll('.review-select').length === 0);
        assert.deepEqual(await page.evaluate(() => ({ accepted: transactions.length, spending: getMonthCategorySpending('Restaurants', '2026-10') })), { accepted: 1, spending: 4.25 });
        const afterFirst = await waitForDocument(db, 'shared', 'data', state => Array.isArray(state.transactions) && state.transactions.length === 1);
        assert.equal(afterFirst.transactions[0].description, 'Local emulator coffee');
        const firstPending = await composed.backend.listPending({ uid: 'local-e2e-allowed', email: ALLOWED_EMAIL, tokenVerified: true, householdId: 'local-e2e-household' });
        assert.equal(firstPending.length, 0);
        await assert.rejects(() => composed.syncService.runOnOpen({ uid: 'local-e2e-allowed', email: ALLOWED_EMAIL, tokenVerified: false, householdId: 'local-e2e-household' }, 'sandbox-test', { runId: 'unauthenticated-sync' }), /server authorization/);
        await assert.rejects(() => composed.syncService.runOnOpen({ uid: 'local-e2e-unapproved', email: UNAPPROVED_EMAIL, tokenVerified: true, householdId: 'local-e2e-household' }, 'sandbox-test', { runId: 'unapproved-sync' }), /approved app user/);
        assert.equal(syncCalls, 1, 'Rejected sync callers reached the provider.');

        // A direct browser write that changes accepted transactions remains denied by rules.
        const directAcceptedWriteDenied = await page.evaluate(async () => {
            const ref = firebase.firestore().collection('shared').doc('data');
            const snapshot = await ref.get();
            const state = snapshot.data();
            state.transactions = state.transactions.concat([{ date: '2026-10-16', description: 'forbidden', amount: -1 }]);
            state.revision = Number(state.revision || 0) + 1;
            try { await ref.set(state); return false; } catch (_) { return true; }
        });
        assert.equal(directAcceptedWriteDenied, true);

        // Replaying the same durable receipt does not append a second accepted row.
        const firstReview = await composed.backend.exportReview({ uid: 'local-e2e-allowed', email: ALLOWED_EMAIL, tokenVerified: true, householdId: 'local-e2e-household' });
        const firstReceipt = firstReview.receipts[0].receipts[0];
        assert.equal(firstReceipt.candidateIds[0], firstId);
        const firstToken = await getIdToken(ALLOWED_EMAIL, ALLOWED_PASSWORD);
        const replay = await fetch(`${origin}/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${firstToken}` },
            body: JSON.stringify({ candidateIds: firstReceipt.candidateIds, revisions: firstReceipt.revisions, idempotencyKey: firstReceipt.idempotencyKey })
        });
        assert.equal(replay.status, 200);
        assert.equal((await firestoreDoc(db, 'shared', 'data').get()).data().transactions.length, 1);

        // A failed service acknowledgement leaves both the durable pending row
        // and the browser's accepted state untouched.
        await page.evaluate(async () => {
            window.stageReviewTransactions([{
                sourceId: 'local-e2e-failure', date: '2026-10-17', description: 'Retained after failure', amount: -6,
                category: 'Restaurants', account: 'Checking Account', payment_method: 'Checking Account', type: 'expense'
            }], 'bank-csv');
            for (let i = 0; i < 20; i += 1) {
                if ((await window.transactionApprovalService.listPending()).length === 1) return;
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            throw new Error('Failure candidate was not durable-staged.');
        });
        await page.locator('.review-select').waitFor();
        await page.locator('.review-select').check();
        failNextCommit = true;
        const dialogCountBeforeFailure = dialogs.length;
        await page.locator('#addSelectedTransactions').click();
        for (let attempt = 0; attempt < 40 && dialogs.length === dialogCountBeforeFailure; attempt += 1) await new Promise(resolve => setTimeout(resolve, 50));
        assert.ok(dialogs.length > dialogCountBeforeFailure, 'Approval failure did not produce a browser status alert.');
        assert.ok(dialogs.some(message => message.includes('Nothing was added')));
        assert.deepEqual(await page.evaluate(() => ({ accepted: transactions.length, spending: getMonthCategorySpending('Restaurants', '2026-10') })), { accepted: 1, spending: 4.25 });
        assert.equal((await firestoreDoc(db, 'shared', 'data').get()).data().transactions.length, 1);
        assert.equal((await composed.backend.listPending({ uid: 'local-e2e-allowed', email: ALLOWED_EMAIL, tokenVerified: true, householdId: 'local-e2e-household' })).length, 1);

        // Authenticated reload hydrates both accepted history and pending inbox.
        // Render-time settings can enqueue an accepted-state CAS write while
        // the approval response is settling. Drain that queue before the
        // navigation so a reload cannot race an old snapshot against the
        // durable approval acknowledgement.
        await drainBrowserSaveQueue(page);
        const beforeReload = await firestoreDoc(db, 'shared', 'data').get();
        assert.equal(beforeReload.data().transactions.length, 1);
        await page.reload();
        await page.waitForFunction(() => document.querySelector('.app-layout').style.display === 'flex');
        await page.locator('.nav-item[data-tab="import"]').click();
        await page.waitForFunction(() => document.querySelectorAll('.review-select').length === 1);
        assert.deepEqual(await page.evaluate(() => ({ accepted: transactions.length, spending: getMonthCategorySpending('Restaurants', '2026-10') })), { accepted: 1, spending: 4.25 });
        assert.equal((await firestoreDoc(db, 'shared', 'data').get()).data().transactions.length, 1);

        const unapproved = await fetch(`${origin}/pending`, { headers: { Authorization: `Bearer ${await getIdToken(UNAPPROVED_EMAIL, UNAPPROVED_PASSWORD)}` } });
        const unverified = await fetch(`${origin}/pending`, { headers: { Authorization: `Bearer ${await getIdToken(UNVERIFIED_EMAIL, UNVERIFIED_PASSWORD)}` } });
        assert.equal(unapproved.status, 401);
        assert.equal(unverified.status, 401);

        const protectedReadDenied = await page.evaluate(async () => {
            try { await firebase.firestore().collection('protectedTransactionReview').doc('local-e2e-household').get(); return false; } catch (_) { return true; }
        });
        assert.equal(protectedReadDenied, true);

        // Existing accepted history may contain a legacy row that cannot be
        // represented by the strict review schema. Reloading the actual app
        // must keep that canonical row while still allowing a new provider
        // observation to stage and approve through the durable browser path.
        // Close the first browser page before changing the durable fixture.
        // Its reload/save queue can still hold an accepted-state CAS request;
        // leaving it open makes the following Admin reset race that request.
        await drainBrowserSaveQueue(page);
        await page.close();
        const e2eAuth = { uid: 'local-e2e-allowed', email: ALLOWED_EMAIL, tokenVerified: true, householdId: 'local-e2e-household' };
        await composed.backend.cancel(e2eAuth);
        const resetState = await composed.backend.exportState(e2eAuth);
        await composed.backend.resetAccepted(e2eAuth, resetState.revision);
        const unknownLegacy = {
            id: 'legacy-unknown-date@1', sourceIdentity: 'legacy-unknown-date', sourceRevision: '1',
            date: 'Unknown', description: 'Legacy unknown date', amount: -1, category: 'Restaurants',
            merchant: 'Legacy unknown date', account: 'Checking Account', payment_method: 'Checking Account', type: 'expense'
        };
        // Seed the opaque accepted row through the durable restore boundary so
        // the repository's backend snapshot and Firestore document agree.
        // Writing this fixture directly to Firestore would leave the durable
        // backend's in-memory transaction state empty; the next approval would
        // then legitimately return only the new provider row and erase the
        // synthetic legacy history.
        const clearedState = await composed.backend.exportState(e2eAuth);
        const restoredLegacy = await composed.backend.replaceAccepted(e2eAuth, {
            ...clearedState.state,
            transactions: [unknownLegacy],
            acceptedHistoryDateCompatibility: true
        }, clearedState.revision);
        assert.equal(restoredLegacy.ok, true);
        const seededLegacyState = (await firestoreDoc(db, 'shared', 'data').get()).data();
        assert.equal(seededLegacyState.transactions[0].date, 'Unknown');
        await composed.backend.stage(e2eAuth, [{
            sourceIdentity: 'plaid:legacy-fixture:provider-after-legacy', sourceRevision: '1',
            date: '2026-10-17', description: 'Provider after legacy row', amount: -3.75,
            category: 'Restaurants', account: 'Checking Account', payment_method: 'Checking Account', type: 'expense'
        }], { source: 'bank-provider', serverIngest: true, batchId: 'legacy-browser-provider' });
        page = await browser.newPage();
        page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
        page.on('pageerror', error => pageErrors.push(error));
        await page.addInitScript(({ endpoint }) => {
            window.TRANSACTION_APPROVAL_ENDPOINT = endpoint;
            window.TRANSACTION_SYNC_ENABLED = true;
            window.TRANSACTION_SYNC_CONNECTIONS = ['sandbox-test'];
            window.__BUDGET_TOOL_LOCAL_EMULATOR__ = {
                projectId: 'demo-budget-tool',
                auth: { host: '127.0.0.1', port: 9099 },
                firestore: { host: '127.0.0.1', port: 8088 }
            };
        }, { endpoint: origin });
        await page.route('**/*', async route => {
            const requestUrl = new URL(route.request().url());
            if (requestUrl.hostname === '127.0.0.1' && [String(port), '9099', '8088'].includes(requestUrl.port)) return route.continue();
            const filename = requestUrl.pathname.split('/').pop();
            if (requestUrl.hostname === 'www.gstatic.com' && ['firebase-app-compat.js', 'firebase-auth-compat.js', 'firebase-firestore-compat.js'].includes(filename)) {
                const file = path.join(process.env.BUDGET_TOOL_LOCAL_DEPS || '', 'firebase', filename);
                return route.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(file) });
            }
            if (requestUrl.hostname === 'cdnjs.cloudflare.com') return route.fulfill({ contentType: 'application/javascript', body: 'window.Papa = { parse() {} };' });
            if (requestUrl.hostname === 'cdn.jsdelivr.net') return route.fulfill({ contentType: 'application/javascript', body: 'window.Chart = class { destroy() {} };' });
            return route.abort('blockedbyclient');
        });
        await page.route('**/sync', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, skipped: true }) }));
        await page.goto(`${origin}/index.html`);
        await page.evaluate(async ({ email, password }) => {
            await firebase.auth().signInWithEmailAndPassword(email, password);
        }, { email: ALLOWED_EMAIL, password: ALLOWED_PASSWORD });
        await page.waitForFunction(() => document.querySelector('.app-layout').style.display === 'flex');
        await page.locator('.nav-item[data-tab="import"]').click();
        assert.deepEqual(await page.evaluate(() => ({ accepted: transactions.length, date: transactions[0] && transactions[0].date })), { accepted: 1, date: 'Unknown' });
        await page.locator('.review-select').waitFor();
        await page.locator('.review-select').check();
        await page.waitForFunction(() => !document.getElementById('addSelectedTransactions').disabled);
        await page.locator('#addSelectedTransactions').click();
        await page.waitForFunction(() => document.querySelectorAll('.review-select').length === 0);
        const legacyPreserved = await waitForDocument(db, 'shared', 'data', state => Array.isArray(state.transactions) && state.transactions.length === 2);
        assert.equal(legacyPreserved.transactions.some(transaction => transaction.date === 'Unknown'), true);
        assert.equal(legacyPreserved.transactions.some(transaction => transaction.description === 'Provider after legacy row'), true);
        await page.evaluate(async () => {
            budgets.Restaurants = { '2026-10': 42 };
            const saved = await saveToFirestore({ throwOnFailure: true });
            if (saved !== true) throw new Error('Browser settings save was not acknowledged.');
        });
        const legacyAfterSettings = await waitForDocument(db, 'shared', 'data', state => Array.isArray(state.transactions) && state.transactions.length === 2 && state.budgets && state.budgets.Restaurants && state.budgets.Restaurants['2026-10'] === 42);
        assert.equal(legacyAfterSettings.transactions.some(transaction => transaction.date === 'Unknown'), true);
        await page.unroute('**/sync');
        assert.equal(pageErrors.length, 0, pageErrors.map(error => error.stack || error).join('\n'));
        console.log('PASS: real Auth emulator ID tokens, Admin-verified HTTP approval, Firestore durable approval/reload, protected UID membership, direct-write denial, failed persistence retention, and idempotent replay.');
    } finally {
        if (badPage) await badPage.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        if (server) await new Promise(resolve => server.close(() => resolve()));
        await firestoreDoc(db, 'protectedAppUsers', 'local-e2e-allowed').delete().catch(() => {});
        await firestoreDoc(db, 'protectedAppConfig', 'transactionService').delete().catch(() => {});
        await db.terminate().catch(() => {});
        await admin.app().delete().catch(() => {});
    }
})().catch(error => { console.error(error); process.exitCode = 1; });

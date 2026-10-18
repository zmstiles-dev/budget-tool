/*
 * Loopback-only local demo bridge.
 *
 * This module is intentionally separate from the deployed app composition. It
 * requires the demo Auth and Firestore emulators, refuses existing demo data,
 * serves an allowlist of local assets, and keeps any injected provider token
 * in the server process only. Importing it does not read credentials or
 * initialize Firebase Admin.
 */
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');
const admin = require('firebase-admin');
const backendApi = require('./transaction-backend.js');
const sandbox = require('./plaid-sandbox.js');
const { createBudgetService } = require('./transaction-service.js');

const ROOT = path.resolve(__dirname);
const PROJECT_ID = 'demo-budget-tool';
const AUTH_HOST = '127.0.0.1:9099';
const FIRESTORE_HOST = '127.0.0.1:8088';
const HOUSEHOLD_ID = 'local-demo-bridge-household';
const CONNECTION_KEY = 'sandbox-test';
const ALLOWED_EMAIL = 'captainicebow@gmail.com';
const FIXTURE_UID = 'local-demo-bridge-allowed';
const FIXTURE_PASSWORD = 'local-demo-password-1';
const FIREBASE_ASSETS = ['firebase-app-compat.js', 'firebase-auth-compat.js', 'firebase-firestore-compat.js'];
const APP_ASSETS = new Map([
    ['/transaction-config.js', ['transaction-config.js', 'application/javascript; charset=utf-8']],
    ['/transaction-validation.js', ['transaction-validation.js', 'application/javascript; charset=utf-8']],
    ['/transaction-review.js', ['transaction-review.js', 'application/javascript; charset=utf-8']],
    ['/transaction-backend.js', ['transaction-backend.js', 'application/javascript; charset=utf-8']],
    ['/transaction-service.js', ['transaction-service.js', 'application/javascript; charset=utf-8']]
]);
const LOCAL_DISABLED_SCRIPT = 'window.__BUDGET_TOOL_LOCAL_LIMITED_UI__=true;';

function text(value) {
    return String(value ?? '').trim();
}

function requireLocalDemoEnvironment(environment) {
    const env = environment || process.env;
    if (!env || env.GCLOUD_PROJECT !== PROJECT_ID) throw new Error('Local demo requires GCLOUD_PROJECT=demo-budget-tool.');
    if (env.FIRESTORE_EMULATOR_HOST !== FIRESTORE_HOST) throw new Error('Local demo requires FIRESTORE_EMULATOR_HOST=127.0.0.1:8088.');
    if (env.FIREBASE_AUTH_EMULATOR_HOST !== AUTH_HOST) throw new Error('Local demo requires FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099.');
    return { projectId: PROJECT_ID, auth: { host: '127.0.0.1', port: 9099 }, firestore: { host: '127.0.0.1', port: 8088 } };
}

async function probeLoopback(url, label) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => { if (controller) controller.abort(); }, 2500);
    try {
        const response = await fetch(url, controller ? { signal: controller.signal, redirect: 'error' } : { redirect: 'error' });
        if (!response) throw new Error(`${label} did not respond.`);
        return true;
    } catch (_) {
        throw new Error(`${label} emulator is unavailable on the required loopback endpoint.`);
    } finally {
        clearTimeout(timer);
    }
}

async function verifyLocalDemoEmulators(environment) {
    const config = requireLocalDemoEnvironment(environment);
    await probeLoopback(`http://${AUTH_HOST}/`, 'Auth');
    await probeLoopback(`http://${FIRESTORE_HOST}/`, 'Firestore');
    return config;
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

function hasMeaningfulData(data) {
    if (!data || typeof data !== 'object') return false;
    return (Array.isArray(data.transactions) && data.transactions.length > 0)
        || (Array.isArray(data.pending) && data.pending.length > 0)
        || (Array.isArray(data.accepted) && data.accepted.length > 0)
        || (Array.isArray(data.rejected) && data.rejected.length > 0)
        || (Array.isArray(data.receipts) && data.receipts.length > 0)
        || (Number.isSafeInteger(data.revision) && data.revision > 0);
}

async function ensureFixtureUser(auth) {
    let user;
    try { user = await auth.getUser(FIXTURE_UID); } catch (_) { user = null; }
    if (user) {
        if (text(user.email).toLowerCase() !== ALLOWED_EMAIL || user.emailVerified !== true) throw new Error('Local demo fixture user has an unexpected identity.');
        await auth.updateUser(FIXTURE_UID, { password: FIXTURE_PASSWORD, emailVerified: true });
        return user;
    }
    return auth.createUser({ uid: FIXTURE_UID, email: ALLOWED_EMAIL, password: FIXTURE_PASSWORD, emailVerified: true });
}

async function clearLocalDemoData(db) {
    const refs = [
        db.collection('shared').doc('data'),
        db.collection('protectedTransactionReview').doc(HOUSEHOLD_ID),
    ];
    const connections = await db.collection('protectedConnections').get();
    connections.forEach(snapshot => refs.push(snapshot.ref));
    const runs = await db.collection('protectedSyncRuns').get();
    runs.forEach(snapshot => refs.push(snapshot.ref));
    await db.runTransaction(async transaction => {
        refs.forEach(ref => transaction.delete(ref));
    });
}

async function closeLocalDemoContext(context) {
    const value = context || {};
    if (value.closed) return;
    value.closed = true;
    if (value.ownsApp && value.db && typeof value.db.terminate === 'function') await value.db.terminate().catch(() => {});
    if (value.ownsApp && value.app && typeof value.app.delete === 'function') await value.app.delete().catch(() => {});
}

async function prepareLocalDemo(options) {
    const opts = options || {};
    // The Admin SDK reads the actual process environment. Do not allow a
    // test-only override object to initialize against a different endpoint.
    requireLocalDemoEnvironment(process.env);
    const environment = await verifyLocalDemoEmulators(opts.environment);
    const firebaseDir = localFirebaseDir(opts);
    for (const filename of FIREBASE_ASSETS) {
        const file = path.join(firebaseDir, filename);
        if (!file.startsWith(firebaseDir + path.sep) || !fs.existsSync(file)) throw new Error('Local Firebase SDK assets are unavailable in the configured D: dependency directory.');
    }
    const connectionKey = text(opts.connectionKey || CONNECTION_KEY);
    if (!connectionKey) throw new Error('Local demo connection key is required.');
    process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: PROJECT_ID });
    const ownsApp = admin.apps.length === 0;
    const app = ownsApp ? admin.initializeApp({ projectId: PROJECT_ID }) : admin.app();
    if (text(app.options && app.options.projectId) !== PROJECT_ID) throw new Error('Local demo refused an Admin app outside demo-budget-tool.');
    const auth = admin.auth(app);
    const db = admin.firestore(app);
    try {
        const existing = [
            await db.collection('shared').doc('data').get(),
            await db.collection('protectedTransactionReview').doc(HOUSEHOLD_ID).get(),
            await db.collection('protectedConnections').doc(connectionKey).get(),
            ...(await db.collection('protectedSyncRuns').get()).docs
        ];
        if (existing.some(snapshot => snapshot.exists)) {
            if (opts.resetLocalDemo !== true) throw new Error('Local demo data already exists; use an explicit local reset to remove it.');
            await clearLocalDemoData(db);
        }
        const state = await db.collection('shared').doc('data').get();
        if (!state.exists) await db.collection('shared').doc('data').set(initialState());
        await ensureFixtureUser(auth);
        return { app, auth, db, ownsApp, environment, connectionKey, householdId: HOUSEHOLD_ID, fixtureEmail: ALLOWED_EMAIL, fixturePassword: FIXTURE_PASSWORD };
    } catch (error) {
        await closeLocalDemoContext({ app, db, ownsApp });
        throw error;
    }
}

function createMockProvider() {
    return new backendApi.PlaidTransactionsSyncAdapter({
        accountMap: { 'local-demo-account': 'Checking Account' },
        client: { async sync() {
            return {
                added: [{ transaction_id: 'local-demo-transaction', date: '2026-10-10', amount: 4.25, account_id: 'local-demo-account', currency_code: 'USD', name: 'Local demo coffee', merchant_name: 'Local demo coffee', category: 'Restaurants' }],
                modified: [], removed: [], has_more: false, next_cursor: 'local-demo-cursor'
            };
        } }
    });
}

function localFirebaseDir(options) {
    const opts = options || {};
    const candidate = opts.firebaseSdkDir || (opts.localDepsDir && path.join(opts.localDepsDir, 'firebase')) || (process.env.BUDGET_TOOL_LOCAL_DEPS && path.join(process.env.BUDGET_TOOL_LOCAL_DEPS, 'firebase'));
    if (!candidate) throw new Error('Local Firebase SDK directory is required.');
    const resolved = path.resolve(candidate);
    if (!/^d:[\\/]/i.test(resolved)) throw new Error('Local Firebase SDK directory must be under D:.');
    return resolved;
}

function scriptJson(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function makeBootstrap(origin, context, options) {
    const opts = options || {};
    const value = {
        projectId: PROJECT_ID,
        auth: context.environment.auth,
        firestore: context.environment.firestore
    };
    const fixture = opts.autoLogin === false ? null : { email: context.fixtureEmail, password: context.fixturePassword };
    return `<script>window.__BUDGET_TOOL_LOCAL_BRIDGE__=true;window.__BUDGET_TOOL_LOCAL_EMULATOR__=${scriptJson(value)};window.__BUDGET_TOOL_LOCAL_BANNER__=true;window.__BUDGET_TOOL_LOCAL_LIMITED_UI__=true;window.TRANSACTION_APPROVAL_ENDPOINT=${scriptJson(origin)};window.TRANSACTION_SYNC_ENABLED=${opts.syncEnabled !== false};window.TRANSACTION_SYNC_CONNECTIONS=${scriptJson([context.connectionKey])};${fixture ? `window.__BUDGET_TOOL_LOCAL_AUTO_LOGIN__=true;window.__BUDGET_TOOL_LOCAL_FIXTURE_USER__=${scriptJson(fixture)};` : ''}</script>`;
}

function createStaticHandler(context, options, origin) {
    const opts = options || {};
    const firebaseDir = localFirebaseDir(opts);
    const rawIndex = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const index = rawIndex
        .replaceAll('https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js', '/__local/papaparse.js')
        .replaceAll('https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js', '/__local/chart.js')
        .replaceAll('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js', '/__local/firebase/firebase-app-compat.js')
        .replaceAll('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js', '/__local/firebase/firebase-auth-compat.js')
        .replaceAll('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js', '/__local/firebase/firebase-firestore-compat.js')
        .replace('</head>', `${makeBootstrap(origin, context, opts)}</head>`);
    return (request, response) => {
        const parsed = new URL(request.url || '/', origin);
        if (parsed.pathname === '/') {
            response.writeHead(302, { Location: '/index.html?localBridge=1', 'Cache-Control': 'no-store' });
            response.end();
            return;
        }
        if (parsed.pathname === '/index.html') {
            if (parsed.searchParams.get('localBridge') !== '1') { response.writeHead(400); response.end('Local bridge marker is required.'); return; }
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            response.end(index);
            return;
        }
        if (parsed.pathname === '/__local/papaparse.js' || parsed.pathname === '/__local/chart.js') { response.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' }); response.end(LOCAL_DISABLED_SCRIPT); return; }
        if (parsed.pathname.startsWith('/__local/firebase/')) {
            const filename = parsed.pathname.slice('/__local/firebase/'.length);
            if (!FIREBASE_ASSETS.includes(filename)) { response.writeHead(404); response.end(); return; }
            const file = path.join(firebaseDir, filename);
            if (!file.startsWith(firebaseDir + path.sep) || !fs.existsSync(file)) { response.writeHead(503); response.end('Local Firebase SDK is unavailable.'); return; }
            response.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
            response.end(fs.readFileSync(file));
            return;
        }
        const asset = APP_ASSETS.get(parsed.pathname);
        if (!asset) { response.writeHead(404); response.end(); return; }
        const file = path.join(ROOT, asset[0]);
        response.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store' });
        response.end(fs.readFileSync(file));
    };
}

async function createLocalDemoBridge(options) {
    const opts = options || {};
    const context = opts.context || await prepareLocalDemo(opts);
    const connectionKey = text(opts.connectionKey || context.connectionKey);
    if (!connectionKey) throw new Error('Local demo connection key is required.');
    if (connectionKey !== context.connectionKey) {
        const existingConnection = await context.db.collection('protectedConnections').doc(connectionKey).get();
        if (existingConnection.exists) throw new Error('Local demo provider connection already exists; choose a fresh local connection key or reset explicitly.');
    }
    const bridgeContext = { ...context, connectionKey };
    const provider = opts.provider || (opts.mode === 'real' ? null : createMockProvider());
    if (!provider || typeof provider.fetchDelta !== 'function') throw new Error('Local demo provider is not configured.');
    const syncEnabled = opts.syncEnabled !== false;
    const bridgeDb = opts.db || context.db;
    const errorDiagnostic = typeof opts.errorDiagnostic === 'function' ? opts.errorDiagnostic : sandbox.safeSandboxDiagnostic;
    const composed = createBudgetService({
        db: bridgeDb,
        admin,
        householdId: context.householdId,
        allowedUsers: [ALLOWED_EMAIL],
        allowedOrigins: [],
        syncEnabled,
        connectionOwners: { [connectionKey]: FIXTURE_UID },
        connectionResolver: async () => ({ accessToken: opts.accessToken || 'local-demo-provider-token' }),
        cooldownMs: opts.cooldownMs,
        errorDiagnostic,
        provider
    });
    const apiPaths = new Set(['/pending', '/review', '/stage', '/approve', '/edit', '/split', '/reject', '/defer', '/cancel', '/restore', '/reset', '/accepted-state', '/sync']);
    let server;
    const inFlight = new Set();
    const sockets = new Set();
    const port = Number.isSafeInteger(opts.port) && opts.port >= 0 ? opts.port : 8787;
    server = http.createServer((request, response) => {
        const operation = Promise.resolve().then(() => {
            const parsed = new URL(request.url || '/', 'http://127.0.0.1');
            if (apiPaths.has(parsed.pathname) || request.method === 'OPTIONS' && apiPaths.has(parsed.pathname)) return composed.handler(request, response);
            return createStaticHandler(bridgeContext, opts, `http://127.0.0.1:${server.address() && server.address().port || port}`)(request, response);
        });
        inFlight.add(operation);
        operation.then(() => inFlight.delete(operation), () => inFlight.delete(operation));
        operation.catch(() => {
            if (!response.writableEnded) {
                response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                response.end('Local bridge request failed.');
            }
        });
        return operation;
    });
    server.on('connection', socket => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    composed.handler = backendApi.createHttpHandler({ backend: composed.backend, syncService: composed.syncService, admin, householdId: context.householdId, allowedUsers: [ALLOWED_EMAIL], allowedOrigins: [origin], errorDiagnostic });
    let closed = false;
    const close = async () => {
        if (closed) return;
        closed = true;
        await new Promise(resolve => {
            let settled = false;
            const finish = () => { if (!settled) { settled = true; resolve(); } };
            server.close(finish);
            setTimeout(() => {
                for (const socket of sockets) socket.destroy();
                if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
                finish();
            }, 2_000);
        });
        if (inFlight.size) {
            await Promise.race([
                Promise.allSettled([...inFlight]),
                new Promise(resolve => setTimeout(resolve, 2_000))
            ]);
        }
        await closeLocalDemoContext(context);
    };
    return { ...bridgeContext, service: composed, server, origin, url: `${origin}/index.html?localBridge=1`, close };
}

module.exports = {
    PROJECT_ID, AUTH_HOST, FIRESTORE_HOST, HOUSEHOLD_ID, CONNECTION_KEY, ALLOWED_EMAIL, FIXTURE_UID, FIXTURE_PASSWORD,
    requireLocalDemoEnvironment, verifyLocalDemoEmulators, initialState, prepareLocalDemo, closeLocalDemoContext, createMockProvider, createLocalDemoBridge
};

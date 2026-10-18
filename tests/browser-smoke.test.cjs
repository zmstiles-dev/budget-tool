const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.BUDGET_TOOL_PLAYWRIGHT_BROWSERS_PATH || 'D:\\Documents\\Codex\\.assistant-storage\\playwright-browsers';
const { chromium } = require('playwright');

const allowlistedAssets = new Map([
  ['/index.html', 'text/html; charset=utf-8'],
  ['/transaction-config.js', 'application/javascript; charset=utf-8'],
  ['/transaction-validation.js', 'application/javascript; charset=utf-8'],
  ['/transaction-review.js', 'application/javascript; charset=utf-8'],
  ['/transaction-backend.js', 'application/javascript; charset=utf-8'],
  ['/transaction-service.js', 'application/javascript; charset=utf-8'],
  ['/transaction-service.package.json', 'application/json; charset=utf-8']
]);
const firebaseStub = [
  '(() => {',
  '  const data = { transactions: [], categories: [], budgets: {}, merchantDefaults: {}, categoryGroups: [], categoryColors: {}, categoryOrder: [], revision: 0 };',
  '  let listener;',
  '  const user = { uid: "synthetic-user", email: "captainicebow@gmail.com", getIdTokenResult: async () => ({ token: "synthetic-id-token", claims: { auth_time: 1 } }) };',
  '  const auth = { currentUser: user, onAuthStateChanged(callback) { window.__authRegistered = true; listener = callback; setTimeout(() => { window.__authFired = true; window.__authEmail = user.email; callback(user); }, 0); }, signOut: async () => { window.__signedOut = true; auth.currentUser = null; if (listener) listener(null); }, signInWithPopup: async () => { auth.currentUser = user; if (listener) listener(user); } };',
  '  function authFactory() { return auth; }',
  '  authFactory.GoogleAuthProvider = function GoogleAuthProvider() {};',
  '  const db = { collection(name) { return { doc(id) { return { async get() { return { exists: name === "shared" && id === "data", data: () => JSON.parse(JSON.stringify(data)) }; } }; } }; }, async runTransaction(callback) { window.__txReads = window.__txReads || []; window.__txWrites = window.__txWrites || []; const tx = { get: async ref => { const result = await ref.get(); window.__txReads.push(result.data().revision); return result; }, set: (ref, value) => { window.__txWrites.push(value.revision); Object.assign(data, JSON.parse(JSON.stringify(value))); } }; return callback(tx); } };',
  '  function firestoreFactory() { return db; }',
  '  firestoreFactory.FieldValue = { serverTimestamp: () => ({ synthetic: true }) };',
  '  window.firebase = { initializeApp() {}, auth: authFactory, firestore: firestoreFactory };',
  '  window.Chart = class { destroy() {} }; window.Papa = { parse() {} };',
  '  window.__alerts = []; window.alert = message => window.__alerts.push(String(message));',
  '})();'
].join('\n');

function createServer() {
  return http.createServer((request, response) => {
    let requestPath = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (requestPath === '/') requestPath = '/index.html';
    const contentType = allowlistedAssets.get(requestPath);
    if (!contentType) { response.writeHead(404); response.end(); return; }
    const filePath = path.join(root, requestPath.slice(1));
    fs.readFile(filePath, (error, contents) => {
      if (error) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Content-Type': contentType });
      response.end(contents);
    });
  });
}

(async () => {
  let server;
  let browser;
  try {
    server = createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const blockedExternalRequests = [];
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error));
    await page.route('**/*', async route => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.hostname === '127.0.0.1' && requestUrl.port === String(port)) return route.continue();
      const url = requestUrl.href;
      if (url.includes('firebase-app-compat.js')) return route.fulfill({ contentType: 'application/javascript', body: firebaseStub });
      if (url.includes('firebase-auth-compat.js') || url.includes('firebase-firestore-compat.js')) return route.fulfill({ contentType: 'application/javascript', body: '' });
      if (url.includes('papaparse.min.js')) return route.fulfill({ contentType: 'application/javascript', body: 'window.Papa = window.Papa || { parse() {} };' });
      if (url.includes('chart.umd.min.js')) return route.fulfill({ contentType: 'application/javascript', body: 'window.Chart = window.Chart || class { destroy() {} };' });
      blockedExternalRequests.push(url);
      return route.abort('blockedbyclient');
    });
    await page.goto('http://127.0.0.1:' + port + '/index.html');
    await page.waitForFunction(() => document.querySelector('.app-layout').style.display === 'flex');
    await page.locator('.nav-item[data-tab="import"]').click();
    await page.evaluate(() => window.stageReviewTransactions([{ sourceId: 'browser-smoke', date: '2026-10-01', description: 'Synthetic coffee', amount: -4.25, category: 'Restaurants', account: 'Checking', payment_method: 'Checking', type: 'expense' }], 'bank-csv'));
    await page.locator('.review-select').waitFor();
    await page.locator('.review-select').check();
    await page.waitForFunction(() => document.querySelector('.review-select') && document.querySelector('.review-select').checked === true);
    assert.equal(await page.locator('#addSelectedTransactions').isDisabled(), false, 'Add selected remained disabled after selection rerender.');
    await page.evaluate(() => {
      window.transactionApprovalService = { serverBacked: true, async approve(payload) {
        const transactions = payload.map(item => {
          const accepted = { ...item };
          ['status', 'fingerprint', 'overlap', 'revision', 'reviewedRevision', 'batchId'].forEach(key => delete accepted[key]);
          return accepted;
        });
        return { ok: true, revision: 2, state: { transactions, categories: [{ name: 'Restaurants', type: 'expense' }], budgets: {}, merchantDefaults: {}, categoryGroups: [], categoryColors: {}, categoryOrder: [] } };
      }};
    });
    await page.locator('#addSelectedTransactions').click();
    await page.waitForFunction(() => document.querySelectorAll('.review-select').length === 0);
    const result = await page.evaluate(() => ({ alerts: window.__alerts.slice(), status: document.getElementById('reviewStatus').textContent }));
    assert.ok(result.alerts.some(message => message.includes('Added 1 selected transaction')), `Unexpected alerts: ${JSON.stringify(result.alerts)}`);
    assert.equal(result.status.includes('Added'), false, `Review status did not settle after approval: ${result.status}`);
    const unsafeBudgetResults = await page.evaluate(() => ['__proto__', 'constructor', 'prototype'].map(category => {
        const values = {};
        Object.defineProperty(values, category, { value: 5, enumerable: true, configurable: true, writable: true });
        const imported = { '2026-10': values };
        const state = { budgets: {}, transactions: [] };
        try {
            window.mergeImportedBudgetsIntoState(state, imported);
            return { category, rejected: false, polluted: Object.prototype.hasOwnProperty.call(Object.prototype, '2026-10') };
        } catch (error) {
            return { category, rejected: error.message === 'Approval budget batch contains an unsafe map key.', polluted: Object.prototype.hasOwnProperty.call(Object.prototype, '2026-10'), budgetKeys: Object.keys(state.budgets) };
        }
    }));
    assert.deepEqual(unsafeBudgetResults, [
        { category: '__proto__', rejected: true, polluted: false, budgetKeys: [] },
        { category: 'constructor', rejected: true, polluted: false, budgetKeys: [] },
        { category: 'prototype', rejected: true, polluted: false, budgetKeys: [] }
    ]);
    assert.deepEqual(blockedExternalRequests, [], `Unexpected external requests: ${blockedExternalRequests.join(', ')}`);
    assert.equal(pageErrors.length, 0, `Synthetic browser page errors: ${pageErrors.map(error => error.stack || error).join('\n')}`);
    console.log('PASS: synthetic Firebase/Auth browser smoke, review selection retention, authenticated approval install, and external-request blocking.');
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await new Promise(resolve => server.close(() => resolve()));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

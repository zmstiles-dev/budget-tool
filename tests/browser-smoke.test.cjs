const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.BUDGET_TOOL_PLAYWRIGHT_BROWSERS_PATH || 'D:\\Documents\\Codex\\.assistant-storage\\playwright-browsers';
const { chromium } = require('playwright');

const allowlistedAssets = new Map([
  ['/index.html', 'text/html; charset=utf-8'],
  ['/deployment-config.template.js', 'application/javascript; charset=utf-8'],
  ['/transaction-config.js', 'application/javascript; charset=utf-8'],
  ['/transaction-validation.js', 'application/javascript; charset=utf-8'],
  ['/transaction-review.js', 'application/javascript; charset=utf-8'],
  ['/transaction-backend.js', 'application/javascript; charset=utf-8'],
  ['/transaction-service.js', 'application/javascript; charset=utf-8'],
  ['/transaction-service.package.json', 'application/json; charset=utf-8']
]);
const firebaseStub = [
  '(() => {',
  '  const data = { transactions: [{ sourceId: "old-user-visible", date: "2026-10-01", description: "Old user transaction", amount: -1.25, category: "Restaurants", account: "Checking", payment_method: "Checking", type: "expense" }], categories: [{ name: "Restaurants", type: "expense" }], budgets: {}, merchantDefaults: {}, categoryGroups: [], categoryColors: {}, categoryOrder: [], revision: 0 };',
  '  let listener;',
  '  const user = { uid: "synthetic-user", email: "captainicebow@gmail.com", getIdTokenResult: async () => ({ token: "synthetic-id-token", claims: { auth_time: 1 } }) };',
  '  const otherUser = { uid: "synthetic-other-user", email: "other-user@example.test", getIdTokenResult: async () => ({ token: "synthetic-other-id-token", claims: { auth_time: 2 } }) };',
  '  const unauthorizedUser = { uid: "synthetic-unauthorized-user", email: "unauthorized@example.test", getIdTokenResult: async () => ({ token: "synthetic-unauthorized-id-token", claims: { auth_time: 3 } }) };',
  '  const auth = { currentUser: user, onAuthStateChanged(callback) { window.__authRegistered = true; listener = callback; setTimeout(() => { window.__authFired = true; window.__authEmail = user.email; callback(auth.currentUser); }, 0); }, signOut: async () => { window.__signedOut = true; auth.currentUser = null; if (listener) listener(null); }, signInWithPopup: async () => { auth.currentUser = user; if (listener) listener(user); }, __switchUser: () => { auth.currentUser = otherUser; if (listener) listener(otherUser); }, __switchUnauthorizedUser: () => { auth.currentUser = unauthorizedUser; if (listener) listener(unauthorizedUser); }, __refreshUser: () => { if (listener) listener(auth.currentUser); } };',
  '  function authFactory() { return auth; }',
  '  authFactory.GoogleAuthProvider = function GoogleAuthProvider() {};',
  '  window.__setSharedData = next => Object.assign(data, JSON.parse(JSON.stringify(next)));',
  '  const db = { collection(name) { return { doc(id) { return { async get() { if (name === "shared" && id === "data" && window.__failSharedRead === true) throw new Error("synthetic shared read failure"); if (name === "shared" && id === "data" && window.__delaySharedRead === true) { window.__sharedReadStarted = true; await new Promise(resolve => { window.__resolveSharedRead = resolve; }); } return { exists: name === "shared" && id === "data", data: () => JSON.parse(JSON.stringify(data)) }; } }; } }; }, async runTransaction(callback) { window.__txReads = window.__txReads || []; window.__txWrites = window.__txWrites || []; const tx = { get: async ref => { const result = await ref.get(); window.__txReads.push(result.data().revision); return result; }, set: (ref, value) => { window.__txWrites.push(value.revision); Object.assign(data, JSON.parse(JSON.stringify(value))); } }; return callback(tx); } };',
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
    await page.addInitScript(() => { window.TRANSACTION_APPROVAL_ENDPOINT = ''; });
    await page.goto('http://127.0.0.1:' + port + '/index.html');
    await page.waitForFunction(() => document.querySelector('.app-layout').style.display === 'flex');
    await page.waitForFunction(() => document.body.innerText.includes('Old user transaction'));
    const identityPanel = await page.evaluate(() => ({
        visible: getComputedStyle(document.getElementById('authIdentityPanel')).display !== 'none',
        email: document.getElementById('authIdentityEmail').textContent,
        switchVisible: getComputedStyle(document.getElementById('authSwitchAccount')).display !== 'none'
    }));
    assert.equal(identityPanel.visible, true, 'Authenticated UI must show the current account identity.');
    assert.equal(identityPanel.email, 'captainicebow@gmail.com', 'Authenticated UI must show the verified account email.');
    assert.equal(identityPanel.switchVisible, true, 'Authenticated UI must expose explicit account switching.');
    const reviewEditorSmoke = await page.evaluate(async () => {
        const originalService = window.transactionApprovalService;
        let editCalls = 0;
        let successfulEdits = 0;
        let rejectEdit = false;
        window.transactionApprovalService = { serverBacked: true, async edit(id, patch, revision) { editCalls += 1; if (rejectEdit) throw new Error('Synthetic stale review edit.'); successfulEdits += 1; return { id, ...patch, revision: revision + 1 }; } };
        reviewStore.clear();
        const staged = reviewStore.stage([{
            sourceId: 'ui-review-editor', date: '2026-10-10', description: 'Review me', merchant: 'Review merchant', amount: -12.34,
            category: 'Restaurants', account: 'Checking', payment_method: 'Checking', type: 'expense'
        }], { source: 'bank-csv', batchId: 'ui-review-editor' })[0];
        renderReviewInbox();
        document.querySelector('button.review-edit').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        const opened = document.getElementById('categoryModal').classList.contains('active') && document.getElementById('saveTransaction').textContent === 'Save & Next';
        document.getElementById('modalDescription').value = 'Edited review row';
        document.getElementById('modalMerchant').value = 'Edited merchant';
        document.getElementById('modalAmount').value = '-13.34';
        document.getElementById('saveTransaction').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        const saved = reviewStore.get(staged.id);
        const acceptedCountBeforeRejectedEdit = transactions.length;
        const rejectedStage = reviewStore.stage([{
            sourceId: 'ui-review-editor-rejected', date: '2026-10-11', description: 'Reject me', merchant: 'Reject merchant', amount: -8.12,
            category: 'Restaurants', account: 'Checking', payment_method: 'Checking', type: 'expense'
        }], { source: 'bank-csv', batchId: 'ui-review-editor-rejected' })[0];
        renderReviewInbox();
        document.querySelector(`button.review-edit[data-review-id="${rejectedStage.id}"]`).click();
        await new Promise(resolve => setTimeout(resolve, 0));
        document.getElementById('modalDescription').value = 'Rejected edit stays visible';
        rejectEdit = true;
        document.getElementById('saveTransaction').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        const rejected = {
            modalOpen: document.getElementById('categoryModal').classList.contains('active'),
            description: document.getElementById('modalDescription').value,
            acceptedCount: transactions.length,
            pendingRevision: reviewStore.get(rejectedStage.id).revision
        };
        document.getElementById('reviewClose').click();
        const result = { opened, editCalls, successfulEdits, description: saved && saved.description, amount: saved && saved.amount, modalClosed: !document.getElementById('categoryModal').classList.contains('active'), rejected };
        reviewStore.clear();
        renderReviewInbox();
        if (originalService === undefined) delete window.transactionApprovalService;
        else window.transactionApprovalService = originalService;
        return result;
    });
    assert.equal(reviewEditorSmoke.opened, true, 'Pending review rows must open the familiar sequential editor.');
    assert.equal(reviewEditorSmoke.editCalls, 2, 'Pending review edits must use the authenticated revision-bound service, including rejected retries.');
    assert.equal(reviewEditorSmoke.successfulEdits, 1, 'Exactly one pending review edit should be acknowledged in the synthetic flow.');
    assert.equal(reviewEditorSmoke.description, 'Edited review row', 'Pending review description edits must persist in the review inbox.');
    assert.equal(reviewEditorSmoke.amount, -13.34, 'Pending review amount edits must persist in the review inbox.');
    assert.equal(reviewEditorSmoke.modalClosed, true, 'Save & Next must close after the final pending row.');
    assert.equal(reviewEditorSmoke.rejected.modalOpen, true, 'A failed revision-bound edit must keep the review form open.');
    assert.equal(reviewEditorSmoke.rejected.description, 'Rejected edit stays visible', 'A failed review edit must preserve form values.');
    assert.equal(reviewEditorSmoke.rejected.acceptedCount, 1, 'Review-only edits must not write accepted history.');
    const checkingIncomeTypeToggleSmoke = await page.evaluate(async () => {
        const originalService = window.transactionApprovalService;
        let editPatch;
        window.transactionApprovalService = { serverBacked: true, async edit(id, patch, revision) { editPatch = { ...patch }; return { id, ...patch, revision: revision + 1 }; } };
        reviewStore.clear();
        const staged = reviewStore.stage([{
            sourceId: 'ui-checking-payroll', date: '2026-10-08', description: 'Employer Payroll', merchant: 'Employer Payroll', amount: -1250,
            category: 'Transfer,Payroll', account: 'Checking Account', payment_method: 'Checking Account', type: 'income'
        }], { source: 'bank-provider', batchId: 'ui-checking-payroll' })[0];
        reviewStore.pending.get(staged.id).sourceOriginal = { ...staged, amount: -1250, type: 'expense' };
        renderReviewInbox();
        document.querySelector(`button.review-edit[data-review-id="${staged.id}"]`).click();
        await new Promise(resolve => setTimeout(resolve, 0));
        const incomeBeforeToggle = reviewStore.get(staged.id).amount;
        document.getElementById('modalType').value = 'expense';
        document.getElementById('modalAmount').value = '1250';
        document.getElementById('saveTransaction').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        const saved = reviewStore.get(staged.id);
        const result = { incomeBeforeToggle, type: saved && saved.type, amount: saved && saved.amount, editAmount: editPatch && editPatch.amount, acceptedCount: transactions.length };
        reviewStore.clear();
        renderReviewInbox();
        window.transactionApprovalService = originalService;
        return result;
    });
    assert.equal(checkingIncomeTypeToggleSmoke.incomeBeforeToggle, 1250, 'Checking income should open in the familiar editor with a positive amount.');
    assert.deepEqual({ type: checkingIncomeTypeToggleSmoke.type, amount: checkingIncomeTypeToggleSmoke.amount }, { type: 'expense', amount: -1250 }, 'Changing the checking income type to expense restores the provider negative sign.');
    assert.equal(checkingIncomeTypeToggleSmoke.editAmount, 1250, 'The authenticated edit receives the visible amount and server-side normalization owns the final sign.');
    assert.equal(checkingIncomeTypeToggleSmoke.acceptedCount, 1, 'Type edits remain pending and do not write accepted history.');
    const cutoffConflictSmoke = await page.evaluate(async () => {
        const originalService = window.transactionApprovalService;
        window.transactionApprovalService = {
            serverBacked: true,
            async updateSyncSettings() { throw new Error('Sync settings changed since they were loaded.'); },
            async syncSettings() { return { ready: true, cutoffDate: '2026-10-10', revision: 3 }; }
        };
        syncCutoffDate = '2026-10-09';
        syncCutoffRevision = 2;
        renderSyncSettings();
        const input = document.getElementById('syncCutoffDate');
        input.value = '2026-10-11';
        document.getElementById('saveSyncCutoff').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        const result = { requested: input.value, status: document.getElementById('syncCutoffStatus').textContent, revision: syncCutoffRevision, current: syncCutoffDate };
        window.transactionApprovalService = originalService;
        renderSyncSettings();
        return result;
    });
    assert.equal(cutoffConflictSmoke.requested, '2026-10-11', 'Cutoff conflicts must preserve the requested date for an explicit retry.');
    assert.equal(cutoffConflictSmoke.current, '2026-10-10', 'Cutoff conflict handling must refresh the server setting without syncing.');
    assert.equal(cutoffConflictSmoke.revision, 3, 'Cutoff conflict handling must refresh the revision fence.');
    assert.match(cutoffConflictSmoke.status, /changed elsewhere|save again/i);
    const screenshotDirectory = 'D:\\Documents\\Codex\\.assistant-storage\\budget-tool-verification\\review-improvements-20261020-r1';
    const screenshotPath = path.join(screenshotDirectory, 'synthetic-review-editor.png');
    await fs.promises.mkdir(screenshotDirectory, { recursive: true });
    await page.evaluate(() => {
        reviewStore.clear();
        const staged = reviewStore.stage([{
            sourceId: 'ui-review-screenshot-csv', date: '2026-10-12', description: 'Synthetic review purchase', merchant: 'Synthetic Merchant', amount: -21.75,
            category: 'Restaurants', account: 'Checking', payment_method: 'Checking', type: 'expense'
        }, {
            sourceId: 'ui-review-screenshot-provider', date: '2026-10-13', description: 'Synthetic review purchase #2', merchant: 'Synthetic Merchant VenX', amount: -21.75,
            category: 'Restaurants', account: 'Checking', payment_method: 'Checking', type: 'expense'
        }], { source: 'bank-csv', batchId: 'ui-review-screenshot' });
        renderReviewInbox();
        openReviewCategoryModal(staged[1].id, staged.map(item => item.id));
    });
    await page.waitForFunction(() => document.getElementById('categoryModal').classList.contains('active') && document.getElementById('saveTransaction').textContent === 'Save & Next');
    await page.screenshot({ path: screenshotPath });
    assert.equal(fs.existsSync(screenshotPath), true, 'Synthetic review editor screenshot must be written to the D: evidence directory.');
    const screenshotBottomPath = path.join(screenshotDirectory, 'synthetic-review-editor-bottom.png');
    await page.evaluate(() => { const content = document.querySelector('#categoryModal .modal-content'); if (content) content.scrollTop = content.scrollHeight; });
    await page.screenshot({ path: screenshotBottomPath });
    assert.equal(fs.existsSync(screenshotBottomPath), true, 'Synthetic review editor control screenshot must be written to the D: evidence directory.');
    await page.evaluate(() => { closeCategoryReviewModal(); reviewStore.clear(); renderReviewInbox(); });
    const authenticatedLoadPersistence = await page.evaluate(async () => {
        const originalService = window.transactionApprovalService;
        let serverSaveCalls = 0;
        window.transactionApprovalService = {
            serverBacked: true,
            async loadReview() { return null; },
            async listPending() { return []; },
            async saveAcceptedState() { serverSaveCalls += 1; return { ok: true, revision: 1 }; }
        };
        window.__txWrites = [];
        window.__txReads = [];
        window.__setSharedData({
            transactions: [
                { sourceId: 'opaque-history-load', date: 'Unknown', description: 'Opaque historical row', amount: -7.25, category: 'Restaurants', account: 'Checking', payment_method: 'Checking', type: 'expense' },
                { sourceId: 'month-navigation-load', date: '2026-10-01', description: 'Month navigation row', amount: -1.5, category: 'Restaurants', account: 'Checking', payment_method: 'Checking', type: 'expense' }
            ],
            categories: [{ name: 'Restaurants', type: 'expense', isCumulative: true, cumulativeAmount: 0, bankBalances: { '2026-10': 0 } }],
            budgets: { Restaurants: { '2026-10': 100 } }, merchantDefaults: {}, categoryGroups: [], categoryColors: {}, categoryOrder: [], revision: 4
        });
        await window.loadFromFirestore();
        window.selectMonth('2026-10');
        document.querySelector('.nav-item[data-tab="import"]').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        const configuredServiceResult = { serverSaveCalls, transactionWrites: window.__txWrites.slice(), loaded: transactions.some(transaction => transaction.description === 'Opaque historical row') };
        window.transactionApprovalService = undefined;
        window.__failSharedRead = true;
        window.localStorage.setItem('budget_transactions', JSON.stringify([{ sourceId: 'opaque-history-fallback', date: 'Unknown', description: 'Opaque fallback row', amount: -8.25, category: 'Restaurants', account: 'Checking', payment_method: 'Checking', type: 'expense' }]));
        window.localStorage.setItem('budget_categories', JSON.stringify([{ name: 'Restaurants', type: 'expense', isCumulative: true, cumulativeAmount: 0, bankBalances: { '2026-10': 0 } }]));
        window.localStorage.setItem('budget_budgets', JSON.stringify({ Restaurants: { '2026-10': 100 } }));
        window.localStorage.setItem('budget_category_order', JSON.stringify([]));
        window.__txWrites = [];
        await window.loadFromFirestore();
        await new Promise(resolve => setTimeout(resolve, 0));
        const fallbackResult = { transactionWrites: window.__txWrites.slice(), loaded: transactions.some(transaction => transaction.description === 'Opaque fallback row') };
        window.__failSharedRead = false;
        window.__setSharedData({
            transactions: [{ sourceId: 'old-user-visible', date: '2026-10-01', description: 'Old user transaction', amount: -1.25, category: 'Restaurants', account: 'Checking', payment_method: 'Checking', type: 'expense' }],
            categories: [{ name: 'Restaurants', type: 'expense' }],
            budgets: {}, merchantDefaults: {}, categoryGroups: [], categoryColors: {}, categoryOrder: [], revision: 0
        });
        window.transactionApprovalService = originalService;
        await window.loadFromFirestore();
        document.querySelector('.nav-item[data-tab="monthly"]').click();
        return { configuredServiceResult, fallbackResult };
    });
    assert.equal(authenticatedLoadPersistence.configuredServiceResult.serverSaveCalls, 0, 'Authenticated snapshot loading must not call the approval save service while deriving cumulative display state');
    assert.deepEqual(authenticatedLoadPersistence.configuredServiceResult.transactionWrites, [], 'Authenticated snapshot loading must not write shared/data while deriving cumulative display state');
    assert.equal(authenticatedLoadPersistence.configuredServiceResult.loaded, true, 'Authenticated snapshot loading must still retain opaque historical rows');
    assert.deepEqual(authenticatedLoadPersistence.fallbackResult.transactionWrites, [], 'Authenticated local fallback must not write shared/data while rendering an offline snapshot');
    assert.equal(authenticatedLoadPersistence.fallbackResult.loaded, true, 'Authenticated local fallback must still retain opaque historical rows');
    const disabledProviderResume = await page.evaluate(async () => {
        const originalEnabled = window.TRANSACTION_LINK_ENABLED;
        const originalService = window.transactionApprovalService;
        let statusCalls = 0;
        window.TRANSACTION_LINK_ENABLED = false;
        window.transactionApprovalService = { async linkStatus() { statusCalls += 1; throw new Error('disabled Link must not call the backend'); } };
        window.providerLinkStorageWrite({ kind: 'pending', uid: window.firebase.auth().currentUser.uid, connectionKey: 'chase', requestId: 'disabled-stale', expiresAt: Date.now() + 60000 });
        await window.resumeProviderLink();
        const result = {
            statusCalls,
            storage: sessionStorage.getItem('budget_provider_link_session_v1'),
            pendingCleared: providerLinkPending === null,
            bindingSelects: document.querySelectorAll('#providerLinkBindings select').length
        };
        window.TRANSACTION_LINK_ENABLED = originalEnabled;
        if (originalService === undefined) delete window.transactionApprovalService;
        else window.transactionApprovalService = originalService;
        return result;
    });
    assert.equal(disabledProviderResume.statusCalls, 0, 'disabled Link resume must not call the backend for stale provider state');
    assert.equal(disabledProviderResume.storage, null, 'disabled Link resume must clear stale provider session storage');
    assert.equal(disabledProviderResume.pendingCleared, true, 'disabled Link resume must clear stale in-memory provider state');
    assert.equal(disabledProviderResume.bindingSelects, 0, 'disabled Link resume must not render stale account mappings');
    const authSwitchRegression = await page.evaluate(async () => {
        window.__delaySharedRead = true;
        window.__sharedReadStarted = false;
        window.firebase.auth().__refreshUser();
        await new Promise(resolve => { const check = () => window.__sharedReadStarted ? resolve() : setTimeout(check, 0); check(); });
        const sameUser = {
            appDisplay: document.querySelector('.app-layout').style.display,
            oldTransactionVisible: document.body.innerText.includes('Old user transaction')
        };
        window.firebase.auth().__switchUnauthorizedUser();
        const switched = {
            appDisplay: document.querySelector('.app-layout').style.display,
            loginDisplay: document.getElementById('loginScreen').style.display,
            oldTransactionVisible: document.body.innerText.includes('Old user transaction')
        };
        window.__delaySharedRead = false;
        if (typeof window.__resolveSharedRead === 'function') window.__resolveSharedRead();
        await new Promise(resolve => setTimeout(resolve, 0));
        const afterDelayedLoad = {
            appDisplay: document.querySelector('.app-layout').style.display,
            loginDisplay: document.getElementById('loginScreen').style.display,
            oldTransactionVisible: document.body.innerText.includes('Old user transaction')
        };
        return { sameUser, switched, afterDelayedLoad };
    });
    assert.equal(authSwitchRegression.sameUser.appDisplay, 'flex', 'same-user auth refresh must preserve the accepted app UI');
    assert.equal(authSwitchRegression.sameUser.oldTransactionVisible, true, 'same-user auth refresh must preserve accepted transactions');
    assert.equal(authSwitchRegression.switched.appDisplay, 'none', 'identity change must hide accepted UI before authorization completes');
    assert.equal(authSwitchRegression.switched.loginDisplay, 'flex', 'identity change must return to the pending-auth screen');
    assert.equal(authSwitchRegression.switched.oldTransactionVisible, false, 'identity change must clear the prior user transaction UI');
    assert.equal(authSwitchRegression.afterDelayedLoad.appDisplay, 'none', 'a delayed old-user load must not re-show the app');
    assert.equal(authSwitchRegression.afterDelayedLoad.oldTransactionVisible, false, 'a delayed old-user load must not restore prior user data');
    await page.evaluate(async () => { await window.firebase.auth().signInWithPopup(); });
    await page.waitForFunction(() => document.querySelector('.app-layout').style.display === 'flex');
    const delayedSignOutRegression = await page.evaluate(async () => {
        window.__delaySharedRead = true;
        window.__sharedReadStarted = false;
        window.firebase.auth().__refreshUser();
        await new Promise(resolve => { const check = () => window.__sharedReadStarted ? resolve() : setTimeout(check, 0); check(); });
        await window.firebase.auth().signOut();
        window.__delaySharedRead = false;
        if (typeof window.__resolveSharedRead === 'function') window.__resolveSharedRead();
        await new Promise(resolve => setTimeout(resolve, 0));
        return {
            appDisplay: document.querySelector('.app-layout').style.display,
            oldTransactionVisible: document.body.innerText.includes('Old user transaction')
        };
    });
    assert.equal(delayedSignOutRegression.appDisplay, 'none', 'a delayed load must not restore the app after sign-out');
    assert.equal(delayedSignOutRegression.oldTransactionVisible, false, 'a delayed load must not restore old-user data after sign-out');
    const delayedFileReadRegression = await page.evaluate(async () => {
        const OriginalFileReader = window.FileReader;
        const originalService = window.transactionApprovalService;
        const originalConfirm = window.confirm;
        let restoreCalls = 0;
        window.__fileReadStarted = false;
        window.__resolveFileRead = null;
        window.transactionApprovalService = { ...originalService, serverBacked: true, async restore() { restoreCalls += 1; return { ok: true, revision: 1, state: {} }; } };
        window.confirm = () => true;
        window.FileReader = function DelayedFileReader() {
            const real = new OriginalFileReader();
            this.onload = null;
            this.readAsText = file => {
                window.__fileReadStarted = true;
                window.__resolveFileRead = () => { real.onload = this.onload; real.readAsText(file); };
            };
        };
        const backup = window.TransactionReview.createBackup({ transactions: [{ sourceId: 'file-read-stale', date: '2026-10-03', description: 'Stale file read', amount: -3, category: 'Restaurants', account: 'Checking' }], categories: [{ name: 'Restaurants', type: 'expense' }], budgets: {}, merchantDefaults: {} });
        window.importData({ files: [new File([JSON.stringify(backup)], 'file-read-stale.json', { type: 'application/json' })] });
        await new Promise(resolve => { const check = () => window.__fileReadStarted ? resolve() : setTimeout(check, 0); check(); });
        await window.firebase.auth().signOut();
        window.__resolveFileRead();
        await new Promise(resolve => setTimeout(resolve, 0));
        const stale = { restoreCalls, appDisplay: document.querySelector('.app-layout').style.display, staleVisible: document.body.innerText.includes('Stale file read') };
        window.FileReader = OriginalFileReader;
        window.transactionApprovalService = originalService;
        window.confirm = originalConfirm;
        return stale;
    });
    assert.equal(delayedFileReadRegression.restoreCalls, 0, 'a stale FileReader callback must not call the restore service');
    assert.equal(delayedFileReadRegression.appDisplay, 'none', 'a stale FileReader callback must not show the app after sign-out');
    assert.equal(delayedFileReadRegression.staleVisible, false, 'a stale FileReader callback must not install the selected backup');
    const delayedCsvImportSwitchRegression = await page.evaluate(async () => {
        const OriginalFileReader = window.FileReader;
        const originalParse = window.Papa.parse;
        let resolveFileRead;
        window.__csvReadStarted = false;
        window.Papa.parse = () => ({ data: [['Date', 'Description', 'Amount'], ['10/05/2026', 'Stale CSV row', '-3.00']], errors: [] });
        window.FileReader = function DelayedCsvReader() {
            const real = new OriginalFileReader();
            this.onload = null;
            this.readAsText = file => {
                window.__csvReadStarted = true;
                resolveFileRead = () => { real.onload = this.onload; real.readAsText(file); };
            };
        };
        document.getElementById('bankCsvAccount').value = 'Checking Account';
        const alertCount = window.__alerts.length;
        window.handleNewImport([new File(['ignored'], 'stale.csv', { type: 'text/csv' })]);
        await new Promise(resolve => { const check = () => window.__csvReadStarted ? resolve() : setTimeout(check, 0); check(); });
        window.firebase.auth().__switchUnauthorizedUser();
        resolveFileRead();
        await new Promise(resolve => setTimeout(resolve, 25));
        const result = {
            stagedAlert: window.__alerts.slice(alertCount).some(message => String(message).includes('Staged')),
            staleRowVisible: document.body.innerText.includes('Stale CSV row'),
            previewHidden: document.getElementById('importPreview').classList.contains('hidden')
        };
        window.FileReader = OriginalFileReader;
        window.Papa.parse = originalParse;
        return result;
    });
    assert.equal(delayedCsvImportSwitchRegression.stagedAlert, false, 'a CSV FileReader callback from a prior auth epoch must not stage transactions');
    assert.equal(delayedCsvImportSwitchRegression.staleRowVisible, false, 'a CSV FileReader callback from a prior auth epoch must not render imported rows');
    assert.equal(delayedCsvImportSwitchRegression.previewHidden, true, 'a user switch must clear a pending CSV import preview');
    const delayedHistoricalCsvSwitchRegression = await page.evaluate(async () => {
        const originalParse = window.Papa.parse;
        let finishParse;
        window.__historicalCsvReadStarted = false;
        window.Papa.parse = (_file, options) => {
            window.__historicalCsvReadStarted = true;
            finishParse = () => options.complete({ data: [['Date', 'Description', 'Amount'], ['10/05/2026', 'Stale history row', '-3.00']], errors: [] });
        };
        const alertCount = window.__alerts.length;
        window.handleFiles([new File(['ignored'], 'stale-history.csv', { type: 'text/csv' })]);
        await new Promise(resolve => { const check = () => window.__historicalCsvReadStarted ? resolve() : setTimeout(check, 0); check(); });
        window.firebase.auth().__switchUnauthorizedUser();
        finishParse();
        await new Promise(resolve => setTimeout(resolve, 25));
        const result = {
            stagedAlert: window.__alerts.slice(alertCount).some(message => String(message).includes('Staged')),
            staleRowVisible: document.body.innerText.includes('Stale history row'),
            previewHidden: document.getElementById('importPreview').classList.contains('hidden'),
            stats: document.getElementById('importStats').textContent
        };
        window.Papa.parse = originalParse;
        return result;
    });
    assert.equal(delayedHistoricalCsvSwitchRegression.stagedAlert, false, 'a historical CSV callback from a prior auth epoch must not stage transactions');
    assert.equal(delayedHistoricalCsvSwitchRegression.staleRowVisible, false, 'a stale historical CSV callback must not render imported rows');
    assert.equal(delayedHistoricalCsvSwitchRegression.previewHidden, true, 'a user switch must clear a pending historical CSV import preview');
    await page.evaluate(async () => { await window.firebase.auth().signInWithPopup(); });
    await page.waitForFunction(() => document.querySelector('.app-layout').style.display === 'flex');
    await new Promise(resolve => setTimeout(resolve, 25));
    const signedOutOfflineImport = await page.evaluate(async () => {
        const OriginalFileReader = window.FileReader;
        const originalConfirm = window.confirm;
        window.__fileReadStarted = false;
        window.__resolveFileRead = null;
        window.confirm = () => true;
        window.FileReader = function DelayedFileReader() {
            const real = new OriginalFileReader();
            this.onload = null;
            this.readAsText = file => {
                window.__fileReadStarted = true;
                window.__resolveFileRead = () => { real.onload = this.onload; real.readAsText(file); };
            };
        };
        const backup = window.TransactionReview.createBackup({ transactions: [{ sourceId: 'offline-file-read', date: '2026-10-04', description: 'Offline file read', amount: -4, category: 'Restaurants', account: 'Checking' }], categories: [{ name: 'Restaurants', type: 'expense' }], budgets: {}, merchantDefaults: {} });
        window.importData({ files: [new File([JSON.stringify(backup)], 'offline-file-read.json', { type: 'application/json' })] });
        await new Promise(resolve => { const check = () => window.__fileReadStarted ? resolve() : setTimeout(check, 0); check(); });
        window.__resolveFileRead();
        await new Promise(resolve => setTimeout(resolve, 50));
        const result = { success: window.__alerts.some(message => message.includes('Data imported successfully')) };
        window.FileReader = OriginalFileReader;
        window.confirm = originalConfirm;
        return result;
    });
    assert.equal(signedOutOfflineImport.success, true, 'an unchanged signed-out epoch must retain offline backup restore');
    await page.evaluate(async () => { await window.firebase.auth().signInWithPopup(); });
    await page.waitForFunction(() => document.querySelector('.app-layout').style.display === 'flex');
    const delayedRestoreSignOutRegression = await page.evaluate(async () => {
        const originalService = window.transactionApprovalService;
        const originalConfirm = window.confirm;
        let resolveReview;
        window.__restoreLoadStarted = false;
        window.transactionApprovalService = {
            ...originalService,
            serverBacked: true,
            async restore() { return { ok: true, revision: 1, state: {} }; },
            async loadReview() {
                window.__restoreLoadStarted = true;
                return new Promise(resolve => { resolveReview = resolve; });
            }
        };
        window.confirm = () => true;
        const backup = window.TransactionReview.createBackup({
            transactions: [{ sourceId: 'delayed-restore', date: '2026-10-02', description: 'Delayed restore', amount: -2, category: 'Restaurants', account: 'Checking' }],
            categories: [{ name: 'Restaurants', type: 'expense' }], budgets: {}, merchantDefaults: {}
        });
        window.importData({ files: [new File([JSON.stringify(backup)], 'delayed-restore.json', { type: 'application/json' })] });
        await new Promise(resolve => { const check = () => window.__restoreLoadStarted ? resolve() : setTimeout(check, 0); check(); });
        await window.firebase.auth().signOut();
        resolveReview({ schemaVersion: 1, pending: [], rejected: [], accepted: [], audit: [], receipts: [], batchMeta: [] });
        await new Promise(resolve => setTimeout(resolve, 0));
        window.transactionApprovalService = originalService;
        window.confirm = originalConfirm;
        return {
            appDisplay: document.querySelector('.app-layout').style.display,
            oldTransactionVisible: document.body.innerText.includes('Delayed restore') || document.body.innerText.includes('Old user transaction')
        };
    });
    assert.equal(delayedRestoreSignOutRegression.appDisplay, 'none', 'a delayed restore must not re-show the app after sign-out');
    assert.equal(delayedRestoreSignOutRegression.oldTransactionVisible, false, 'a delayed restore must not install old-user state after sign-out');
    const browserHistoryRoundTrip = await page.evaluate(() => {
        const state = {
            transactions: [{ sourceId: 'browser-legacy-history', date: 'Unknown', description: 'Historical transaction', amount: -2, category: 'Restaurants', account: 'Checking' }],
            categories: [{ name: 'Restaurants', type: 'expense' }], budgets: {}, merchantDefaults: {}, categoryGroups: [], categoryColors: {}, categoryOrder: []
        };
        const first = window.TransactionReview.createBackup(state, { app: 'browser-smoke' }, { acceptedHistory: true });
        const restored = window.TransactionReview.restoreBackup(first, { requireApproval: true, approved: true });
        const second = window.TransactionReview.createBackup(restored, { app: 'browser-smoke' }, { acceptedHistory: true });
        return { firstDate: first.transactions[0].date, restoredDate: restored.transactions[0].date, secondDate: second.transactions[0].date, marker: second.metadata.acceptedHistoryDateCompatibility };
    });
    assert.equal(browserHistoryRoundTrip.firstDate, 'Unknown', 'browser history export must preserve opaque dates');
    assert.equal(browserHistoryRoundTrip.restoredDate, 'Unknown', 'browser history restore must preserve opaque dates');
    assert.equal(browserHistoryRoundTrip.secondDate, 'Unknown', 'browser history repeated export must preserve opaque dates');
    assert.deepEqual(browserHistoryRoundTrip.marker, { version: 1 });
    await page.evaluate(async () => { await window.firebase.auth().signInWithPopup(); });
    await page.waitForFunction(() => document.querySelector('.app-layout').style.display === 'flex');
    const actualHistoryState = {
        transactions: [{ sourceId: 'browser-legacy-download', date: 'Unknown', description: 'Historical download', amount: -2.5, category: 'Restaurants', account: 'Checking', payment_method: 'Checking', type: 'expense' }],
        categories: [{ name: 'Restaurants', type: 'expense' }], budgets: {}, merchantDefaults: {}, categoryGroups: [], categoryColors: {}, categoryOrder: []
    };
    await page.evaluate(state => {
        window.restoreAcceptedState(state);
        window.__restoreTransport = null;
        window.__restoreResponseState = null;
        window.__originalConfirmForHistory = window.confirm;
        window.confirm = () => true;
        window.transactionApprovalService = {
            serverBacked: true,
            async restore(nextState, expectedRevision) {
                window.__restoreTransport = JSON.parse(JSON.stringify(nextState));
                const responseState = { ...nextState };
                delete responseState.acceptedHistoryDateCompatibility;
                window.__restoreResponseState = JSON.parse(JSON.stringify(responseState));
                return { ok: true, revision: Number(expectedRevision || 0) + 1, state: responseState };
            }
        };
    }, actualHistoryState);
    const downloadPromise = page.waitForEvent('download');
    await page.evaluate(() => window.exportData());
    const historyDownload = await downloadPromise;
    const historyStream = await historyDownload.createReadStream();
    const historyChunks = [];
    for await (const chunk of historyStream) historyChunks.push(chunk);
    const downloadedHistory = Buffer.concat(historyChunks);
    const downloadedHistoryJson = JSON.parse(downloadedHistory.toString('utf8'));
    assert.equal(downloadedHistoryJson.transactions[0].date, 'Unknown', 'actual export must preserve opaque accepted-history dates');
    assert.deepEqual(downloadedHistoryJson.metadata.acceptedHistoryDateCompatibility, { version: 1 });
    await page.locator('#dataFileInput').setInputFiles({ name: 'opaque-history.json', mimeType: 'application/json', buffer: downloadedHistory });
    await page.waitForFunction(() => window.__restoreTransport && window.__restoreResponseState);
    const actualHistoryTransport = await page.evaluate(() => ({
        requestDate: window.__restoreTransport.transactions[0].date,
        requestMarker: window.__restoreTransport.acceptedHistoryDateCompatibility,
        responseDate: window.__restoreResponseState.transactions[0].date,
        responseHasMarker: Object.prototype.hasOwnProperty.call(window.__restoreResponseState, 'acceptedHistoryDateCompatibility'),
        localDate: JSON.parse(localStorage.getItem('budget_transactions'))[0].date,
        acceptedSignatureHasMarker: window.acceptedStateSignature().includes('acceptedHistoryDateCompatibility')
    }));
    assert.equal(actualHistoryTransport.requestDate, 'Unknown');
    assert.equal(actualHistoryTransport.requestMarker, true, 'actual import must send the compatibility marker to authenticated restore');
    assert.equal(actualHistoryTransport.responseDate, 'Unknown');
    assert.equal(actualHistoryTransport.responseHasMarker, false, 'canonical restore response must not contain the transport marker');
    assert.equal(actualHistoryTransport.localDate, 'Unknown');
    assert.equal(actualHistoryTransport.acceptedSignatureHasMarker, false);
    await page.evaluate(() => { window.confirm = window.__originalConfirmForHistory; });
    await page.locator('.nav-item[data-tab="import"]').click();
    await page.evaluate(() => window.stageReviewTransactions([{ sourceId: 'browser-smoke', date: '2026-10-01', description: 'Synthetic coffee', amount: -4.25, category: 'Restaurants', account: 'Checking', payment_method: 'Checking', type: 'expense' }], 'bank-csv'));
    await page.locator('.review-select').waitFor();
    await page.locator('.review-select').check();
    await page.waitForFunction(() => document.querySelector('.review-select') && document.querySelector('.review-select').checked === true);
    assert.equal(await page.locator('#addSelectedTransactions').isDisabled(), false, 'Add selected remained disabled after selection rerender.');
    await page.evaluate(() => {
      const previousState = cloneAcceptedState();
      const calls = [];
      window.__staleAcceptedQueue = { previousState, oldSnapshot: JSON.stringify(previousState.transactions), calls, persistedState: null, firstStarted: false, oldCallCount: 0, secondOldReached: false };
      window.transactionApprovalService = {
        serverBacked: true,
        async approve(payload) {
          const transactions = payload.map(item => {
            const accepted = { ...item };
            ['status', 'fingerprint', 'overlap', 'revision', 'reviewedRevision', 'batchId'].forEach(key => delete accepted[key]);
            return accepted;
          });
          return { ok: true, revision: 2, state: { transactions, categories: [{ name: 'Restaurants', type: 'expense' }], budgets: {}, merchantDefaults: {}, categoryGroups: [], categoryColors: {}, categoryOrder: [] } };
        },
        async saveAcceptedState(nextState, expectedRevision) {
          const isOldSnapshot = JSON.stringify(nextState.transactions) === window.__staleAcceptedQueue.oldSnapshot;
          calls.push({ count: nextState.transactions.length, descriptions: nextState.transactions.map(transaction => transaction.description), expectedRevision, isOldSnapshot });
          if (isOldSnapshot) window.__staleAcceptedQueue.oldCallCount += 1;
          if (isOldSnapshot && window.__staleAcceptedQueue.oldCallCount === 1) {
            window.__staleAcceptedQueue.firstStarted = true;
            return new Promise(resolve => {
              window.__releaseStaleAcceptedSave = () => resolve({ ok: true, revision: expectedRevision + 1, state: nextState });
            });
          }
          if (isOldSnapshot) window.__staleAcceptedQueue.secondOldReached = true;
          window.__staleAcceptedQueue.persistedState = JSON.parse(JSON.stringify(nextState));
          return { ok: true, revision: expectedRevision + 1, state: nextState };
        }
      };
      // Start two old snapshots before the normal approval handler runs. The
      // second remains behind the controlled first queue slot.
      window.__staleAcceptedQueue.firstPromise = saveToFirestore({ snapshot: previousState });
      window.__staleAcceptedQueue.secondPromise = null;
    });
    await page.waitForFunction(() => window.__staleAcceptedQueue && window.__staleAcceptedQueue.firstStarted === true);
    await page.evaluate(() => {
      window.__staleAcceptedQueue.secondPromise = saveToFirestore({ snapshot: window.__staleAcceptedQueue.previousState });
    });
    await page.locator('#addSelectedTransactions').click();
    await page.waitForFunction(() => document.querySelectorAll('.review-select').length === 0);
    const result = await page.evaluate(() => ({ alerts: window.__alerts.slice(), status: document.getElementById('reviewStatus').textContent }));
    assert.ok(result.alerts.some(message => message.includes('Added 1 selected transaction')), `Unexpected alerts: ${JSON.stringify(result.alerts)}`);
    assert.equal(result.status.includes('Added'), false, `Review status did not settle after approval: ${result.status}`);
    const staleAcceptedSave = await page.evaluate(async () => {
        window.__releaseStaleAcceptedSave();
        const results = await Promise.all([window.__staleAcceptedQueue.firstPromise, window.__staleAcceptedQueue.secondPromise]);
        return {
            results,
            calls: window.__staleAcceptedQueue.calls,
            oldCallCount: window.__staleAcceptedQueue.oldCallCount,
            secondOldReached: window.__staleAcceptedQueue.secondOldReached,
            acceptedDescriptions: transactions.map(transaction => transaction.description),
            epoch: acceptedStateEpoch
        };
    });
    assert.deepEqual(staleAcceptedSave.results, [false, false], 'Both pre-approval queued saves must be rejected as stale');
    assert.equal(staleAcceptedSave.oldCallCount, 1, `The second stale save must never reach persistence: ${JSON.stringify(staleAcceptedSave)}`);
    assert.equal(staleAcceptedSave.secondOldReached, false, 'The second stale save must remain behind the stale queue epoch');
    assert.deepEqual(staleAcceptedSave.acceptedDescriptions, ['Synthetic coffee'], 'The acknowledged approval must remain installed');

    // Exercise the normal accepted-edit handler. Its durable save is the
    // first queue slot; two pre-edit snapshots are intentionally enqueued
    // behind it. The accepted-state epoch must advance from the edit's
    // acknowledgement before either stale snapshot can reach persistence.
    await page.evaluate(() => {
      const editState = {
        transactions: [{ sourceId: 'legacy-edit', sourceRevision: '1', date: '2026-10-01', description: 'Before edit', amount: -4.25, category: 'Restaurants', account: 'Checking', payment_method: 'Checking', type: 'expense' }],
        categories: [{ name: 'Restaurants', type: 'expense' }], budgets: {}, merchantDefaults: {}, categoryGroups: [], categoryColors: {}, categoryOrder: ['Restaurants']
      };
      window.restoreAcceptedState(editState);
      window.renderAll();
      const previousState = window.cloneAcceptedState();
      window.__legacyEditQueue = { previousState, calls: [], editStarted: false, editCompleted: false, staleCallCount: 0, secondStaleReached: false, runTransactionCalls: 0, expectedRevision: cloudRevision };
      window.transactionApprovalService = { serverBacked: false };
      const firestore = window.firebase.firestore();
      window.__legacyEditQueue.originalRunTransaction = firestore.runTransaction;
      firestore.runTransaction = async callback => {
        window.__legacyEditQueue.runTransactionCalls += 1;
        if (window.__legacyEditQueue.runTransactionCalls > 1) {
          window.__legacyEditQueue.staleCallCount += 1;
          if (window.__legacyEditQueue.staleCallCount > 1) window.__legacyEditQueue.secondStaleReached = true;
        }
        if (window.__legacyEditQueue.runTransactionCalls === 1) {
          window.__legacyEditQueue.editStarted = true;
          return new Promise((resolve, reject) => {
            window.__releaseLegacyEdit = async () => {
              try {
                await callback({
                  get: async () => ({ exists: true, data: () => ({ revision: window.__legacyEditQueue.expectedRevision }) }),
                  set: (ref, value) => window.__legacyEditQueue.calls.push({ descriptions: value.transactions.map(transaction => transaction.description), isEdit: value.transactions.some(transaction => transaction.description === 'After edit'), expectedRevision: value.revision - 1 })
                });
                window.__legacyEditQueue.editCompleted = true;
                resolve();
              } catch (error) { reject(error); }
            };
          });
        }
        await callback({
          get: async () => ({ exists: true, data: () => ({ revision: window.__legacyEditQueue.expectedRevision }) }),
          set: () => {}
        });
      };
      document.querySelector('.transaction').click();
      document.getElementById('editTransDescription').value = 'After edit';
      document.getElementById('editTransSave').click();
    });
    await page.waitForFunction(() => window.__legacyEditQueue && window.__legacyEditQueue.editStarted === true);
    await page.evaluate(() => {
      const previous = window.__legacyEditQueue.previousState;
      window.__legacyEditQueue.firstStalePromise = window.saveToFirestore({ snapshot: previous });
      window.__legacyEditQueue.secondStalePromise = window.saveToFirestore({ snapshot: previous });
    });
    await page.evaluate(() => window.__releaseLegacyEdit());
    await page.waitForFunction(() => window.__legacyEditQueue && window.__legacyEditQueue.editCompleted === true);
    const legacyEditQueue = await page.evaluate(async () => ({
      staleResults: await Promise.all([window.__legacyEditQueue.firstStalePromise, window.__legacyEditQueue.secondStalePromise]),
      calls: window.__legacyEditQueue.calls,
      staleCallCount: window.__legacyEditQueue.staleCallCount,
      secondStaleReached: window.__legacyEditQueue.secondStaleReached,
      descriptions: transactions.map(transaction => transaction.description)
    }));
    assert.deepEqual(legacyEditQueue.staleResults, [false, false], 'Pre-edit queued saves must be rejected after the acknowledged edit');
    assert.equal(legacyEditQueue.staleCallCount, 0, `Stale pre-edit saves must not reach persistence: ${JSON.stringify(legacyEditQueue)}`);
    assert.equal(legacyEditQueue.secondStaleReached, false, 'The second pre-edit save must remain behind the accepted-edit epoch');
    assert.deepEqual(legacyEditQueue.descriptions, ['After edit'], 'The acknowledged edit must remain installed');
    await page.evaluate(() => { window.firebase.firestore().runTransaction = window.__legacyEditQueue.originalRunTransaction; });

    function installProviderHarness() {
        window.TRANSACTION_LINK_ENABLED = true;
        window.TRANSACTION_LINK_CONNECTIONS = [{ key: 'chase', label: 'Chase' }, { key: 'capital-one', label: 'Capital One' }];
        window.TRANSACTION_LINK_EXPECTED_INSTITUTIONS = { chase: 'ins_56', 'capital-one': 'ins_128026' };
        const state = { apiCreateCalls: 0, apiExchangeCalls: 0, apiStatusCalls: 0, disconnectCalls: 0, plaidCreateCalls: 0, options: null };
        window.__providerHarness = state;
        window.transactionApprovalService = {
            serverBacked: true,
            async listPending() { return []; },
            async createLinkToken(connectionKey, sessionId) {
                state.apiCreateCalls += 1;
                return { connectionKey, sessionId, mode: 'create', linkToken: 'synthetic-link-token' };
            },
            async exchangeLink(connectionKey, publicToken, accountBindings, requestId) {
                state.apiExchangeCalls += 1;
                state.publicToken = publicToken;
                if (publicToken) return { status: 'pending-binding', connectionKey, exchangeId: requestId, itemId: 'synthetic-item', accounts: [{ account_id: 'provider-checking', name: 'Checking', type: 'depository', subtype: 'checking' }] };
                return { connectionKey, itemId: 'synthetic-item', accounts: [{ accountId: 'provider-checking' }], accountMap: accountBindings };
            },
            async linkStatus(connectionKey, requestId) {
                state.apiStatusCalls += 1;
                state.lastStatus = { connectionKey, requestId };
                if (state.recoveryFail) throw new Error('Approval service request failed.');
                if (state.recoveryRequestId && requestId !== state.recoveryRequestId) throw new Error('Wrong synthetic recovery receipt.');
                return { status: 'pending-binding', connectionKey: state.recoveryResultConnectionKey || connectionKey, exchangeId: requestId, itemId: 'synthetic-item', accounts: [{ account_id: 'provider-checking', name: 'Checking', type: 'depository', subtype: 'checking' }] };
            },
            async updateLinkToken() { throw new Error('Synthetic browser test does not exercise update mode.'); },
            async disconnectLink(connectionKey) { state.disconnectCalls += 1; state.disconnectedKey = connectionKey; return { status: 'removed', connectionKey }; }
        };
        window.Plaid = {
            create(options) {
                state.plaidCreateCalls += 1;
                state.options = options;
                return { open() { state.opened = true; } };
            }
        };
    }
    await page.addInitScript(installProviderHarness);
    await page.evaluate(installProviderHarness);
    const staleToken = await page.evaluate(async () => {
        const original = window.transactionApprovalService;
        let resolveCreate;
        window.transactionApprovalService = { ...original, async createLinkToken() { window.__staleCreateStarted = true; return new Promise(resolve => { resolveCreate = resolve; }); } };
        const pending = window.openProviderLink('create').then(() => 'resolved').catch(error => error.message);
        await new Promise(resolve => { const check = () => window.__staleCreateStarted ? resolve() : setTimeout(check, 0); check(); });
        await window.firebase.auth().signOut();
        resolveCreate({ connectionKey: 'chase', sessionId: 'stale-session', linkToken: 'stale-token' });
        return pending;
    });
    assert.match(staleToken, /Authentication changed/);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('budget_provider_link_session_v1')), null, 'stale Link-token result must not install another user session');
    await page.evaluate(async () => { await window.firebase.auth().signInWithPopup(); });
    await page.evaluate(installProviderHarness);
    await page.evaluate(() => window.refreshProviderLinkUi());
    const disconnectUi = await page.evaluate(async () => {
        const originalConfirm = window.confirm;
        window.confirm = () => true;
        document.getElementById('providerLinkConnection').value = 'capital-one';
        document.getElementById('providerLinkConnection').dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('providerLinkDisconnect').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        window.confirm = originalConfirm;
        return { calls: window.__providerHarness.disconnectCalls, key: window.__providerHarness.disconnectedKey, status: document.getElementById('providerLinkStatus').textContent };
    });
    assert.equal(disconnectUi.calls, 1, 'Disconnect requires an explicit authenticated UI action.');
    assert.equal(disconnectUi.key, 'capital-one');
    assert.match(disconnectUi.status, /Bank connection removed/);
    await page.evaluate(() => window.refreshProviderLinkUi());

    const staleExchange = await page.evaluate(async () => {
        let resolveExchange;
        const base = window.transactionApprovalService;
        window.transactionApprovalService = { ...base, async exchangeLink() { window.__staleExchangeStarted = true; return new Promise(resolve => { resolveExchange = resolve; }); } };
        await window.openProviderLink('create');
        const options = window.__providerHarness.options;
        const pending = options.onSuccess('stale-public-token', { institution: { institution_id: 'ins_56' } }).then(() => 'resolved').catch(error => error.message);
        await new Promise(resolve => { const check = () => window.__staleExchangeStarted ? resolve() : setTimeout(check, 0); check(); });
        window.firebase.auth().__switchUser();
        resolveExchange({ status: 'pending-binding', accounts: [] });
        return pending;
    });
    assert.equal(staleExchange, 'resolved', 'stale Link exchange callback may finish only by ignoring its result');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('budget_provider_link_session_v1')), null, 'stale Link exchange result must not render or persist for a switched user');
    await page.evaluate(async () => { await window.firebase.auth().signInWithPopup(); });
    await page.evaluate(installProviderHarness);
    await page.evaluate(() => window.refreshProviderLinkUi());

    const staleStatus = await page.evaluate(async () => {
        window.providerLinkStorageWrite({ kind: 'pending', uid: window.firebase.auth().currentUser.uid, connectionKey: 'chase', requestId: 'stale-status', expiresAt: Date.now() + 60000 });
        let resolveStatus;
        const base = window.transactionApprovalService;
        window.transactionApprovalService = { ...base, async linkStatus() { window.__staleStatusStarted = true; return new Promise(resolve => { resolveStatus = resolve; }); } };
        const pending = window.resumeProviderLinkPending().then(() => 'resolved').catch(error => error.message);
        await new Promise(resolve => { const check = () => window.__staleStatusStarted ? resolve() : setTimeout(check, 0); check(); });
        await window.firebase.auth().signOut();
        resolveStatus({ status: 'pending-binding', accounts: [{ account_id: 'stale-account', name: 'Stale' }] });
        return pending;
    });
    assert.equal(staleStatus, 'resolved');
    assert.equal(await page.evaluate(() => document.querySelectorAll('#providerLinkBindings select').length), 0, 'stale status result must not render account bindings');
    await page.evaluate(async () => { await window.firebase.auth().signInWithPopup(); });
    await page.evaluate(installProviderHarness);
    await page.evaluate(() => window.refreshProviderLinkUi());

    const wrongInstitution = await page.evaluate(async () => {
        await window.openProviderLink('create');
        const before = window.__providerHarness.apiExchangeCalls;
        await window.__providerHarness.options.onSuccess('wrong-institution-public-token', { institution: { institution_id: 'ins_128026' } });
        return { before, after: window.__providerHarness.apiExchangeCalls, storage: sessionStorage.getItem('budget_provider_link_session_v1') };
    });
    assert.equal(wrongInstitution.after, wrongInstitution.before, 'Wrong Link institution metadata must not exchange a public token');
    assert.equal(wrongInstitution.storage, null, 'Wrong Link institution metadata must clear temporary Link storage');
    const missingInstitution = await page.evaluate(async () => {
        await window.openProviderLink('create');
        const before = window.__providerHarness.apiExchangeCalls;
        await window.__providerHarness.options.onSuccess('missing-institution-public-token', {});
        return { before, after: window.__providerHarness.apiExchangeCalls, storage: sessionStorage.getItem('budget_provider_link_session_v1') };
    });
    assert.equal(missingInstitution.after, missingInstitution.before, 'Missing Link institution metadata must not exchange a public token');
    assert.equal(missingInstitution.storage, null, 'Missing Link institution metadata must clear temporary Link storage');
    await page.evaluate(installProviderHarness);
    await page.evaluate(() => window.refreshProviderLinkUi());

    await page.evaluate(() => window.refreshProviderLinkUi());
    await page.evaluate(async () => window.openProviderLink('create'));
    const initialLink = await page.evaluate(() => ({ state: window.__providerHarness, storage: JSON.parse(sessionStorage.getItem('budget_provider_link_session_v1')) }));
    assert.equal(initialLink.state.apiCreateCalls, 1);
    assert.equal(initialLink.state.options.receivedRedirectUri, undefined);
    assert.equal(initialLink.storage.kind, 'link');
    await page.evaluate(() => history.replaceState({}, '', '/index.html?oauth_state_id=synthetic-oauth'));
    await page.evaluate(async () => window.openProviderLink('create', true));
    const resumedLink = await page.evaluate(() => ({ state: window.__providerHarness, url: window.__providerHarness.options.receivedRedirectUri }));
    assert.equal(resumedLink.state.apiCreateCalls, 1, 'OAuth resume must reuse the issued Link token.');
    assert.match(resumedLink.url, /oauth_state_id=synthetic-oauth/);
    await page.evaluate(async () => window.__providerHarness.options.onSuccess('synthetic-public-token', { institution: { institution_id: 'ins_56' } }));
    const pendingLink = await page.evaluate(() => ({ state: window.__providerHarness, storage: JSON.parse(sessionStorage.getItem('budget_provider_link_session_v1')), raw: sessionStorage.getItem('budget_provider_link_session_v1') }));
    assert.equal(pendingLink.state.apiExchangeCalls, 1);
    assert.equal(pendingLink.storage.kind, 'pending');
    assert.doesNotMatch(pendingLink.raw, /synthetic-public-token/);
    await page.evaluate(() => window.providerLinkStorageWrite({ kind: 'pending', uid: window.firebase.auth().currentUser.uid, connectionKey: 'capital-one', requestId: 'capital-one-recovery', expiresAt: Date.now() + 60000 }));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('.app-layout').style.display === 'flex');
    await page.waitForTimeout(25);
    const reloadLink = await page.evaluate(() => ({ state: window.__providerHarness, storage: JSON.parse(sessionStorage.getItem('budget_provider_link_session_v1')), selected: document.getElementById('providerLinkConnection').value, selects: document.querySelectorAll('#providerLinkBindings select').length }));
    assert.equal(reloadLink.state.apiCreateCalls, 0, 'Pending reload must not create another Link Item.');
    assert.equal(reloadLink.state.apiStatusCalls, 0, 'Pending reload must not contact the durable server receipt without a fresh user action.');
    assert.equal(reloadLink.storage.kind, 'pending');
    assert.equal(reloadLink.storage.connectionKey, 'capital-one');
    assert.equal(reloadLink.selected, 'capital-one', 'Pending reload must select the stored bank before offering Resume.');
    assert.equal(reloadLink.selects, 0, 'Pending reload must not render stale account mappings before explicit resume.');
    await page.locator('.nav-item[data-tab="import"]').click();
    await page.waitForFunction(() => getComputedStyle(document.getElementById('providerLinkResume')).display !== 'none');
    await page.locator('#providerLinkResume').click();
    const recoveredLink = await page.evaluate(() => ({ state: window.__providerHarness, storage: JSON.parse(sessionStorage.getItem('budget_provider_link_session_v1')), selects: document.querySelectorAll('#providerLinkBindings select').length }));
    assert.equal(recoveredLink.state.apiCreateCalls, 0, 'Pending reload must not create another Link Item.');
    assert.equal(recoveredLink.state.apiStatusCalls, 1, 'Explicit resume must query the durable server receipt.');
    assert.equal(recoveredLink.storage.kind, 'pending');
    assert.equal(recoveredLink.selects, 1, 'Pending reload must render the server-returned account list.');

    await page.evaluate(() => {
        window.providerLinkStorageWrite({ kind: 'pending', uid: window.firebase.auth().currentUser.uid, connectionKey: 'capital-one', requestId: 'capital-one-recovery', expiresAt: Date.now() + 60000 });
        window.clearProviderLinkUiState();
        document.getElementById('providerLinkConnection').value = 'capital-one';
        document.getElementById('providerLinkResume').style.display = '';
        const base = window.transactionApprovalService;
        window.__resumeBaseService = base;
        window.__resumeDeferredStarted = false;
        window.__resumeDeferredDone = false;
        window.transactionApprovalService = {
            ...base,
            linkStatus(connectionKey, requestId) {
                window.__resumeDeferredStarted = true;
                return new Promise(resolve => { window.__resumeDeferredResolve = resolve; }).finally(() => { window.__resumeDeferredDone = true; });
            }
        };
    });
    await page.locator('#providerLinkResume').click();
    await page.waitForFunction(() => window.__resumeDeferredStarted === true);
    await page.evaluate(() => {
        const select = document.getElementById('providerLinkConnection');
        select.value = 'chase';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        window.__resumeDeferredResolve({ status: 'pending-binding', connectionKey: 'capital-one', accounts: [{ account_id: 'stale-resume', name: 'Stale resume' }] });
    });
    await page.waitForFunction(() => window.__resumeDeferredDone === true);
    const changedResume = await page.evaluate(() => ({ selected: document.getElementById('providerLinkConnection').value, selects: document.querySelectorAll('#providerLinkBindings select').length }));
    assert.equal(changedResume.selected, 'chase', 'A pending resume selection change must remain visible.');
    assert.equal(changedResume.selects, 0, 'A pending resume response for the old bank must not render under the new selection.');
    await page.evaluate(() => { window.transactionApprovalService = window.__resumeBaseService; });

    const recoveryBaseline = await page.evaluate(() => {
        const state = window.__providerHarness;
        state.recoveryRequestId = 'capital-one-recovery';
        state.recoveryFail = false;
        state.recoveryResultConnectionKey = 'capital-one';
        state.apiStatusCalls = 0;
        sessionStorage.removeItem('budget_provider_link_session_v1');
        document.getElementById('providerLinkConnection').value = 'capital-one';
        return state.apiCreateCalls;
    });
    await page.locator('#providerLinkRecoveryToggle').click();
    await page.waitForFunction(() => getComputedStyle(document.getElementById('providerLinkRecovery')).display !== 'none');
    assert.equal(await page.locator('#providerLinkRecoveryCode').inputValue(), '', 'Recovery code must not be prefilled from stale browser state.');
    await page.locator('#providerLinkRecoveryCode').fill('capital-one-recovery');
    await page.locator('#providerLinkRecoveryResume').click();
    await page.waitForFunction(() => document.querySelectorAll('#providerLinkBindings select').length === 1);
    const recoveredWithoutStorage = await page.evaluate(() => ({
        state: window.__providerHarness,
        storage: JSON.parse(sessionStorage.getItem('budget_provider_link_session_v1')),
        connection: window.__providerHarness.lastStatus && window.__providerHarness.lastStatus.connectionKey,
        requestId: window.__providerHarness.lastStatus && window.__providerHarness.lastStatus.requestId,
        createDelta: window.__providerHarness.apiCreateCalls
    }));
    assert.equal(recoveredWithoutStorage.createDelta, recoveryBaseline, 'Direct recovery must not create another Link Item.');
    assert.equal(recoveredWithoutStorage.state.apiStatusCalls, 1, 'Receipt recovery must call linkStatus exactly once.');
    assert.equal(recoveredWithoutStorage.connection, 'capital-one', 'Recovery must stay bound to the selected connection.');
    assert.equal(recoveredWithoutStorage.requestId, 'capital-one-recovery');
    assert.equal(recoveredWithoutStorage.storage.connectionKey, 'capital-one');
    assert.equal(recoveredWithoutStorage.storage.requestId, 'capital-one-recovery');

    const failedAfterMapping = await page.evaluate(async () => {
        window.__providerHarness.recoveryFail = true;
        sessionStorage.removeItem('budget_provider_link_session_v1');
        window.showProviderLinkRecovery('capital-one');
        document.getElementById('providerLinkRecoveryCode').value = 'capital-one-recovery';
        await window.recoverProviderLinkFromReceipt();
        return {
            recoveryVisible: getComputedStyle(document.getElementById('providerLinkRecovery')).display !== 'none',
            storage: sessionStorage.getItem('budget_provider_link_session_v1'),
            selects: document.querySelectorAll('#providerLinkBindings select').length,
            confirmVisible: getComputedStyle(document.getElementById('providerLinkConfirm')).display !== 'none'
        };
    });
    assert.equal(failedAfterMapping.recoveryVisible, true, 'A failed recovery must leave the direct recovery control available.');
    assert.equal(failedAfterMapping.storage, null, 'A failed recovery must not preserve a stale pending receipt.');
    assert.equal(failedAfterMapping.selects, 0, 'A failed recovery must clear the previous bank mapping.');
    assert.equal(failedAfterMapping.confirmVisible, false, 'A failed recovery must not leave the previous confirmation action visible.');
    await page.evaluate(() => { window.__providerHarness.recoveryFail = false; });

    const mismatchedRecovery = await page.evaluate(async () => {
        window.__providerHarness.recoveryResultConnectionKey = 'chase';
        window.__providerHarness.apiStatusCalls = 0;
        sessionStorage.removeItem('budget_provider_link_session_v1');
        window.clearProviderLinkUiState();
        window.showProviderLinkRecovery('capital-one');
        document.getElementById('providerLinkRecoveryCode').value = 'capital-one-recovery';
        await window.recoverProviderLinkFromReceipt();
        return {
            statusCalls: window.__providerHarness.apiStatusCalls,
            storage: sessionStorage.getItem('budget_provider_link_session_v1'),
            selects: document.querySelectorAll('#providerLinkBindings select').length,
            creates: window.__providerHarness.apiCreateCalls
        };
    });
    assert.equal(mismatchedRecovery.statusCalls, 1, 'A recovery receipt must be checked once.');
    assert.equal(mismatchedRecovery.storage, null, 'A receipt returned for another connection must not be persisted.');
    assert.equal(mismatchedRecovery.selects, 0, 'A mismatched receipt must not render account bindings.');
    assert.equal(mismatchedRecovery.creates, recoveryBaseline, 'A mismatched receipt must not create a replacement Link Item.');
    await page.evaluate(() => { window.__providerHarness.recoveryResultConnectionKey = 'capital-one'; });

    const expiredRecovery = await page.evaluate(async () => {
        window.__providerHarness.apiStatusCalls = 0;
        window.providerLinkStorageWrite({ kind: 'pending', uid: window.firebase.auth().currentUser.uid, connectionKey: 'capital-one', requestId: 'expired-recovery', expiresAt: Date.now() - 1 });
        await window.resumeProviderLink({ userAction: true });
        document.getElementById('providerLinkConnection').value = 'capital-one';
        document.getElementById('providerLinkRecoveryToggle').click();
        return { storage: sessionStorage.getItem('budget_provider_link_session_v1'), statusCalls: window.__providerHarness.apiStatusCalls, selects: document.querySelectorAll('#providerLinkBindings select').length, visible: getComputedStyle(document.getElementById('providerLinkRecovery')).display !== 'none' };
    });
    assert.equal(expiredRecovery.storage, null, 'Expired recovery receipts must be removed.');
    assert.equal(expiredRecovery.statusCalls, 0, 'Expired recovery receipts must not call the backend.');
    assert.equal(expiredRecovery.selects, 0, 'Expired recovery receipts must clear account mapping UI.');
    assert.equal(expiredRecovery.visible, true, 'Expired storage must leave the direct recovery control available without a new Link attempt.');

    const failedRecovery = await page.evaluate(async () => {
        window.__providerHarness.recoveryFail = true;
        window.showProviderLinkRecovery('capital-one');
        document.getElementById('providerLinkRecoveryCode').value = 'capital-one-recovery';
        await window.recoverProviderLinkFromReceipt();
        return { recoveryVisible: getComputedStyle(document.getElementById('providerLinkRecovery')).display !== 'none', storage: sessionStorage.getItem('budget_provider_link_session_v1'), selects: document.querySelectorAll('#providerLinkBindings select').length };
    });
    assert.equal(failedRecovery.recoveryVisible, true, 'Failed receipt recovery must leave the recovery control available.');
    assert.equal(failedRecovery.storage, null, 'Failed receipt recovery must not create browser state.');
    assert.equal(failedRecovery.selects, 0, 'Failed receipt recovery must not render account mappings.');
    const deferredRecovery = await page.evaluate(async () => {
        let resolveStatus;
        const base = window.transactionApprovalService;
        window.__providerHarness.recoveryFail = false;
        window.__providerHarness.apiStatusCalls = 0;
        window.providerLinkStorageClear();
        window.showProviderLinkRecovery('capital-one');
        document.getElementById('providerLinkRecoveryCode').value = 'capital-one-recovery';
        window.transactionApprovalService = { ...base, async linkStatus() { window.__deferredRecoveryStarted = true; return new Promise(resolve => { resolveStatus = resolve; }); } };
        const pending = window.recoverProviderLinkFromReceipt();
        await new Promise(resolve => { const check = () => window.__deferredRecoveryStarted ? resolve() : setTimeout(check, 0); check(); });
        const select = document.getElementById('providerLinkConnection');
        select.value = 'chase';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        resolveStatus({ status: 'pending-binding', connectionKey: 'capital-one', accounts: [{ account_id: 'stale-recovery', name: 'Stale recovery' }] });
        await pending;
        window.transactionApprovalService = base;
        return { storage: sessionStorage.getItem('budget_provider_link_session_v1'), selects: document.querySelectorAll('#providerLinkBindings select').length, selected: select.value };
    });
    assert.equal(deferredRecovery.storage, null, 'A bank selection change must prevent deferred recovery from installing state.');
    assert.equal(deferredRecovery.selects, 0, 'A bank selection change must prevent deferred recovery bindings from rendering.');
    assert.equal(deferredRecovery.selected, 'chase', 'The selected bank change must be retained after rejecting stale recovery data.');
    await page.evaluate(() => { window.__providerHarness.recoveryFail = false; });
    await page.evaluate(() => window.firebase.auth().__switchUser());
    assert.equal(await page.evaluate(() => sessionStorage.getItem('budget_provider_link_session_v1')), null, 'switching users must clear the prior Link session');
    assert.equal(await page.evaluate(() => document.querySelectorAll('#providerLinkBindings select').length), 0, 'switching users must clear the prior account-mapping UI');

    const duplicateAccountLabels = await page.evaluate(() => {
        renderProviderAccountBindings([
            { account_id: 'chase-cff', name: 'Chase Card', type: 'credit', subtype: 'credit card', mask: '9981' },
            { account_id: 'chase-csp', name: 'Chase Card', type: 'credit', subtype: 'credit card', mask: '1963' }
        ]);
        return [...document.querySelectorAll('#providerLinkBindings label')].map(label => label.firstChild.textContent);
    });
    assert.equal(duplicateAccountLabels.length, 2);
    assert.match(duplicateAccountLabels[0], /Chase Card.*credit\/credit card.*9981/);
    assert.match(duplicateAccountLabels[1], /Chase Card.*credit\/credit card.*1963/);
    assert.notEqual(duplicateAccountLabels[0], duplicateAccountLabels[1], 'duplicate account names must remain distinguishable by bounded masks');

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

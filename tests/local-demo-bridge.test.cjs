'use strict';

/*
 * Local-only bridge E2E. Run with the checked-in Auth/Firestore emulator
 * config and a D: Firebase SDK dependency directory. This test refuses
 * non-demo or non-loopback environments and never reads the real backup.
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const { URL } = require('node:url');
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.BUDGET_TOOL_PLAYWRIGHT_BROWSERS_PATH || 'D:\\Documents\\Codex\\.assistant-storage\\playwright-browsers';
const { chromium } = require('playwright');
const admin = require('firebase-admin');
const sandbox = require('../plaid-sandbox.js');
const bridgeApi = require('../local-demo-bridge.js');

const ALLOWED_EMAIL = bridgeApi.ALLOWED_EMAIL;
const ALLOWED_PASSWORD = bridgeApi.FIXTURE_PASSWORD;
const UNAPPROVED_EMAIL = 'local-demo-bridge-unapproved@example.test';
const UNAPPROVED_PASSWORD = 'local-demo-bridge-unapproved-password';

async function signIn(email, password) {
    const response = await fetch(`http://${bridgeApi.AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-budget-tool`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true })
    });
    const body = await response.json();
    if (!response.ok || !body.idToken) throw new Error(`Local demo auth sign-in failed (${response.status}).`);
    return body.idToken;
}

function makeFailureDb(db, failure) {
    return {
        collection: name => db.collection(name),
        async runTransaction(callback) {
            if (!failure.nextCommit) return db.runTransaction(callback);
            failure.nextCommit = false;
            const writes = [];
            const transaction = {
                get: reference => reference.get(),
                set: (reference, value) => writes.push([reference, value]),
                delete: reference => writes.push([reference, null])
            };
            await callback(transaction);
            throw new Error('Synthetic local demo commit failure.');
        }
    };
}

;(async () => {
    const context = await bridgeApi.prepareLocalDemo({ localDepsDir: process.env.BUDGET_TOOL_LOCAL_DEPS });
    const existingUnapproved = await context.auth.getUserByEmail(UNAPPROVED_EMAIL).catch(() => null);
    if (!existingUnapproved) await context.auth.createUser({ uid: 'local-demo-bridge-unapproved', email: UNAPPROVED_EMAIL, password: UNAPPROVED_PASSWORD, emailVerified: true });
    const failure = { nextCommit: false };
    let setupCalls = 0;
    let providerCalls = 0;
    const setup = await sandbox.createSandboxSetup({
        allowNetwork: true,
        clientId: 'synthetic-client-id',
        secret: 'synthetic-client-secret',
        institutionId: 'ins_109508',
        overrideUsername: 'user_good',
        overridePassword: 'pass_good',
        transport: {
            async createPublicToken(request) {
                setupCalls += 1;
                assert.deepEqual(request, {
                    clientId: 'synthetic-client-id', secret: 'synthetic-client-secret', institutionId: 'ins_109508',
                    overrideUsername: 'user_good', overridePassword: 'pass_good'
                });
                return { publicToken: 'synthetic-public-token' };
            },
            async exchangePublicToken(request) {
                assert.deepEqual(request, { clientId: 'synthetic-client-id', secret: 'synthetic-client-secret', publicToken: 'synthetic-public-token' });
                return { accessToken: 'synthetic-access-token', itemId: 'synthetic-item-one' };
            },
            async getAccounts(request) {
                assert.deepEqual(request, { clientId: 'synthetic-client-id', secret: 'synthetic-client-secret', accessToken: 'synthetic-access-token' });
                return { accounts: [
                    { account_id: 'local-demo-account', name: 'Synthetic checking', type: 'depository', subtype: 'checking' },
                    { account_id: 'local-demo-card', name: 'Synthetic card', type: 'credit', subtype: 'credit card' }
                ] };
            }
        }
    });
    assert.equal(setupCalls, 1, 'the synthetic setup must create exactly one in-memory Item');
    assert.equal(setup.itemId, 'synthetic-item-one');
    const config = sandbox.createSandboxConfig({
        enabled: true,
        clientId: 'synthetic-client-id',
        secret: 'synthetic-client-secret',
        accessToken: setup.accessToken,
        connectionKey: bridgeApi.CONNECTION_KEY,
        accountMap: { 'local-demo-account': 'Checking Account' },
        ignoredAccountIds: ['local-demo-card']
    });
    const provider = sandbox.createSandboxProvider({ config, transport: {
        async sync(request) {
            assert.equal(request.clientId, 'synthetic-client-id');
            assert.equal(request.secret, 'synthetic-client-secret');
            assert.equal(request.accessToken, 'synthetic-access-token');
            providerCalls += 1;
            return { added: [{ transaction_id: 'local-bridge-transaction', date: '2026-10-10', amount: 4.25, account_id: 'local-demo-account', currency_code: 'USD', name: 'Local bridge coffee', category: 'Restaurants' }], modified: [], removed: [], has_more: false, next_cursor: `local-bridge-cursor-${providerCalls}` };
        }
    } });
    const bridge = await bridgeApi.createLocalDemoBridge({
        context,
        provider,
        mode: 'real',
        accessToken: config.accessToken,
        db: makeFailureDb(context.db, failure),
        connectionKey: bridgeApi.CONNECTION_KEY,
        localDepsDir: process.env.BUDGET_TOOL_LOCAL_DEPS,
        port: 0
    });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const pageErrors = [];
    const dialogs = [];
    page.on('pageerror', error => pageErrors.push(error));
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
    await page.route('**/*', async route => {
        const requestUrl = new URL(route.request().url());
        if (requestUrl.hostname === '127.0.0.1') return route.continue();
        return route.abort('blockedbyclient');
    });
    try {
        const rawIndex = await fetch(`${bridge.origin}/index.html`).then(response => ({ status: response.status, text: response.text() }));
        assert.equal(rawIndex.status, 400, 'local index without bootstrap marker must fail closed');
        const indexText = await (await fetch(bridge.url)).text();
        assert.match(indexText, /__BUDGET_TOOL_LOCAL_BRIDGE__=true/);
        assert.match(indexText, /projectId: 'demo-budget-tool'/);
        assert.doesNotMatch(indexText, /synthetic-client-id|synthetic-access-token|synthetic-client-secret|access_token/);
        await page.goto(bridge.url);
        await page.waitForFunction(() => document.querySelector('.app-layout').style.display === 'flex');
        assert.equal(await page.evaluate(() => window.transactionApprovalService.serverBacked), true);
        await page.locator('.nav-item[data-tab="import"]').click();
        await page.waitForFunction(() => document.querySelectorAll('.review-select').length === 1);
        assert.equal(providerCalls, 1);
        assert.deepEqual(await page.evaluate(() => ({ accepted: transactions.length, spending: getMonthCategorySpending('Restaurants', '2026-10') })), { accepted: 0, spending: 0 });
        await page.locator('.review-select').check();
        await page.waitForFunction(() => !document.getElementById('addSelectedTransactions').disabled);
        await page.locator('#addSelectedTransactions').click();
        await page.waitForFunction(() => document.querySelectorAll('.review-select').length === 0);
        assert.deepEqual(await page.evaluate(() => ({ accepted: transactions.length, spending: getMonthCategorySpending('Restaurants', '2026-10') })), { accepted: 1, spending: 4.25 });
        assert.equal((await context.db.collection('shared').doc('data').get()).data().transactions.length, 1);

        await page.evaluate(async () => {
            window.stageReviewTransactions([{ sourceId: 'local-bridge-failure', date: '2026-10-10', description: 'Local bridge failure', amount: -2, category: 'Restaurants', account: 'Checking Account', payment_method: 'Checking Account', type: 'expense' }], 'bank-csv');
            for (let attempt = 0; attempt < 30; attempt += 1) { if ((await window.transactionApprovalService.listPending()).length === 1) return; await new Promise(resolve => setTimeout(resolve, 30)); }
            throw new Error('Failed to stage local bridge failure candidate.');
        });
        await page.locator('.review-select').check();
        failure.nextCommit = true;
        const dialogStart = dialogs.length;
        await page.locator('#addSelectedTransactions').click();
        for (let attempt = 0; attempt < 40 && dialogs.length === dialogStart; attempt += 1) await new Promise(resolve => setTimeout(resolve, 25));
        assert.ok(dialogs.slice(dialogStart).some(message => message.includes('Nothing was added')));
        assert.equal((await context.db.collection('shared').doc('data').get()).data().transactions.length, 1);
        assert.equal((await bridge.service.backend.listPending({ uid: bridgeApi.FIXTURE_UID, email: ALLOWED_EMAIL, tokenVerified: true, householdId: bridgeApi.HOUSEHOLD_ID })).length, 1);

        await page.reload();
        await page.waitForFunction(() => document.querySelector('.app-layout').style.display === 'flex');
        await page.locator('.nav-item[data-tab="import"]').click();
        await page.waitForFunction(() => document.querySelectorAll('.review-select').length === 1);
        assert.deepEqual(await page.evaluate(() => ({ accepted: transactions.length, spending: getMonthCategorySpending('Restaurants', '2026-10') })), { accepted: 1, spending: 4.25 });
        const denied = await fetch(`${bridge.origin}/pending`, { headers: { Authorization: `Bearer ${await signIn(UNAPPROVED_EMAIL, UNAPPROVED_PASSWORD)}` } });
        assert.equal(denied.status, 401);
        assert.equal(providerCalls, 1, 'reload must not trigger another provider read in the same auth generation');
        assert.equal(pageErrors.length, 0, pageErrors.map(error => error.stack || error).join('\n'));
    console.log('PASS: local bridge bootstrap guard, synthetic Plaid adapter, Admin-authenticated HTTP approval, protected UID membership, Firestore pending/accepted reload, and failed commit retention.');
    } finally {
        await browser.close().catch(() => {});
        await bridge.close().catch(() => {});
    }
})().catch(error => { console.error(error); process.exitCode = 1; });

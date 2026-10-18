'use strict';

/*
 * User-approved, server-only Sandbox bridge check. The supervisor starts the
 * demo emulators with a non-secret environment and passes the two exact
 * Sandbox variables only to this child. This file must be run only by the
 * explicit verify-sandbox-e2e mode; it prints only bounded provider status
 * metadata and never prints raw diagnostics, rows, credentials, stacks, or
 * assertion details.
 */
const assert = require('node:assert/strict');
const { URL } = require('node:url');
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.BUDGET_TOOL_PLAYWRIGHT_BROWSERS_PATH || 'D:\\Documents\\Codex\\.assistant-storage\\playwright-browsers';
const sandbox = require('../plaid-sandbox.js');
const runner = require('../plaid-sandbox-runner.js');
const bridgeApi = require('../local-demo-bridge.js');

const SAFE_STAGES = new Set(['preflight', 'setup', 'sync', 'backend', 'browser', 'approval', 'reload', 'complete']);
const SAFE_SOURCE_PATTERN = /^tests\/(?:approved-sandbox-e2e|approved-sandbox-synthetic-e2e)\.cjs:\d{1,5}$/;
const SAFE_DIAGNOSTIC_TYPES = new Set([
    'API_ERROR', 'INSTITUTION_ERROR', 'ITEM_ERROR', 'INVALID_REQUEST', 'INVALID_INPUT',
    'RATE_LIMIT_EXCEEDED', 'SANDBOX_ERROR'
]);
const SAFE_DIAGNOSTIC_CODES = new Set([
    'ACCESS_NOT_GRANTED', 'BAD_REQUEST', 'INSTITUTION_DOWN', 'INSTITUTION_NOT_FOUND',
    'INSTITUTION_NOT_SUPPORTED', 'INTERNAL_SERVER_ERROR', 'INVALID_ACCESS_TOKEN',
    'INVALID_API_KEYS', 'INVALID_FIELD', 'INVALID_INPUT', 'INVALID_INSTITUTION',
    'INVALID_PRODUCT', 'INVALID_PUBLIC_TOKEN', 'ITEM_LOCKED', 'ITEM_LOGIN_REQUIRED',
    'ITEM_NOT_FOUND', 'MISSING_FIELDS', 'PRODUCT_NOT_READY', 'RATE_LIMIT_EXCEEDED',
    'SANDBOX_PRODUCT_NOT_ENABLED', 'UNAUTHORIZED_ENVIRONMENT', 'UNAUTHORIZED_ROUTE_ACCESS',
    'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION', 'INITIAL_SYNC_PENDING', 'SYNC_DEADLINE_EXCEEDED', 'ACCOUNT_NOT_MAPPED',
    'MISSING_REVIEWABLE_DATE', 'REMOVED_NOT_HYDRATED', 'UNSUPPORTED_CURRENCY',
    'INVALID_AMOUNT', 'MISSING_TRANSACTION_ID', 'INCOMPLETE_PAGE',
    'INCOMPLETE_SYNC_RESPONSE', 'PROVIDER_ERROR', 'INVALID_OBSERVATION',
    'MISSING_IDENTIFIER', 'INVALID_FIELD', 'INVALID_PENDING', 'INVALID_CATEGORY',
    'INVALID_FINANCE_CATEGORY', 'CURSOR_DID_NOT_ADVANCE', 'PAGE_LIMIT_EXCEEDED',
    'MUTATION_RESTART_LIMIT', 'SYNC_DID_NOT_COMPLETE', 'PROVIDER_REQUEST_FAILED',
    'ACCESS_TOKEN_RESOLVER_REQUIRED', 'INVALID_CUTOVER_DATE', 'ACCOUNT_MAPPING_REQUIRED',
    'BACKEND_REQUEST_FAILED', 'BACKEND_RESPONSE_INVALID_JSON', 'UNEXPECTED_LOCAL_FAILURE'
]);
const SAFE_RESPONSE_SHAPE_KEYS = ['added', 'modified', 'removed', 'has_more', 'next_cursor'];
const SAFE_RESPONSE_SHAPE_TYPES = new Set(['missing', 'array', 'boolean', 'string', 'null', 'number', 'object', 'undefined']);

function safeResponseShape(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const output = {};
    for (const key of SAFE_RESPONSE_SHAPE_KEYS) {
        const field = value[key];
        if (!field || typeof field !== 'object' || Array.isArray(field)) return null;
        if (typeof field.present !== 'boolean' || !SAFE_RESPONSE_SHAPE_TYPES.has(field.type)) return null;
        const safe = { present: field.present, type: field.type };
        if (field.count !== undefined) {
            if (!Number.isSafeInteger(field.count) || field.count < 0 || field.count > 1000) return null;
            safe.count = field.count;
        }
        output[key] = safe;
    }
    return output;
}

function safeUnexpectedSource(error, stage) {
    const collect = stack => [...String(stack || '').replaceAll('\\', '/').matchAll(/(?:^|[(/])((?:tests\/)?(?:approved-sandbox-e2e|approved-sandbox-synthetic-e2e)\.cjs):(\d+)(?::\d+)?/g)]
        .map(match => `${match[1].startsWith('tests/') ? match[1] : `tests/${match[1]}`}:${match[2]}`)
        .filter(source => SAFE_SOURCE_PATTERN.test(source));
    const errorSources = collect(error && error.stack);
    if (errorSources.length) return errorSources[0];
    // Primitive throws and browser protocol failures may not carry a useful
    // stack. Capture the current catch-site frame instead of line tables that
    // become false as the harness changes.
    const currentSources = collect(new Error().stack);
    return currentSources.at(-1) || `tests/approved-sandbox-e2e.cjs:${stage === 'preflight' ? 1 : 2}`;
}

function safeUnexpectedDiagnostic(error, stage) {
    return { stage: SAFE_STAGES.has(stage) ? stage : 'browser', code: 'UNEXPECTED_LOCAL_FAILURE', source: safeUnexpectedSource(error, stage) };
}

function safeSyncDiagnostic(error) {
    const diagnostic = sandbox.safeSyncDiagnostic(error) || sandbox.safeStaticSyncDiagnostic(error);
    if (!diagnostic) return null;
    const safe = { stage: 'sync' };
    if (Number.isInteger(diagnostic.status) && diagnostic.status >= 100 && diagnostic.status <= 599) safe.status = diagnostic.status;
    if (SAFE_DIAGNOSTIC_TYPES.has(diagnostic.type)) safe.type = diagnostic.type;
    if (SAFE_DIAGNOSTIC_CODES.has(diagnostic.code)) safe.code = diagnostic.code;
    if (typeof diagnostic.request_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(diagnostic.request_id)) safe.request_id = diagnostic.request_id;
    const responseShape = safeResponseShape(diagnostic.response_shape);
    if (responseShape) safe.response_shape = responseShape;
    if (!safe.code) safe.code = 'PROVIDER_REQUEST_FAILED';
    return safe;
}

function safeBackendDiagnostic(status, body) {
    const responseStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : null;
    const value = body && typeof body === 'object' && !Array.isArray(body) ? body.diagnostic : null;
    const stage = value && value.stage;
    const bodyStatus = value && Number.isInteger(value.status) && value.status >= 100 && value.status <= 599 ? value.status : null;
    const diagnosticStatus = bodyStatus !== null && (bodyStatus >= 400 || responseStatus !== null) ? bodyStatus : responseStatus;
    const diagnostic = {
        stage: stage === 'sync' || stage === 'backend' ? stage : 'backend',
        status: diagnosticStatus,
        code: value && SAFE_DIAGNOSTIC_CODES.has(value.code) ? value.code : 'BACKEND_REQUEST_FAILED'
    };
    if (!Number.isInteger(diagnostic.status) || diagnostic.status < 100 || diagnostic.status > 599) return null;
    if (diagnostic.status < 400 && responseStatus === null) return null;
    if (bodyStatus !== null && responseStatus !== null && bodyStatus !== responseStatus) diagnostic.http_status = responseStatus;
    if (value && SAFE_DIAGNOSTIC_TYPES.has(value.type)) diagnostic.type = value.type;
    if (value && typeof value.request_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.request_id)) diagnostic.request_id = value.request_id;
    if (value && typeof value.source === 'string' && SAFE_SOURCE_PATTERN.test(value.source)) diagnostic.source = value.source;
    const responseShape = safeResponseShape(value && value.response_shape);
    if (responseShape) diagnostic.response_shape = responseShape;
    return diagnostic;
}

function emit(stage, counts) {
    if (!SAFE_STAGES.has(stage)) stage = 'browser';
    const fields = [];
    if (counts && counts.countsUnknown === true) fields.push('counts=unknown');
    for (const key of ['setupCalls', 'rawObservations', 'skippedObservations', 'cutoffExcluded', 'resultingRecords', 'pending', 'accepted', 'persisted', 'recovery_attempts']) {
        if (counts && Number.isSafeInteger(counts[key]) && counts[key] >= 0) fields.push(`${key}=${counts[key]}`);
    }
    if (counts && typeof counts.recovery_exhausted === 'boolean') fields.push(`recovery_exhausted=${counts.recovery_exhausted}`);
    if (counts && Number.isInteger(counts.status) && counts.status >= 100 && counts.status <= 599) fields.push(`status=${counts.status}`);
    if (counts && SAFE_DIAGNOSTIC_TYPES.has(counts.type)) fields.push(`type=${counts.type}`);
    if (counts && SAFE_DIAGNOSTIC_CODES.has(counts.code)) fields.push(`code=${counts.code}`);
    if (counts && typeof counts.request_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(counts.request_id)) fields.push(`request_id=${counts.request_id}`);
    if (counts && Number.isInteger(counts.http_status) && counts.http_status >= 400 && counts.http_status <= 599) fields.push(`http_status=${counts.http_status}`);
    if (counts && typeof counts.source === 'string' && SAFE_SOURCE_PATTERN.test(counts.source)) fields.push(`source=${counts.source}`);
    const shape = safeResponseShape(counts && counts.response_shape);
    if (shape) {
        for (const key of SAFE_RESPONSE_SHAPE_KEYS) {
            const field = shape[key];
            fields.push(`shape_${key}_present=${field.present} shape_${key}_type=${field.type}`);
            if (Number.isSafeInteger(field.count)) fields.push(`shape_${key}_count=${field.count}`);
        }
    }
    const browserShape = safeResponseShape(counts && counts.browser_diagnostic_response_shape);
    if (browserShape) {
        for (const key of SAFE_RESPONSE_SHAPE_KEYS) {
            const field = browserShape[key];
            fields.push(`browser_shape_${key}_present=${field.present} browser_shape_${key}_type=${field.type}`);
            if (Number.isSafeInteger(field.count)) fields.push(`browser_shape_${key}_count=${field.count}`);
        }
    }
    console.log(`APPROVED_SANDBOX_E2E stage=${stage}${fields.length ? ` ${fields.join(' ')}` : ''}`);
}

function safeFailureStage(error) {
    const diagnostic = sandbox.safeSandboxDiagnostic(error);
    if (diagnostic) return diagnostic.stage;
    // Run the bounded sanitizer for its fixed classification boundary, but do
    // not print its text because this harness output is stage/count only.
    sandbox.sanitizeRunnerError(error);
    return error && SAFE_STAGES.has(error.__approvedStage)
        ? error.__approvedStage
        : 'browser';
}

function makeRetryingProvider(baseProvider, config, state, opts) {
    return {
        async fetchDelta(requestOptions) {
            state.syncStarted = true;
            state.stage = 'sync';
            state.lastSyncResult = undefined;
            state.syncDiagnostic = null;
            state.syncRecoveryAllowed = false;
            state.syncHttpFailure = null;
            state.syncDone = false;
            const waitBeforeRetry = async () => {
                // Only the provider's explicit PRODUCT_NOT_READY condition
                // receives this bounded same-Item readiness window. Setup is
                // never repeated and invalid/provider failures are not hidden.
                const delayMs = Number.isSafeInteger(state.retryDelayMs) && state.retryDelayMs >= 0 ? state.retryDelayMs : 5000;
                await new Promise(resolve => setTimeout(resolve, delayMs));
                return true;
            };
            try {
                state.lastSyncResult = await runner.runSandboxSync(baseProvider, config, {
                    maxReadyRetries: 6,
                    maxSyncRetries: 1,
                    maxEmptyRetries: 1,
                    retry: waitBeforeRetry,
                    syncRetry: waitBeforeRetry,
                    emptyRetry: waitBeforeRetry,
                    deadlineMs: Number.isSafeInteger(opts && opts.syncDeadlineMs) && opts.syncDeadlineMs > 0 ? opts.syncDeadlineMs : undefined,
                    providerOptions: {
                        existingSourceIdentities: requestOptions && requestOptions.existingSourceIdentities
                    },
                    output: { write() {} }
                });
                return state.lastSyncResult;
            } catch (error) {
                // The browser route intentionally returns a generic failure;
                // retain only branded, allowlisted provider metadata here.
                state.syncDiagnostic = safeSyncDiagnostic(error) || sandbox.safeStaticSyncDiagnostic(error) || safeUnexpectedDiagnostic(error, 'sync');
                state.syncRecoveryAllowed = sandbox.isTransientSyncFailure(error);
                throw error;
            } finally {
                state.syncDone = true;
            }
        }
    };
}

async function waitForApp(page) {
    await page.waitForFunction(() => document.querySelector('.app-layout') && document.querySelector('.app-layout').style.display === 'flex', null, { timeout: 30_000 });
}

async function waitForPending(page, timeoutMs, state) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (state && state.syncHttpFailure) return 0;
        const count = await page.locator('.review-select').count();
        if (count > 0) return count;
        if (state && state.syncDone) {
            // Provider completion precedes backend staging and browser
            // rendering. Do not race those steps on a successful result.
            if (state.syncDiagnostic || state.syncHttpFailure) return 0;
            if (state.lastSyncResult) {
                const summary = runner.summarizeSyncResult(state.lastSyncResult);
                if (summary.countsKnown && summary.resultingRecords === 0) return 0;
            }
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return 0;
}

async function runBrowserAttempt(options) {
    const { browser, bridge, context, state, opts, emitOutput, attempt } = options;
    const page = await browser.newPage();
    const pageErrors = [];
    let resolveSyncHttpResponse;
    state.syncHttpResponsePromise = new Promise(resolve => { resolveSyncHttpResponse = resolve; });
    page.on('pageerror', error => pageErrors.push(error));
    page.on('response', response => {
        try {
            const responseUrl = new URL(response.url());
            if (responseUrl.hostname === '127.0.0.1' && responseUrl.pathname === '/sync') {
                const fallback = safeBackendDiagnostic(response.status());
                if (fallback) state.syncHttpFailure = fallback;
                if (response.status() >= 400 || response.status() === 200) {
                    void response.json().then(body => {
                        const diagnostic = safeBackendDiagnostic(response.status(), body);
                        if (diagnostic) state.syncHttpFailure = diagnostic;
                    }).catch(() => {
                        // Keep malformed bridge responses diagnosable without
                        // retaining the body or exposing parser/provider text.
                        state.syncHttpFailure = {
                            stage: 'backend',
                            status: response.status(),
                            code: 'BACKEND_RESPONSE_INVALID_JSON'
                        };
                    }).finally(() => resolveSyncHttpResponse());
                } else {
                    resolveSyncHttpResponse();
                }
            }
        } catch (_) { /* Ignore malformed browser URLs without exposing them. */ }
    });
    page.on('requestfailed', request => {
        try {
            if (new URL(request.url()).pathname === '/sync') resolveSyncHttpResponse();
        } catch (_) { /* Ignore malformed browser URLs without exposing them. */ }
    });
    try {
        await page.route('**/*', async route => {
            const requestUrl = new URL(route.request().url());
            if (requestUrl.hostname === '127.0.0.1') return route.continue();
            return route.abort('blockedbyclient');
        });
        if (typeof opts.pageHook === 'function') await opts.pageHook(page, state, bridge, attempt);
        await page.goto(bridge.url);
        await waitForApp(page);
        await page.locator('.nav-item[data-tab="import"]').click();
        const pending = await waitForPending(page, 90_000, state);
        await Promise.race([
            state.syncHttpResponsePromise,
            new Promise(resolve => setTimeout(resolve, 5_000))
        ]);
        try {
            if (opts.captureBrowserDiagnostic === true) {
                await page.waitForFunction(() => typeof lastPersistenceError !== 'undefined' && lastPersistenceError && lastPersistenceError.diagnostic, null, { timeout: 5_000 }).catch(() => {});
            }
            const browserDiagnostic = await page.evaluate(() => {
                try {
                    const error = typeof lastPersistenceError !== 'undefined' ? lastPersistenceError : null;
                    const value = (error && error.diagnostic) || window.__BUDGET_TOOL_LOCAL_LAST_DIAGNOSTIC__;
                    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
                    const safe = { stage: value.stage, status: value.status, type: value.type, code: value.code, request_id: value.request_id, response_shape: value.response_shape };
                    return safe;
                } catch (_) { return null; }
            });
            if (browserDiagnostic && (browserDiagnostic.stage === 'backend' || browserDiagnostic.stage === 'sync') && Number.isInteger(browserDiagnostic.status)
                && browserDiagnostic.status >= 100 && browserDiagnostic.status <= 599
                && SAFE_DIAGNOSTIC_CODES.has(browserDiagnostic.code)) {
                state.browserDiagnostic = { ...browserDiagnostic, response_shape: safeResponseShape(browserDiagnostic.response_shape) };
            }
        } catch (_) { /* Browser protocol failures are classified below. */ }
        const terminalFailure = state.syncDiagnostic || state.syncHttpFailure;
        const syncCounts = state.lastSyncResult
            ? runner.summarizeSyncResult(state.lastSyncResult)
            : { countsUnknown: true, ...(terminalFailure || { stage: 'sync' }) };
        const acceptedBefore = await page.evaluate(() => Array.isArray(transactions) ? transactions.length : -1);
        const totalBefore = await page.evaluate(() => transactions.reduce((sum, row) => sum + Number(row && row.amount), 0));
        state.pendingBefore = pending;
        state.acceptedBefore = acceptedBefore;
        assert.equal(acceptedBefore, 0);
        assert.equal(totalBefore, 0);
        if (pending < 1) throw new Error('No review candidate was staged.');
        emitOutput(terminalFailure ? terminalFailure.stage : 'sync', { ...syncCounts, ...(terminalFailure || {}), pending, accepted: acceptedBefore });
        assert.equal(pageErrors.length, 0);

        state.stage = 'approval';
        page.on('dialog', async dialog => { await dialog.accept(); });
        const reviewChecks = page.locator('.review-select');
        for (let index = 0; index < pending; index += 1) await reviewChecks.nth(index).check();
        await page.waitForFunction(() => {
            const button = document.getElementById('addSelectedTransactions');
            return button && button.disabled === false;
        }, null, { timeout: 10_000 });
        await page.locator('#addSelectedTransactions').click();
        await page.waitForFunction(() => document.querySelectorAll('.review-select').length === 0, null, { timeout: 30_000 });
        const accepted = await page.evaluate(() => Array.isArray(transactions) ? transactions.length : -1);
        const totalAfter = await page.evaluate(() => transactions.reduce((sum, row) => sum + Number(row && row.amount), 0));
        if (!Number.isSafeInteger(accepted) || accepted < 1 || accepted !== pending) throw new Error('Approval did not produce the selected accepted state.');
        const persistedState = (await context.db.collection('shared').doc('data').get()).data() || {};
        const persisted = Array.isArray(persistedState.transactions) ? persistedState.transactions.length : -1;
        assert.equal(persisted, accepted);
        assert.equal(totalAfter, persistedState.transactions.reduce((sum, row) => sum + Number(row && row.amount), 0));
        emitOutput('approval', { pending, accepted, persisted });

        state.stage = 'reload';
        await page.reload();
        await waitForApp(page);
        await page.locator('.nav-item[data-tab="import"]').click();
        const pendingAfterReload = await waitForPending(page, 5_000);
        const acceptedAfterReload = await page.evaluate(() => Array.isArray(transactions) ? transactions.length : -1);
        const totalAfterReload = await page.evaluate(() => transactions.reduce((sum, row) => sum + Number(row && row.amount), 0));
        assert.equal(pendingAfterReload, 0);
        assert.equal(acceptedAfterReload, accepted);
        const reloadedState = (await context.db.collection('shared').doc('data').get()).data() || {};
        const persistedAfterReload = Array.isArray(reloadedState.transactions) ? reloadedState.transactions.length : -1;
        assert.equal(persistedAfterReload, accepted);
        assert.equal(totalAfterReload, reloadedState.transactions.reduce((sum, row) => sum + Number(row && row.amount), 0));
        emitOutput('reload', { pending: pendingAfterReload, accepted: acceptedAfterReload, persisted: persistedAfterReload });
        emitOutput('complete', { accepted: acceptedAfterReload, persisted: persistedAfterReload });
    } catch (error) {
        // A page/protocol failure can occur while the provider is still the
        // last recorded stage. Preserve provider/backend diagnostics, but
        // classify an otherwise unbranded browser failure for recovery and
        // bounded terminal output.
        if (!state.syncDiagnostic && !state.syncHttpFailure) state.stage = 'browser';
        throw error;
    } finally {
        await page.close().catch(() => {});
    }
}

async function main(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const emitOutput = typeof opts.emit === 'function' ? opts.emit : emit;
    const { chromium } = require('playwright');
    let context;
    let bridge;
    let browser;
    const state = {
        syncStarted: false, syncDone: false, syncHttpFailure: null, syncRecoveryAllowed: false,
        browserDiagnostic: null, stage: 'preflight', retryDelayMs: opts.retryDelayMs,
        recoveryAttempts: 0, recoveryExhausted: false
    };
    try {
        // This performs project/loopback, SDK, Admin, and fresh-data checks
        // before the helper reads either Sandbox variable.
        const prepareLocalDemo = typeof opts.prepareLocalDemo === 'function' ? opts.prepareLocalDemo : bridgeApi.prepareLocalDemo;
        context = await prepareLocalDemo({ localDepsDir: process.env.BUDGET_TOOL_LOCAL_DEPS });
        browser = typeof opts.launchBrowser === 'function' ? await opts.launchBrowser() : await chromium.launch({ headless: true });
        emitOutput('preflight');

        state.stage = 'setup';
        const config = typeof opts.createSetup === 'function' ? await opts.createSetup() : await runner.createUnattendedSandboxSetup();
        emitOutput('setup', { setupCalls: 1 });
        const baseProvider = typeof opts.createProvider === 'function' ? await opts.createProvider(config) : sandbox.createSandboxProvider({ config, maxRetries: 0 });
        const provider = makeRetryingProvider(baseProvider, config, state, opts);
        state.stage = 'browser';
        const createBridge = typeof opts.createBridge === 'function' ? opts.createBridge : bridgeApi.createLocalDemoBridge;
        bridge = await createBridge({
            context,
            mode: 'real',
            provider,
            accessToken: config.accessToken,
            connectionKey: config.connectionKey,
            localDepsDir: process.env.BUDGET_TOOL_LOCAL_DEPS,
            port: 0
        });

        const recoverOnFailure = opts.recoverOnFailure === undefined ? true : opts.recoverOnFailure === true;
        const maxRecoveryAttempts = Number.isSafeInteger(opts.recoveryAttempts) && opts.recoveryAttempts >= 0 ? opts.recoveryAttempts : (recoverOnFailure ? 1 : 0);
        let attempt = 0;
        while (true) {
            try {
                await runBrowserAttempt({ browser, bridge, context, state, opts, emitOutput, attempt });
                break;
            } catch (error) {
                const transientHttp = state.syncHttpFailure && state.syncHttpFailure.stage === 'backend'
                    && Number.isInteger(state.syncHttpFailure.status)
                    && (state.syncHttpFailure.status === 408 || state.syncHttpFailure.status === 425
                        || state.syncHttpFailure.status === 429 || state.syncHttpFailure.status >= 500);
                const fatalSyncDiagnostic = Boolean(state.syncDiagnostic) && state.syncRecoveryAllowed !== true;
                const recoveryEligible = !fatalSyncDiagnostic
                    && (transientHttp || state.syncRecoveryAllowed === true || state.stage === 'browser');
                const recoverable = recoverOnFailure && attempt < maxRecoveryAttempts && recoveryEligible;
                if (!recoverable && recoverOnFailure && recoveryEligible && attempt >= maxRecoveryAttempts) state.recoveryExhausted = true;
                if (!recoverable) throw error;
                attempt += 1;
                state.recoveryAttempts = attempt;
                state.syncStarted = false;
                state.syncDone = false;
                state.syncHttpFailure = null;
                state.syncDiagnostic = null;
                state.syncRecoveryAllowed = false;
                state.lastSyncResult = undefined;
                state.stage = 'browser';
                if (typeof opts.recoveryDelay === 'function') await opts.recoveryDelay(attempt);
            }
        }
    } catch (error) {
        const stage = state.stage;
        const terminalFailure = state.syncDiagnostic || state.syncHttpFailure || sandbox.safeSandboxDiagnostic(error) || sandbox.safeStaticSyncDiagnostic(error);
        const failureStage = terminalFailure ? terminalFailure.stage : stage;
        const failure = terminalFailure || safeUnexpectedDiagnostic(error, failureStage);
        const counts = state.lastSyncResult
            ? runner.summarizeSyncResult(state.lastSyncResult)
            : { countsUnknown: true };
        const outputCounts = { ...counts, ...failure };
        outputCounts.recovery_attempts = state.recoveryAttempts;
        outputCounts.recovery_exhausted = state.recoveryExhausted;
        if (Number.isSafeInteger(state.pendingBefore) && state.pendingBefore >= 0) outputCounts.pending = state.pendingBefore;
        if (Number.isSafeInteger(state.acceptedBefore) && state.acceptedBefore >= 0) outputCounts.accepted = state.acceptedBefore;
        if (state.browserDiagnostic) {
            outputCounts.browser_diagnostic_status = state.browserDiagnostic.status;
            outputCounts.browser_diagnostic_type = state.browserDiagnostic.type;
            outputCounts.browser_diagnostic_code = state.browserDiagnostic.code;
            outputCounts.browser_diagnostic_request_id = state.browserDiagnostic.request_id;
            outputCounts.browser_diagnostic_response_shape = safeResponseShape(state.browserDiagnostic.response_shape);
        }
        const output = { stage: failure.stage, counts: outputCounts };
        if (error && (typeof error === 'object' || typeof error === 'function')) {
            emitOutput(output.stage, output.counts);
            Object.defineProperty(error, '__approvedOutput', {
                value: output, configurable: true
            });
            Object.defineProperty(error, '__approvedEmitted', { value: true, configurable: true });
        }
        if (error && (typeof error === 'object' || typeof error === 'function')) {
            Object.defineProperty(error, '__approvedStage', { value: stage, configurable: true });
            throw error;
        }
        const wrapped = new Error('Approved Sandbox E2E failed.');
        Object.defineProperty(wrapped, '__approvedStage', { value: stage, configurable: true });
        const wrappedOutput = { stage: failure.stage, counts: outputCounts };
        emitOutput(wrappedOutput.stage, wrappedOutput.counts);
        Object.defineProperty(wrapped, '__approvedOutput', {
            value: wrappedOutput,
            configurable: true
        });
        Object.defineProperty(wrapped, '__approvedEmitted', { value: true, configurable: true });
        throw wrapped;
    } finally {
        if (browser) await browser.close().catch(() => {});
        if (bridge) await bridge.close().catch(() => {});
        else if (context) await bridgeApi.closeLocalDemoContext(context).catch(() => {});
    }
}

if (require.main === module) {
    main().catch(error => {
        if (!error || error.__approvedEmitted !== true) {
            const output = error && error.__approvedOutput;
            emit(output ? output.stage : safeFailureStage(error), output && output.counts);
        }
        process.exitCode = 1;
    });
}

module.exports = { main, makeRetryingProvider, safeSyncDiagnostic, safeBackendDiagnostic, emit };

'use strict';

/*
 * Credential-free scenario driver for the exact approved harness. The
 * launcher starts only demo Auth/Firestore emulators. Every setup and sync
 * response is injected in memory; no Plaid environment variable is read.
 */
const assert = require('node:assert/strict');
const sandbox = require('../plaid-sandbox.js');
const bridgeApi = require('../local-demo-bridge.js');
const approved = require('./approved-sandbox-e2e.cjs');

const BASE_CONFIG = Object.freeze({
    enabled: true,
    clientId: 'synthetic-client-id',
    secret: 'synthetic-client-secret',
    accessToken: 'synthetic-access-token',
    connectionKey: bridgeApi.CONNECTION_KEY,
    accountMap: Object.freeze({ 'synthetic-checking': 'Checking Account' }),
    ignoredAccountIds: Object.freeze(['synthetic-card'])
});

function response(status, body) {
    return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

function makeFailureDb(db, diagnosticStatus = 500) {
    let failed = false;
    return {
        collection: name => db.collection(name),
        async runTransaction(callback) {
            // Let review reads and lease acquisition complete. Fail only after
            // the sync repository has staged a provider page, so this case
            // preserves provider counts while proving the durable page write
            // itself is atomic.
            return db.runTransaction(async transaction => {
                let pageWrite = false;
                const wrapped = {
                    get: (...args) => transaction.get(...args),
                    set: (reference, value, ...args) => {
                        const path = String(reference && (reference.path || reference._path && reference._path.segments && reference._path.segments.join('/')) || '');
                        if (!failed && path.startsWith('protectedSyncRuns/') && value && Array.isArray(value.records) && value.records.length > 0) pageWrite = true;
                        return transaction.set(reference, value, ...args);
                    },
                    delete: (...args) => transaction.delete(...args)
                };
                const result = await callback(wrapped);
                if (pageWrite && !failed) {
                    failed = true;
                    const error = new Error('Synthetic staging commit failed.');
                    Object.defineProperty(error, 'diagnostic', {
                        value: diagnosticStatus === 400 || diagnosticStatus === 200
                            ? { stage: 'sync', status: diagnosticStatus, type: 'INVALID_REQUEST', code: 'PRODUCT_NOT_READY', request_id: `synthetic-body-ready-${diagnosticStatus}` }
                            : { stage: 'backend', status: 500, type: 'API_ERROR', code: 'BACKEND_REQUEST_FAILED', request_id: 'synthetic-backend-body-500' },
                        configurable: true
                    });
                    throw error;
                }
                return result;
            });
        }
    };
}

function makeTrackingDb(db, telemetry) {
    return {
        collection: name => db.collection(name),
        async runTransaction(callback) {
            return db.runTransaction(async transaction => {
                const wrapped = {
                    get: (...args) => transaction.get(...args),
                    set: (reference, value, ...args) => {
                        const path = String(reference && (reference.path || reference._path && reference._path.segments && reference._path.segments.join('/')) || '');
                        if (path.startsWith('protectedSyncRuns/') && value && Array.isArray(value.records) && value.records.length > 0) {
                            telemetry.stagingSyncCalls.push(telemetry.syncCalls);
                        }
                        return transaction.set(reference, value, ...args);
                    },
                    update: (...args) => transaction.update(...args),
                    delete: (...args) => transaction.delete(...args)
                };
                return callback(wrapped);
            });
        }
    };
}

function setupTransportFor() {
    return {
        async createPublicToken() { return { publicToken: 'synthetic-public-token' }; },
        async exchangePublicToken() { return { accessToken: BASE_CONFIG.accessToken, itemId: 'synthetic-item-one' }; },
        async getAccounts() { return { accounts: [
            { account_id: 'synthetic-checking', name: 'Synthetic checking', type: 'depository', subtype: 'checking' },
            { account_id: 'synthetic-card', name: 'Synthetic card', type: 'credit', subtype: 'credit card' }
        ] }; }
    };
}

async function createSetup(scenario, setupCalls) {
    setupCalls.count += 1;
    if (scenario === 'primitive-local') throw 'synthetic primitive local failure';
    if (scenario === 'setup-http-400') {
        const transport = sandbox.createSandboxSetupTransport({
            allowNetwork: true,
            fetchImpl: async () => response(400, { error_type: 'INVALID_REQUEST', error_code: 'INVALID_FIELD', request_id: 'synthetic-setup-400', secret: 'hidden' })
        });
        await transport.createPublicToken({ clientId: BASE_CONFIG.clientId, secret: BASE_CONFIG.secret, institutionId: 'ins_109508' });
    }
    const setup = await sandbox.createSandboxSetup({
        allowNetwork: true,
        clientId: BASE_CONFIG.clientId,
        secret: BASE_CONFIG.secret,
        institutionId: 'ins_109508',
        overrideUsername: 'user_good',
        overridePassword: 'pass_good',
        transport: setupTransportFor()
    });
    return sandbox.createSandboxConfig({ ...BASE_CONFIG, accessToken: setup.accessToken });
}

function createProvider(scenario, config, telemetry) {
    if (scenario === 'unexpected-local') return { fetchDelta: async () => { throw new TypeError('synthetic local detail'); } };
    if (telemetry) telemetry.expectedToken = config.accessToken;
    let calls = 0;
    const transport = sandbox.createSandboxTransport({
        timeoutMs: scenario === 'body-timeout' ? 5 : 30_000,
        fetchImpl: async (_url, requestOptions) => {
            calls += 1;
            if (telemetry && requestOptions && typeof requestOptions.body === 'string') {
                try {
                    const request = JSON.parse(requestOptions.body);
                    telemetry.tokens.push(request.access_token);
                    telemetry.pageCursors.push(request.cursor);
                } catch (_) { /* bounded synthetic assertion */ }
            }
            telemetry.syncCalls = calls;
            if (scenario === 'provider-http-400') return response(400, { error_type: 'API_ERROR', error_code: 'INVALID_FIELD', request_id: 'synthetic-sync-400', access_token: 'hidden' });
            if (scenario === 'provider-contradictory-503') return response(503, { error_type: 'API_ERROR', error_code: 'INVALID_API_KEYS', request_id: 'synthetic-fatal-503' });
            if (scenario === 'provider-transient-recovery' && telemetry && telemetry.browserAttempts === 1) {
                return response(503, { error_type: 'API_ERROR', error_code: 'INTERNAL_SERVER_ERROR', request_id: 'synthetic-transient-503' });
            }
            if (scenario === 'provider-rate-limit-recovery' && telemetry && telemetry.browserAttempts === 1) {
                return response(429, { error_type: 'RATE_LIMIT_EXCEEDED', error_code: 'RATE_LIMIT_EXCEEDED', request_id: 'synthetic-rate-limit-429' });
            }
            if (scenario === 'provider-transient-exhausted') {
                return response(503, { error_type: 'API_ERROR', error_code: 'INTERNAL_SERVER_ERROR', request_id: 'synthetic-transient-exhausted' });
            }
            if (scenario === 'fetch-reject' || (scenario === 'fetch-reject-recovery' && telemetry && telemetry.browserAttempts === 1)) throw new Error('synthetic transport detail');
            if (scenario === 'invalid-json') return { ok: true, status: 200, async json() { throw new Error('synthetic body detail'); } };
            if (scenario === 'malformed-response-shape') return response(200, { added: [], modified: [], has_more: false, next_cursor: '', request_id: 'synthetic-shape-missing-removed' });
            if (scenario === 'body-timeout') return { ok: true, status: 200, json() { return new Promise(() => {}); } };
            if (scenario === 'ready-recovery' && calls === 1) return response(400, { error_type: 'INVALID_REQUEST', error_code: sandbox.TRANSACTIONS_PRODUCT_NOT_READY, request_id: 'synthetic-ready-400' });
            if (scenario === 'ready-exhausted-400' && calls <= 7) return response(400, { error_type: 'INVALID_REQUEST', error_code: sandbox.TRANSACTIONS_PRODUCT_NOT_READY, request_id: 'synthetic-ready-exhausted-400' });
            if (scenario === 'ready-exhausted-200' && calls <= 7) return response(200, { error_type: 'INVALID_REQUEST', error_code: sandbox.TRANSACTIONS_PRODUCT_NOT_READY, request_id: 'synthetic-ready-exhausted-200' });
            if (scenario === 'ready-outer-recovery' && telemetry && telemetry.browserAttempts === 1) return response(400, { error_type: 'INVALID_REQUEST', error_code: sandbox.TRANSACTIONS_PRODUCT_NOT_READY, request_id: 'synthetic-ready-outer-recovery' });
            if (scenario === 'ready-exhausted-default') return response(400, { error_type: 'INVALID_REQUEST', error_code: sandbox.TRANSACTIONS_PRODUCT_NOT_READY, request_id: 'synthetic-ready-default-exhausted' });
            if (scenario === 'initial-empty-recovery' && calls <= 3) return response(200, { added: [], modified: [], removed: [], has_more: false, next_cursor: '', request_id: 'synthetic-initial-empty-recovery' });
            if (scenario === 'initial-empty-exhausted' && calls <= 7) return response(200, { added: [], modified: [], removed: [], has_more: false, next_cursor: '', request_id: 'synthetic-initial-empty-exhausted' });
            if (scenario === 'initial-empty-recovery' && calls === 4) return response(200, {
                added: [{ transaction_id: 'synthetic-ready-page', date: '2026-10-10', amount: 3, account_id: 'synthetic-checking', currency_code: 'USD', name: 'Synthetic market', category: 'Groceries' }],
                modified: [], removed: [], has_more: true, next_cursor: 'synthetic-cursor-ready'
            });
            if (scenario === 'initial-empty-recovery' && calls === 5) return response(200, {
                added: [{ transaction_id: 'synthetic-final-page', date: '2026-10-11', amount: 4.25, account_id: 'synthetic-checking', currency_code: 'USD', name: 'Synthetic coffee', category: 'Restaurants' }],
                modified: [], removed: [], has_more: false, next_cursor: 'synthetic-cursor-final'
            });
            return response(200, {
                added: [{ transaction_id: 'synthetic-transaction', date: '2026-10-10', amount: 4.25, account_id: 'synthetic-checking', currency_code: 'USD', name: 'Synthetic coffee', category: 'Restaurants' }],
                modified: [], removed: [], has_more: false, next_cursor: `synthetic-cursor-${calls}`
            });
        }
    });
    return sandbox.createSandboxProvider({ config, transport, ...(scenario === 'provider-contradictory-503' ? {} : { maxRetries: 0 }) });
}

function expectedFailure(scenario) {
    return new Set(['setup-http-400', 'provider-http-400', 'provider-contradictory-503', 'provider-transient-exhausted', 'fetch-reject', 'invalid-json', 'malformed-response-shape', 'body-timeout', 'ready-exhausted-400', 'ready-exhausted-200', 'ready-exhausted-default', 'initial-empty-exhausted', 'backend-stage-failure', 'http-body-400', 'http-body-200', 'http-malformed-success', 'browser-disconnect', 'unexpected-local', 'primitive-local']).has(scenario);
}

function assertDiagnostic(scenario, terminal) {
    const counts = terminal.counts || {};
    if (scenario === 'setup-http-400' || scenario === 'provider-http-400') {
        assert.equal(counts.status, 400, `${scenario}: status must survive serialization`);
        assert.equal(counts.type, scenario === 'setup-http-400' ? 'INVALID_REQUEST' : 'API_ERROR');
        assert.equal(counts.code, 'INVALID_FIELD');
        assert.match(String(counts.request_id), /^synthetic-(?:setup|sync)-400$/);
    } else if (scenario === 'provider-contradictory-503') {
        assert.equal(terminal.stage, 'sync');
        assert.equal(counts.status, 503);
        assert.equal(counts.type, 'API_ERROR');
        assert.equal(counts.code, 'INVALID_API_KEYS');
        assert.equal(counts.request_id, 'synthetic-fatal-503');
        assert.equal(counts.recovery_attempts, 0);
        assert.equal(counts.recovery_exhausted, false);
    } else if (scenario === 'provider-transient-exhausted') {
        assert.equal(terminal.stage, 'sync');
        assert.equal(counts.status, 503);
        assert.equal(counts.type, 'API_ERROR');
        assert.equal(counts.code, 'INTERNAL_SERVER_ERROR');
        assert.equal(counts.request_id, 'synthetic-transient-exhausted');
        assert.equal(counts.recovery_attempts, 1);
        assert.equal(counts.recovery_exhausted, true);
    } else if (scenario === 'ready-exhausted-400') {
        assert.equal(counts.status, 400);
        assert.equal(counts.type, 'INVALID_REQUEST');
        assert.equal(counts.code, 'PRODUCT_NOT_READY');
        assert.equal(counts.request_id, 'synthetic-ready-exhausted-400');
    } else if (scenario === 'ready-exhausted-200') {
        assert.equal(counts.status, 200);
        assert.equal(counts.type, 'INVALID_REQUEST');
        assert.equal(counts.code, 'PRODUCT_NOT_READY');
        assert.equal(counts.request_id, 'synthetic-ready-exhausted-200');
    } else if (scenario === 'ready-exhausted-default') {
        assert.equal(terminal.stage, 'sync');
        assert.equal(counts.status, 400);
        assert.equal(counts.type, 'INVALID_REQUEST');
        assert.equal(counts.code, 'PRODUCT_NOT_READY');
        assert.equal(counts.request_id, 'synthetic-ready-default-exhausted');
        assert.equal(counts.recovery_attempts, 1);
        assert.equal(counts.recovery_exhausted, true);
    } else if (scenario === 'initial-empty-exhausted') {
        assert.equal(terminal.stage, 'sync');
        assert.equal(counts.code, 'INITIAL_SYNC_PENDING');
        assert.equal(counts.status, 200, 'local readiness should retain the actual HTTP status');
        assert.equal(counts.type, undefined, 'local readiness must not invent an API error type');
        assert.equal(counts.request_id, 'synthetic-initial-empty-exhausted');
        assert.equal(counts.pending, 0);
        assert.equal(counts.accepted, 0);
    } else if (scenario === 'backend-stage-failure') {
        assert.equal(terminal.stage, 'backend');
        assert.equal(counts.status, 500);
        assert.equal(counts.type, 'API_ERROR');
        assert.equal(counts.code, 'BACKEND_REQUEST_FAILED');
        assert.equal(counts.request_id, 'synthetic-backend-body-500');
        assert.equal(counts.resultingRecords, 1, 'backend failure retains provider counts');
    } else if (scenario === 'http-body-400' || scenario === 'http-body-200') {
        assert.equal(terminal.stage, 'sync');
        assert.equal(counts.status, scenario === 'http-body-400' ? 400 : 200);
        assert.equal(counts.http_status, 500);
        assert.equal(counts.type, 'INVALID_REQUEST');
        assert.equal(counts.code, 'PRODUCT_NOT_READY');
        assert.equal(counts.request_id, `synthetic-body-ready-${scenario === 'http-body-400' ? 400 : 200}`);
    } else if (scenario === 'http-malformed-success') {
        assert.equal(terminal.stage, 'backend');
        assert.equal(counts.status, 200);
        assert.equal(counts.accepted, 0);
        assert.equal(counts.code, 'BACKEND_RESPONSE_INVALID_JSON');
        assert.equal(counts.browser_diagnostic_status, 200);
        assert.equal(counts.browser_diagnostic_code, 'BACKEND_RESPONSE_INVALID_JSON');
    } else if (scenario === 'unexpected-local' || scenario === 'primitive-local' || scenario === 'browser-disconnect') {
        assert.equal(counts.code, 'UNEXPECTED_LOCAL_FAILURE');
        assert.match(String(counts.source), /^tests\/(?:approved-sandbox-e2e|approved-sandbox-synthetic-e2e)\.cjs:\d+$/);
    } else if (scenario === 'fetch-reject') {
        assert.equal(counts.code, 'PROVIDER_REQUEST_FAILED');
    } else if (scenario === 'invalid-json' || scenario === 'body-timeout') {
        assert.equal(counts.status, 200);
        assert.equal(counts.code, 'PROVIDER_REQUEST_FAILED');
    } else if (scenario === 'malformed-response-shape') {
        assert.equal(terminal.stage, 'sync');
        assert.equal(counts.status, 200);
        assert.equal(counts.code, 'INCOMPLETE_SYNC_RESPONSE');
        assert.equal(counts.request_id, 'synthetic-shape-missing-removed');
        assert.deepEqual(counts.response_shape, {
            added: { present: true, type: 'array', count: 0 },
            modified: { present: true, type: 'array', count: 0 },
            removed: { present: false, type: 'missing' },
            has_more: { present: true, type: 'boolean' },
            next_cursor: { present: true, type: 'string' }
        });
        assert.equal(counts.browser_diagnostic_status, 200);
        assert.equal(counts.browser_diagnostic_code, 'INCOMPLETE_SYNC_RESPONSE');
        assert.equal(counts.browser_diagnostic_request_id, 'synthetic-shape-missing-removed');
        assert.deepEqual(counts.browser_diagnostic_response_shape, counts.response_shape);
    }
}

async function runScenario(scenario) {
    const records = [];
    const setupCalls = { count: 0 };
    const telemetry = { tokens: [], pageCursors: [], expectedToken: null, browserAttempts: 0, syncCalls: 0, stagingSyncCalls: [] };
    const prepareLocalDemo = options => bridgeApi.prepareLocalDemo({ ...options, resetLocalDemo: true });
    let initialCursorCheckError = null;
    const createBridge = async options => {
        const bridgeOptions = { ...options };
        // A browser disconnect may happen after the server commits the sync;
        // disable only the synthetic cooldown so the replacement browser can
        // prove same-process token recovery through the real HTTP path.
        if (scenario === 'browser-disconnect-recovery') bridgeOptions.cooldownMs = 0;
        if (scenario === 'backend-stage-failure' || scenario === 'backend-stage-recovery' || scenario === 'http-body-400' || scenario === 'http-body-200') {
            const diagnosticStatus = scenario === 'http-body-400' ? 400 : scenario === 'http-body-200' ? 200 : 500;
            bridgeOptions.db = makeFailureDb(options.context.db, diagnosticStatus);
            bridgeOptions.errorDiagnostic = error => error && error.diagnostic || sandbox.safeSandboxDiagnostic(error);
        }
        if (scenario === 'initial-empty-recovery') bridgeOptions.db = makeTrackingDb(options.context.db, telemetry);
        const bridge = await bridgeApi.createLocalDemoBridge(bridgeOptions);
        if (scenario === 'initial-empty-exhausted') {
            const close = bridge.close;
            bridge.close = async () => {
                try {
                    const runs = await options.context.db.collection('protectedSyncRuns').get();
                    assert.equal(runs.size, 1, 'initial readiness exhaustion should retain only its failed lease record');
                    const run = runs.docs[0].data() || {};
                    assert.equal(run.complete, false, 'initial readiness exhaustion must not complete the sync run');
                    assert.deepEqual(run.records, [], 'initial readiness exhaustion must not stage records');
                    const connection = await options.context.db.collection('protectedConnections').doc(options.context.connectionKey).get();
                    if (connection.exists) assert.equal((connection.data() || {}).cursor, undefined, 'initial readiness exhaustion must not publish a cursor');
                } catch (error) {
                    initialCursorCheckError = error;
                }
                await close();
            };
        }
        if (scenario === 'initial-empty-recovery') {
            const close = bridge.close;
            bridge.close = async () => {
                try {
                    const data = (await options.context.db.collection('shared').doc('data').get()).data() || {};
                    telemetry.persistedRows = Array.isArray(data.transactions) ? data.transactions.map(row => ({
                        amount: row.amount,
                        description: row.description,
                        date: row.date
                    })) : [];
                } catch (_) {
                    telemetry.persistedRows = [];
                }
                await close();
            };
        }
        return bridge;
    };
    let resultError = null;
    const defaultRecoveryScenario = scenario === 'ready-exhausted-default' || scenario === 'ready-outer-recovery' || scenario === 'provider-contradictory-503';
    try {
        await approved.main({
            retryDelayMs: 0,
            prepareLocalDemo,
            createSetup: () => createSetup(scenario, setupCalls),
            createProvider: config => createProvider(scenario, config, telemetry),
            createBridge,
            ...(defaultRecoveryScenario ? {} : {
                recoveryAttempts: scenario === 'backend-stage-recovery' || scenario === 'browser-disconnect-recovery'
                    || scenario === 'provider-transient-recovery' || scenario === 'provider-rate-limit-recovery'
                    || scenario === 'fetch-reject-recovery' || scenario === 'provider-transient-exhausted' ? 1 : 0,
                recoverOnFailure: scenario === 'backend-stage-recovery' || scenario === 'browser-disconnect-recovery'
                    || scenario === 'provider-http-400' || scenario === 'provider-transient-recovery'
                    || scenario === 'provider-rate-limit-recovery' || scenario === 'fetch-reject-recovery' || scenario === 'provider-transient-exhausted'
            }),
            captureBrowserDiagnostic: scenario === 'http-malformed-success' || scenario === 'malformed-response-shape',
            pageHook: async (page, state, bridge, attempt) => {
                telemetry.browserAttempts = Math.max(telemetry.browserAttempts, attempt + 1);
                if (scenario === 'http-malformed-success') {
                    await page.route('**/sync', async route => route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json' }, body: '{' }));
                    return;
                }
                if (scenario !== 'browser-disconnect' && scenario !== 'browser-disconnect-recovery') return;
                if (scenario === 'browser-disconnect-recovery' && attempt > 0) return;
                page.on('response', response => {
                    try {
                        if (new URL(response.url()).pathname === '/sync') void page.close().catch(() => {});
                    } catch (_) { /* Keep synthetic browser failure output bounded. */ }
                });
            },
            emit: (stage, counts) => records.push({ stage, counts: counts ? { ...counts } : {} })
        });
    } catch (error) {
        resultError = error;
    }
    assert.equal(setupCalls.count, 1, `${scenario}: setup must run exactly once`);
    if (scenario === 'initial-empty-exhausted') assert.equal(initialCursorCheckError, null, `${scenario}: no sync cursor or run may be published`);
    if (scenario === 'backend-stage-recovery' || scenario === 'browser-disconnect-recovery' || scenario === 'provider-transient-recovery'
        || scenario === 'provider-rate-limit-recovery' || scenario === 'fetch-reject-recovery') {
        assert.equal(telemetry.browserAttempts, 2, `${scenario}: recovery must create exactly one replacement browser attempt`);
        assert.ok(telemetry.tokens.length >= 2, `${scenario}: recovery must retain the provider token across both sync requests`);
        assert.ok(telemetry.tokens.every(token => token === telemetry.expectedToken), `${scenario}: retries must retain the same in-memory token`);
    }
    if (scenario === 'provider-http-400' || scenario === 'provider-contradictory-503') assert.equal(telemetry.browserAttempts, 1, `${scenario}: fatal provider input failure must not trigger outer recovery`);
    if (scenario === 'provider-contradictory-503') assert.equal(telemetry.tokens.length, 1, `${scenario}: adapter defaults must not retry a fatal 5xx diagnostic`);
    if (scenario === 'ready-outer-recovery') {
        assert.equal(telemetry.browserAttempts, 2, `${scenario}: default outer recovery should create one replacement browser`);
        assert.equal(telemetry.tokens.length, 8, `${scenario}: first readiness window is seven calls before default recovery`);
        assert.ok(telemetry.tokens.every(token => token === telemetry.expectedToken), `${scenario}: default recovery must retain the same in-memory token`);
    }
    if (scenario === 'ready-exhausted-default') {
        assert.equal(telemetry.browserAttempts, 2, `${scenario}: default recovery is bounded to one replacement browser`);
        assert.equal(telemetry.tokens.length, 14, `${scenario}: readiness exhaustion is seven calls per browser attempt`);
        assert.ok(telemetry.tokens.every(token => token === telemetry.expectedToken), `${scenario}: readiness exhaustion must retain the same in-memory token`);
    }
    if (scenario === 'provider-transient-exhausted') {
        assert.equal(telemetry.browserAttempts, 2, `${scenario}: transient failure should use one bounded outer recovery`);
        assert.equal(telemetry.tokens.length, 4, `${scenario}: each browser attempt permits one bounded provider retry`);
        assert.ok(telemetry.tokens.every(token => token === telemetry.expectedToken), `${scenario}: transient recovery must retain the same in-memory token`);
    }
    if (scenario === 'initial-empty-recovery' || scenario === 'initial-empty-exhausted') {
        const expectedSyncCalls = scenario === 'initial-empty-recovery' ? 5 : 7;
        assert.equal(telemetry.tokens.length, expectedSyncCalls, `${scenario}: readiness retries must stay on the same Item`);
        assert.ok(telemetry.tokens.every(token => token === telemetry.expectedToken), `${scenario}: readiness retries must retain the same in-memory token`);
    }
    if (scenario === 'initial-empty-recovery') {
        assert.deepEqual(telemetry.pageCursors, ['', '', '', '', 'synthetic-cursor-ready'], `${scenario}: pagination must resume from the ready cursor`);
        assert.ok(telemetry.stagingSyncCalls.length > 0, `${scenario}: final page must stage a sync run`);
        assert.ok(telemetry.stagingSyncCalls.every(call => call === 5), `${scenario}: staging must wait for the final page`);
        assert.deepEqual(telemetry.persistedRows, [
            { amount: 3, description: 'Synthetic market', date: '2026-10-10' },
            { amount: 4.25, description: 'Synthetic coffee', date: '2026-10-11' }
        ], `${scenario}: approval/reload must preserve exactly the final paginated rows`);
    }
    if (expectedFailure(scenario)) {
        assert.ok(resultError, `${scenario}: expected a bounded failure`);
        assert.ok(records.length > 0, `${scenario}: expected a terminal record`);
        const terminal = records.at(-1);
        assert.ok(['setup', 'sync', 'backend', 'browser'].includes(terminal.stage), `${scenario}: terminal stage must be safe`);
        const terminalRecords = records.filter(record => record.counts && (
            record.counts.countsUnknown === true
            || Number.isSafeInteger(record.counts.pending)
            || typeof record.counts.code === 'string'
        ));
        assert.equal(terminalRecords.length, 1, `${scenario}: expected one terminal record`);
        assertDiagnostic(scenario, terminal);
    } else {
        assert.equal(resultError, null, `${scenario}: unexpected harness failure`);
        assert.equal(records.at(-1).stage, 'complete');
        assert.equal(records.filter(record => record.stage === 'setup').length, 1);
        if (scenario === 'initial-empty-recovery') {
            assert.equal(records.find(record => record.stage === 'sync').counts.pending, 2, `${scenario}: both final-page candidates must be staged`);
            assert.equal(records.at(-1).counts.accepted, 2, `${scenario}: both final-page candidates must be accepted`);
            assert.equal(records.at(-1).counts.persisted, 2, `${scenario}: both final-page candidates must persist`);
        }
    }
    const terminal = records.at(-1) || { stage: 'browser', counts: {} };
    const terminalCounts = terminal.counts || {};
    return {
        scenario,
        setupCalls: setupCalls.count,
        terminal: terminal.stage,
        status: Number.isInteger(terminalCounts.status) ? terminalCounts.status : undefined,
        http_status: Number.isInteger(terminalCounts.http_status) ? terminalCounts.http_status : undefined,
        type: typeof terminalCounts.type === 'string' ? terminalCounts.type : undefined,
        code: typeof terminalCounts.code === 'string' ? terminalCounts.code : undefined,
        request_id: typeof terminalCounts.request_id === 'string' ? terminalCounts.request_id : undefined,
        source: typeof terminalCounts.source === 'string' ? terminalCounts.source : undefined,
        countsUnknown: terminalCounts.countsUnknown === true,
        resultingRecords: Number.isSafeInteger(terminalCounts.resultingRecords) ? terminalCounts.resultingRecords : undefined,
        pending: Number.isSafeInteger(terminalCounts.pending) ? terminalCounts.pending : undefined,
        accepted: Number.isSafeInteger(terminalCounts.accepted) ? terminalCounts.accepted : undefined,
        recovery_attempts: Number.isSafeInteger(terminalCounts.recovery_attempts) ? terminalCounts.recovery_attempts : undefined,
        recovery_exhausted: typeof terminalCounts.recovery_exhausted === 'boolean' ? terminalCounts.recovery_exhausted : undefined,
        response_shape: terminalCounts.response_shape && typeof terminalCounts.response_shape === 'object' ? 'allowlisted' : undefined
    };
}

async function main() {
    const scenarios = [
        'ready-recovery', 'ready-outer-recovery', 'setup-http-400', 'provider-http-400', 'provider-contradictory-503', 'provider-transient-recovery', 'provider-rate-limit-recovery', 'fetch-reject-recovery', 'provider-transient-exhausted', 'fetch-reject',
        'invalid-json', 'malformed-response-shape', 'body-timeout', 'ready-exhausted-400', 'ready-exhausted-200', 'ready-exhausted-default',
            'initial-empty-recovery', 'initial-empty-exhausted',
            'unexpected-local', 'backend-stage-failure', 'backend-stage-recovery',
            'http-body-400', 'http-body-200', 'http-malformed-success',
        'browser-disconnect-recovery', 'primitive-local',
        'browser-disconnect'
    ];
    for (const scenario of scenarios) {
        try {
            const result = await runScenario(scenario);
            const fields = [`scenario=${result.scenario}`, `stage=${result.terminal}`, `setupCalls=${result.setupCalls}`];
            for (const key of ['status', 'http_status', 'type', 'code', 'request_id', 'source', 'resultingRecords', 'pending', 'accepted', 'recovery_attempts', 'recovery_exhausted', 'response_shape']) {
                if (result[key] !== undefined) fields.push(`${key}=${result[key]}`);
            }
            if (result.countsUnknown) fields.push('counts=unknown');
            console.log(`PASS: synthetic ${fields.join(' ')}`);
        } catch (_) {
            console.error(`FAIL: synthetic scenario=${scenario} code=SCENARIO_ASSERTION_FAILED`);
            throw _;
        }
    }
    console.log(`PASS: synthetic approved harness scenarios=${scenarios.length} setupCalls=1 each; no provider credentials or remote requests.`);
}

if (require.main === module) main().catch(() => { console.error('Synthetic approved harness verification failed.'); process.exitCode = 1; });

module.exports = { main, runScenario, createProvider, createSetup };

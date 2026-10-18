const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const sandbox = require('../plaid-sandbox.js');
const runner = require('../plaid-sandbox-runner.js');
const launcher = require('../local-demo-bridge-emulator-launcher.js');
const appConfig = require('../transaction-config.js');
const { ProtectedReviewBackend, PlaidTransactionsSyncAdapter } = require('../transaction-backend.js');

const base = {
    enabled: true,
    clientId: 'synthetic-client-id',
    secret: 'synthetic-secret',
    accessToken: 'synthetic-access-token',
    connectionKey: 'chase',
    accountMap: { 'acct-checking': 'Checking Account' }
};

async function readSyntheticSecret(chunks, outputText) {
    const input = new PassThrough();
    input.isTTY = true;
    input.setRawMode = () => input;
    const output = new Writable({ write(chunk, encoding, callback) { outputText.value += chunk.toString(); callback(); } });
    output.isTTY = true;
    const result = runner.askSecret('hidden: ', input, output);
    for (const chunk of chunks) input.write(chunk);
    return result;
}

;(async () => {
    const config = sandbox.createSandboxConfig(base);
    assert.equal(config.cutoverDate, '2026-10-09');
    assert.equal(config.baseUrl, sandbox.SANDBOX_ORIGIN);
    assert.deepEqual(config.accountMap, base.accountMap);
    assert.equal(JSON.stringify(config).includes('synthetic-secret'), false);
    assert.equal(Object.keys(config).includes('secret'), false);
    assert.equal(appConfig.legacyAccountAliases['0820'], 'Checking Account');

    const syntheticLauncherEnv = {
        Path: 'D:\\synthetic-bin',
        BUDGET_TOOL_LOCAL_DEPS: 'D:\\synthetic-deps',
        PLAID_CLIENT_ID: 'synthetic-launcher-client',
        PLAID_SANDBOX_SECRET: 'synthetic-launcher-secret'
    };
    Object.defineProperty(syntheticLauncherEnv, 'PLAID_PROD_SECRET', {
        configurable: true,
        get() { throw new Error('Production secret must never be read.'); }
    });
    const launcherEmulatorEnv = launcher.copyNonSecretEnvironment(syntheticLauncherEnv);
    const launcherRunnerEnv = launcher.copyRunnerEnvironment('create-item', false, true, syntheticLauncherEnv);
    assert.equal(launcherEmulatorEnv.PLAID_CLIENT_ID, undefined);
    assert.equal(launcherEmulatorEnv.PLAID_SANDBOX_SECRET, undefined);
    assert.equal(launcherRunnerEnv.PLAID_CLIENT_ID, syntheticLauncherEnv.PLAID_CLIENT_ID);
    assert.equal(launcherRunnerEnv.PLAID_SANDBOX_SECRET, syntheticLauncherEnv.PLAID_SANDBOX_SECRET);
    assert.deepEqual(launcher.parseArgs(['--mode', 'create-item', '--unattended']), { mode: 'create-item', reset: false, unattended: true });
    assert.throws(() => launcher.parseArgs(['--mode', 'mock', '--unattended']), /requires create-item/);
    assert.deepEqual(launcher.parseArgs(['--verify-mock-e2e']), { mode: 'verify-mock-e2e', reset: false, unattended: false });
    assert.deepEqual(launcher.parseArgs(['--verify-sandbox-e2e']), { mode: 'verify-sandbox-e2e', reset: false, unattended: false });
    assert.doesNotThrow(() => launcher.requireSandboxEnvironment({ mode: 'verify-sandbox-e2e', unattended: false }, { PLAID_CLIENT_ID: 'synthetic', PLAID_SANDBOX_SECRET: 'synthetic' }));
    assert.throws(() => launcher.requireSandboxEnvironment({ mode: 'verify-sandbox-e2e', unattended: false }, {}), /requires PLAID_CLIENT_ID and PLAID_SANDBOX_SECRET/);

    let unattendedSetupCalls = 0;
    const unattendedEnvironment = new Proxy({
        PLAID_CLIENT_ID: 'synthetic-unattended-client',
        PLAID_SANDBOX_SECRET: 'synthetic-unattended-secret'
    }, {
        get(target, name) {
            if (name === 'PLAID_PROD_SECRET' || name === 'PLAID_SANDBOX_CONNECTION_KEY') throw new Error('Disallowed environment value was read.');
            return target[name];
        },
        ownKeys() { throw new Error('Unattended setup must not enumerate environment values.'); }
    });
    const unattendedConfig = await runner.createUnattendedSandboxSetup({
        env: unattendedEnvironment,
        createSandboxSetup: async request => {
            unattendedSetupCalls += 1;
            assert.equal(request.allowNetwork, true);
            assert.equal(request.clientId, 'synthetic-unattended-client');
            assert.equal(request.secret, 'synthetic-unattended-secret');
            assert.equal(request.institutionId, 'ins_109508');
            assert.equal(request.overrideUsername, 'user_good');
            assert.equal(request.overridePassword, 'pass_good');
            return {
                accessToken: 'synthetic-unattended-access-token',
                accounts: [
                    { account_id: 'synthetic-unattended-checking', type: 'depository', subtype: 'checking' },
                    { account_id: 'synthetic-unattended-card', type: 'credit', subtype: 'credit card' }
                ]
            };
        }
    });
    assert.equal(unattendedSetupCalls, 1);
    assert.equal(unattendedConfig.connectionKey, 'sandbox-test');
    assert.deepEqual(unattendedConfig.accountMap, { 'synthetic-unattended-checking': 'Checking Account' });
    assert.deepEqual(unattendedConfig.ignoredAccountIds, ['synthetic-unattended-card']);
    assert.doesNotMatch(JSON.stringify(unattendedConfig), /synthetic-unattended-(?:secret|access-token)/);
    await assert.rejects(() => runner.createUnattendedSandboxSetup({
        env: unattendedEnvironment,
        createSandboxSetup: async () => ({ accessToken: 'synthetic', accounts: [] })
    }), /exactly one depository checking account/);

    const firstSecretOutput = { value: '' };
    assert.equal(await readSyntheticSecret(['\u001b[200~synthetic-client\u001b[201~\r\n'], firstSecretOutput), 'synthetic-client');
    const splitSecretOutput = { value: '' };
    assert.equal(await readSyntheticSecret(['\u001b[2', '00~synthetic-', 'secret\u001b[201', '~\r'], splitSecretOutput), 'synthetic-secret');
    const arrowSecretOutput = { value: '' };
    await assert.rejects(() => readSyntheticSecret(['synthetic\u001b[', 'A\r'], arrowSecretOutput), error => error.message === 'Sandbox secret input contains unsupported terminal controls.');
    assert.doesNotMatch(arrowSecretOutput.value, /synthetic/);
    const multilinePasteOutput = { value: '' };
    await assert.rejects(() => readSyntheticSecret(['\u001b[200~line-one\r\nline-two\u001b[201~\r'], multilinePasteOutput), error => error.message === 'Sandbox secret input contains unsupported terminal controls.');

    let setupTransportCalls = 0;
    await assert.rejects(() => sandbox.createSandboxSetup({
        clientId: base.clientId,
        secret: base.secret,
        institutionId: 'ins_109508',
        transport: {
            async createPublicToken() { setupTransportCalls += 1; },
            async exchangePublicToken() { setupTransportCalls += 1; },
            async getAccounts() { setupTransportCalls += 1; }
        }
    }), /explicit opt-in/);
    assert.equal(setupTransportCalls, 0);
    assert.throws(() => sandbox.createSandboxSetupTransport({ fetchImpl: async () => ({}) }), /explicit opt-in/);

    const setupCalls = [];
    const setup = await sandbox.createSandboxSetup({
        allowNetwork: true,
        clientId: base.clientId,
        secret: base.secret,
        institutionId: 'ins_109508',
        overrideUsername: 'user_good',
        overridePassword: 'pass_good',
        transport: {
            async createPublicToken(request) { setupCalls.push(['create', request]); return { publicToken: 'public-synthetic' }; },
            async exchangePublicToken(request) { setupCalls.push(['exchange', request]); return { accessToken: 'access-synthetic', itemId: 'item-synthetic' }; },
            async getAccounts(request) {
                setupCalls.push(['accounts', request]);
                return { accounts: [
                    { account_id: 'acct-checking', name: 'Plaid Checking', type: 'depository', subtype: 'checking' },
                    { account_id: 'acct-card', name: 'Plaid Card', type: 'credit', subtype: 'credit card' }
                ] };
            }
        }
    });
    assert.equal(setup.accessToken, 'access-synthetic');
    assert.equal(JSON.stringify(setup).includes('access-synthetic'), false);
    assert.equal(Object.prototype.propertyIsEnumerable.call(setup.accounts[0], 'account_id'), false);
    assert.deepEqual(setupCalls.map(call => call[0]), ['create', 'exchange', 'accounts']);
    assert.deepEqual(setupCalls[0][1], {
        clientId: base.clientId, secret: base.secret, institutionId: 'ins_109508',
        overrideUsername: 'user_good', overridePassword: 'pass_good'
    });
    assert.deepEqual(setupCalls[1][1], { clientId: base.clientId, secret: base.secret, publicToken: 'public-synthetic' });
    assert.deepEqual(setupCalls[2][1], { clientId: base.clientId, secret: base.secret, accessToken: 'access-synthetic' });
    for (const stage of ['create-public-token', 'exchange-public-token', 'accounts-get']) {
        const stageCalls = [];
        const throwingTransport = {
            async createPublicToken() {
                stageCalls.push('create-public-token');
                if (stage === 'create-public-token') throw new Error('credential response must not escape');
                return { publicToken: 'public-synthetic' };
            },
            async exchangePublicToken() {
                stageCalls.push('exchange-public-token');
                if (stage === 'exchange-public-token') throw new Error('token response must not escape');
                return { accessToken: 'access-synthetic' };
            },
            async getAccounts() {
                stageCalls.push('accounts-get');
                if (stage === 'accounts-get') throw new Error('account response must not escape');
                return { accounts: [{ account_id: 'acct-stage', name: 'Synthetic' }] };
            }
        };
        await assert.rejects(() => sandbox.createSandboxSetup({ allowNetwork: true, clientId: base.clientId, secret: base.secret, institutionId: 'ins_109508', transport: throwingTransport }), error => {
            const safe = sandbox.sanitizeRunnerError(error);
            assert.equal(safe, `Sandbox setup failed at ${stage}.`);
            assert.doesNotMatch(safe, /credential|token response|account response|acct-stage/);
            assert.deepEqual(stageCalls, stage === 'create-public-token' ? ['create-public-token'] : stage === 'exchange-public-token' ? ['create-public-token', 'exchange-public-token'] : ['create-public-token', 'exchange-public-token', 'accounts-get']);
            return true;
        });
    }
    const setupConfig = sandbox.createSandboxConfig({
        ...base,
        accessToken: setup.accessToken,
        accountMap: { [setup.accounts[0].account_id]: 'Checking Account' }
    });
    assert.equal(setupConfig.accessToken, 'access-synthetic');
    assert.deepEqual(runner.parseAccountLabels('["Checking Account","skip"]', setup.accounts), { 'acct-checking': 'Checking Account' });
    assert.throws(() => runner.parseAccountLabels('["Checking Account"]', setup.accounts), /match the numbered accounts/);

    const promptSetupOutput = new Writable({
        write(chunk, encoding, callback) { promptSetupOutput.text += chunk.toString(); callback(); }
    });
    promptSetupOutput.text = '';
    let promptedSetupCalls = 0;
    const promptSecrets = [base.clientId, base.secret, ''];
    const promptLines = ['', '', 'x', '2', 'skip', '', 'chase'];
    const promptedSetupConfig = await runner.promptSandboxSetup({
        output: promptSetupOutput,
        askSecret: async () => promptSecrets.shift(),
        askLine: async () => promptLines.shift(),
        createSandboxSetup: async () => {
            promptedSetupCalls += 1;
            return { accessToken: 'setup-access-secret', accounts: setup.accounts };
        }
    });
    assert.equal(promptedSetupCalls, 1);
    assert.deepEqual(promptedSetupConfig.accountMap, { 'acct-checking': appConfig.accountDisplayNames[1] });
    assert.deepEqual(promptedSetupConfig.ignoredAccountIds, ['acct-card']);
    assert.equal(promptedSetupConfig.connectionKey, 'chase');
    assert.match(promptSetupOutput.text, new RegExp(`1\\. ${appConfig.accountDisplayNames[0]}`));
    assert.match(promptSetupOutput.text, new RegExp(`2\\. ${appConfig.accountDisplayNames[1]}`));
    assert.match(promptSetupOutput.text, /Invalid choice/);
    assert.doesNotMatch(promptSetupOutput.text, /acct-checking|setup-access-secret|synthetic-secret/);

    let retrySecretCalls = 0;
    let retrySetupCalls = 0;
    const retrySetupEvents = [];
    const retrySetupOutput = new Writable({ write(chunk, encoding, callback) { retrySetupOutput.text += chunk.toString(); callback(); } });
    retrySetupOutput.text = '';
    const retrySetupConfig = await runner.promptSandboxSetup({
        output: retrySetupOutput,
        askSecret: async () => {
            retrySecretCalls += 1;
            if (retrySecretCalls === 1) {
                const error = new Error('Sandbox secret input contains unsupported terminal controls.');
                error.code = 'SANDBOX_SECRET_INPUT_INVALID';
                throw error;
            }
            retrySetupEvents.push('secret');
            return 'synthetic-hidden';
        },
        askLine: async () => '1',
        createSandboxSetup: async () => {
            retrySetupEvents.push('setup');
            retrySetupCalls += 1;
            return { accessToken: 'retry-hidden', accounts: [setup.accounts[0]] };
        }
    });
    assert.equal(retrySetupCalls, 1);
    assert.equal(retrySetupEvents.at(-1), 'setup');
    assert.equal(retrySetupEvents.filter(event => event === 'secret').length, 3);
    assert.match(retrySetupOutput.text, /unsupported terminal controls/);
    assert.deepEqual(retrySetupConfig.accountMap, { 'acct-checking': appConfig.accountDisplayNames[0] });

    let allSkippedSetupCalls = 0;
    const remapLines = ['', '', 'skip', '1', '', 'chase'];
    const remapConfig = await runner.promptSandboxSetup({
        output: new Writable({ write(chunk, encoding, callback) { callback(); } }),
        askSecret: async () => 'synthetic-hidden',
        askLine: async () => remapLines.shift(),
        createSandboxSetup: async () => {
            allSkippedSetupCalls += 1;
            return { accessToken: 'setup-hidden', accounts: [setup.accounts[0]] };
        }
    });
    assert.equal(allSkippedSetupCalls, 1);
    assert.deepEqual(remapConfig.accountMap, { 'acct-checking': appConfig.accountDisplayNames[0] });
    assert.deepEqual(remapConfig.ignoredAccountIds, []);
    assert.equal(remapConfig.connectionKey, 'chase');
    const setupHttpRequests = [];
    const setupHttpTransport = sandbox.createSandboxSetupTransport({
        allowNetwork: true,
        fetchImpl: async (url, options) => {
            setupHttpRequests.push({ url, options });
            if (url === sandbox.SANDBOX_PUBLIC_TOKEN_URL) return { ok: true, status: 200, async json() { return { public_token: 'public-http' }; } };
            if (url === sandbox.ITEM_EXCHANGE_URL) return { ok: true, status: 200, async json() { return { access_token: 'access-http', item_id: 'item-http' }; } };
            return { ok: true, status: 200, async json() { return { accounts: [{ account_id: 'acct-http', name: 'Synthetic account', type: 'depository' }] }; } };
        }
    });
    const httpPublic = await setupHttpTransport.createPublicToken({ clientId: base.clientId, secret: base.secret, institutionId: 'ins_109508' });
    const httpExchange = await setupHttpTransport.exchangePublicToken({ clientId: base.clientId, secret: base.secret, publicToken: httpPublic.publicToken });
    const httpAccounts = await setupHttpTransport.getAccounts({ clientId: base.clientId, secret: base.secret, accessToken: httpExchange.accessToken });
    assert.deepEqual(setupHttpRequests.map(request => request.url), [sandbox.SANDBOX_PUBLIC_TOKEN_URL, sandbox.ITEM_EXCHANGE_URL, sandbox.ACCOUNTS_GET_URL]);
    assert.deepEqual(JSON.parse(setupHttpRequests[0].options.body), {
        client_id: base.clientId, secret: base.secret, institution_id: 'ins_109508', initial_products: ['transactions'],
        options: { override_username: 'user_good', override_password: 'pass_good' }
    });
    assert.equal(httpAccounts.accounts[0].account_id, 'acct-http');
    assert.equal(JSON.stringify(httpAccounts).includes('acct-http'), false);

    const diagnosticCases = [
        ['create-public-token', sandbox.SANDBOX_PUBLIC_TOKEN_URL, 'createPublicToken', { error_type: 'API_ERROR', error_code: 'INVALID_API_KEYS', request_id: 'req-create-1', error_message: 'secret-must-not-escape' }],
        ['exchange-public-token', sandbox.ITEM_EXCHANGE_URL, 'exchangePublicToken', { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED', request_id: 'req-exchange-1', display_message: 'access-token-must-not-escape' }],
        ['accounts-get', sandbox.ACCOUNTS_GET_URL, 'getAccounts', { error_type: 'API_ERROR', error_code: 'SANDBOX_PRODUCT_NOT_ENABLED', request_id: 'req-accounts-1', access_token: 'synthetic-access-token' }]
    ];
    for (const [stage, expectedUrl, method, body] of diagnosticCases) {
        const diagnosticTransport = sandbox.createSandboxSetupTransport({
            allowNetwork: true,
            fetchImpl: async url => {
                assert.equal(url, expectedUrl);
                return { ok: false, status: 403, async json() { return body; } };
            }
        });
        const call = method === 'createPublicToken'
            ? diagnosticTransport.createPublicToken({ clientId: base.clientId, secret: base.secret, institutionId: 'ins_109508' })
            : method === 'exchangePublicToken'
                ? diagnosticTransport.exchangePublicToken({ clientId: base.clientId, secret: base.secret, publicToken: 'public-synthetic' })
                : diagnosticTransport.getAccounts({ clientId: base.clientId, secret: base.secret, accessToken: base.accessToken });
        await assert.rejects(call, error => {
            const safe = sandbox.sanitizeRunnerError(error);
            assert.match(safe, new RegExp(`Sandbox setup failed at ${stage}\\.`));
            assert.match(safe, /HTTP 403/);
            assert.doesNotMatch(safe, /secret-must-not-escape|access-token-must-not-escape|synthetic-access-token/);
            assert.match(safe, /request_id=req-(?:create|exchange|accounts)-1/);
            const setupDiagnostic = sandbox.safeSandboxDiagnostic(error);
            assert.equal(setupDiagnostic.stage, 'setup');
            assert.equal(setupDiagnostic.status, 403);
            assert.equal(setupDiagnostic.request_id, body.request_id);
            return true;
        });
    }
    const unsupportedDiagnosticTransport = sandbox.createSandboxSetupTransport({
        allowNetwork: true,
        fetchImpl: async () => ({ ok: false, status: 502, async json() {
            return { error_type: 'UNTRUSTED_TYPE', error_code: 'UNTRUSTED_CODE', request_id: 'synthetic-secret' };
        } })
    });
    await assert.rejects(() => unsupportedDiagnosticTransport.createPublicToken({ clientId: base.clientId, secret: base.secret, institutionId: 'ins_109508' }), error => {
        const safe = sandbox.sanitizeRunnerError(error);
        assert.equal(safe, 'Sandbox setup failed at create-public-token. HTTP 502.');
        return true;
    });
    const responseSecretIdTransport = sandbox.createSandboxSetupTransport({
        allowNetwork: true,
        fetchImpl: async () => ({ ok: false, status: 401, async json() {
            return { error_type: 'API_ERROR', error_code: 'INVALID_API_KEYS', request_id: 'response-access-token', access_token: 'response-access-token' };
        } })
    });
    await assert.rejects(() => responseSecretIdTransport.createPublicToken({ clientId: base.clientId, secret: base.secret, institutionId: 'ins_109508' }), error => {
        const safe = sandbox.sanitizeRunnerError(error);
        assert.equal(safe, 'Sandbox setup failed at create-public-token. HTTP 401. type=API_ERROR. code=INVALID_API_KEYS.');
        assert.doesNotMatch(safe, /response-access-token/);
        return true;
    });
    const malformedSetupTransport = sandbox.createSandboxSetupTransport({
        allowNetwork: true,
        fetchImpl: async () => ({ ok: true, status: 200, async json() { throw new Error('raw response secret'); } })
    });
    await assert.rejects(() => malformedSetupTransport.createPublicToken({ clientId: base.clientId, secret: base.secret, institutionId: 'ins_109508' }), error => {
        const safe = sandbox.sanitizeRunnerError(error);
        assert.equal(safe, 'Sandbox setup failed at create-public-token. HTTP 200.');
        assert.doesNotMatch(safe, /raw response secret/);
        return true;
    });
    const timeoutSetupTransport = sandbox.createSandboxSetupTransport({
        allowNetwork: true,
        timeoutMs: 5,
        fetchImpl: async () => new Promise(() => {})
    });
    await assert.rejects(() => timeoutSetupTransport.createPublicToken({ clientId: base.clientId, secret: base.secret, institutionId: 'ins_109508' }), error => {
        assert.equal(sandbox.sanitizeRunnerError(error), 'Sandbox setup failed at create-public-token.');
        return true;
    });
    let defaultSetupFetchCalls = 0;
    const defaultSetup = await sandbox.createSandboxSetup({
        allowNetwork: true,
        clientId: base.clientId,
        secret: base.secret,
        institutionId: 'ins_109508',
        fetchImpl: async (url) => {
            defaultSetupFetchCalls += 1;
            if (url === sandbox.SANDBOX_PUBLIC_TOKEN_URL) return { ok: true, async json() { return { public_token: 'public-default' }; } };
            if (url === sandbox.ITEM_EXCHANGE_URL) return { ok: true, async json() { return { access_token: 'access-default' }; } };
            if (url === sandbox.ACCOUNTS_GET_URL) return { ok: true, async json() { return { accounts: [{ account_id: 'acct-default', name: 'Default account' }] }; } };
            throw new Error('unexpected setup URL');
        }
    });
    assert.equal(defaultSetupFetchCalls, 3);
    assert.equal(defaultSetup.accessToken, 'access-default');

    const promptInput = new PassThrough();
    promptInput.isTTY = true;
    promptInput.setRawMode = () => promptInput;
    const promptValues = [
        base.clientId,
        base.secret,
        base.accessToken,
        base.connectionKey,
        JSON.stringify(base.accountMap),
        '',
        ''
    ];
    const promptOutput = new Writable({
        write(chunk, encoding, callback) {
            const prompt = chunk.toString();
            if (promptValues.length && /: $/.test(prompt)) process.nextTick(() => promptInput.write(`${promptValues.shift()}\n`));
            callback();
        }
    });
    promptOutput.isTTY = true;
    const promptedConfig = await runner.promptSandboxConfig({ input: promptInput, output: promptOutput });
    assert.equal(promptedConfig.clientId, base.clientId);
    assert.equal(promptedConfig.secret, base.secret);
    assert.equal(promptedConfig.accessToken, base.accessToken);
    assert.deepEqual(promptedConfig.accountMap, base.accountMap);
    assert.equal(promptedConfig.cutoverDate, appConfig.FIRST_SYNC_CUTOVER_DATE);

    const transportCalls = [];
    const provider = sandbox.createSandboxProvider({
        config,
        transport: {
            async sync(request) {
                transportCalls.push(request);
                return {
                    added: [{ transaction_id: 'sandbox-1', date: '2026-10-16', amount: 12, account_id: 'acct-checking', currency_code: 'USD', name: 'Synthetic purchase', access_token: 'response-secret' }],
                    modified: [], removed: [], has_more: false, next_cursor: 'synthetic-next', access_token: 'response-secret'
                };
            }
        }
    });
    const delta = await provider.fetchDelta({ accessToken: config.accessToken, cursor: '', connectionKey: config.connectionKey, cutoverDate: config.cutoverDate });
    assert.equal(delta.pages[0].records.length, 1);
    assert.equal(delta.pages[0].records[0].description, 'Synthetic purchase');
    assert.deepEqual(delta.counts, { rawObservations: 1, skippedObservations: 0, cutoffExcluded: 0, resultingRecords: 1 });
    assert.equal(JSON.stringify(delta).includes('response-secret'), false);
    assert.deepEqual(transportCalls, [{ clientId: base.clientId, secret: base.secret, accessToken: base.accessToken, cursor: '' }]);

    const mixedConfig = sandbox.createSandboxConfig({ ...base, accountMap: { 'acct-checking': 'Checking Account' }, ignoredAccountIds: ['acct-card'] });
    const mixedProvider = sandbox.createSandboxProvider({
        config: mixedConfig,
        transport: { async sync() { return {
            added: [
                { transaction_id: 'mapped', date: '2026-10-16', amount: 3, account_id: 'acct-checking', currency_code: 'USD', name: 'Mapped' },
                { transaction_id: 'skipped', date: '2026-10-16', amount: 4, account_id: 'acct-card', currency_code: 'USD', name: 'Skipped' }
            ], modified: [], removed: [], has_more: false, next_cursor: 'mixed-next'
        }; } }
    });
    const mixedDelta = await mixedProvider.fetchDelta({ accessToken: mixedConfig.accessToken, cursor: '', connectionKey: mixedConfig.connectionKey, cutoverDate: mixedConfig.cutoverDate });
    assert.deepEqual(mixedDelta.pages[0].records.map(record => record.description), ['Mapped']);
    assert.deepEqual(mixedDelta.counts, { rawObservations: 2, skippedObservations: 1, cutoffExcluded: 0, resultingRecords: 1 });
    const unknownProvider = sandbox.createSandboxProvider({
        config: mixedConfig,
        transport: { async sync() { return {
            added: [{ transaction_id: 'unknown', date: '2026-10-16', amount: 5, account_id: 'acct-unknown', currency_code: 'USD', name: 'Unknown' }],
            modified: [], removed: [], has_more: false, next_cursor: 'unknown-next'
        }; } }
    });
    await assert.rejects(() => unknownProvider.fetchDelta({ accessToken: mixedConfig.accessToken, cursor: '', connectionKey: mixedConfig.connectionKey, cutoverDate: mixedConfig.cutoverDate }), /account is not mapped/);

    const rawEmptyProvider = sandbox.createSandboxProvider({
        config,
        transport: { async sync() { return { added: [], modified: [], removed: [], has_more: false, next_cursor: 'raw-empty' }; } }
    });
    const rawEmptyDelta = await rawEmptyProvider.fetchDelta({ accessToken: config.accessToken, cursor: '', connectionKey: config.connectionKey, cutoverDate: config.cutoverDate });
    assert.deepEqual(rawEmptyDelta.counts, { rawObservations: 0, skippedObservations: 0, cutoffExcluded: 0, resultingRecords: 0 });
    assert.equal(runner.summarizeSyncResult(rawEmptyDelta).rawObservations, 0);

    const cutoffOnlyProvider = sandbox.createSandboxProvider({
        config,
        transport: { async sync() { return {
            added: [{ transaction_id: 'old', date: '2026-10-08', amount: 2, account_id: 'acct-checking', currency_code: 'USD', name: 'Before cutoff' }],
            modified: [], removed: [], has_more: false, next_cursor: 'cutoff-only'
        }; } }
    });
    const cutoffOnlyDelta = await cutoffOnlyProvider.fetchDelta({ accessToken: config.accessToken, cursor: '', connectionKey: config.connectionKey, cutoverDate: config.cutoverDate });
    assert.deepEqual(cutoffOnlyDelta.counts, { rawObservations: 1, skippedObservations: 0, cutoffExcluded: 1, resultingRecords: 0 });
    assert.equal(runner.summarizeSyncResult(cutoffOnlyDelta).rawObservations, 1);

    let multiPageCalls = 0;
    const multiPageProvider = sandbox.createSandboxProvider({
        config,
        transport: { async sync(request) {
            multiPageCalls += 1;
            if (!request.cursor) return {
                added: [{ transaction_id: 'page-one', date: '2026-10-16', amount: 2, account_id: 'acct-checking', currency_code: 'USD', name: 'Page one' }],
                modified: [], removed: [], has_more: true, next_cursor: 'page-one-cursor'
            };
            return {
                added: [], modified: [{ transaction_id: 'page-two', date: '2026-10-16', amount: 3, account_id: 'acct-checking', currency_code: 'USD', name: 'Page two' }],
                removed: [], has_more: false, next_cursor: 'page-two-cursor'
            };
        } }
    });
    const multiPageDelta = await multiPageProvider.fetchDelta({ accessToken: config.accessToken, cursor: '', connectionKey: config.connectionKey, cutoverDate: config.cutoverDate });
    assert.equal(multiPageCalls, 2);
    assert.deepEqual(multiPageDelta.counts, { rawObservations: 2, skippedObservations: 0, cutoffExcluded: 0, resultingRecords: 2 });

    let emptyRetryCalls = 0;
    const emptyRetryRequests = [];
    const emptyThenSelectedProvider = {
        async fetchDelta(request) {
            emptyRetryCalls += 1;
            emptyRetryRequests.push({ cursor: request.cursor, connectionKey: request.connectionKey, accessToken: request.accessToken });
            if (emptyRetryCalls === 1) return { pages: [], cursor: 'same-cursor', counts: { rawObservations: 0, skippedObservations: 0, cutoffExcluded: 0, resultingRecords: 0 } };
            return { pages: [{ records: [{ description: 'synthetic-selected' }] }], cursor: 'same-cursor', counts: { rawObservations: 1, skippedObservations: 0, cutoffExcluded: 0, resultingRecords: 1 } };
        }
    };
    const retriedEmpty = await runner.runSandboxSync(emptyThenSelectedProvider, config, {
        maxEmptyRetries: 1,
        emptyRetry: async (attempt, counts) => { assert.equal(attempt, 1); assert.deepEqual(counts, { rawObservations: 0, skippedObservations: 0, cutoffExcluded: 0, resultingRecords: 0 }); return true; }
    });
    assert.equal(emptyRetryCalls, 2, 'empty retry must use the existing provider/Item only');
    assert.equal(retriedEmpty.counts.resultingRecords, 1);
    assert.deepEqual(emptyRetryRequests[0], emptyRetryRequests[1]);

    let declinedEmptyCalls = 0;
    const declinedEmpty = await runner.runSandboxSync({
        async fetchDelta() { declinedEmptyCalls += 1; return { pages: [], cursor: 'declined', counts: { rawObservations: 0, skippedObservations: 0, cutoffExcluded: 0, resultingRecords: 0 } }; }
    }, config, { maxEmptyRetries: 1, emptyRetry: async () => false });
    assert.equal(declinedEmptyCalls, 1);
    assert.equal(runner.summarizeSyncResult(declinedEmpty).rawObservations, 0);
    const inconsistentSummary = runner.summarizeSyncResult({
        pages: [],
        counts: { rawObservations: 1, skippedObservations: 0, cutoffExcluded: 0, resultingRecords: 1 }
    });
    assert.equal(inconsistentSummary.resultingRecords, 0, 'page records remain authoritative over supplied metadata');
    assert.equal(inconsistentSummary.countsKnown, false, 'inconsistent provider metadata must be treated as unknown');
    const badAccountingSummary = runner.summarizeSyncResult({
        pages: [{ records: [{}] }],
        counts: { rawObservations: 1, skippedObservations: 1, cutoffExcluded: 0, resultingRecords: 1 }
    });
    assert.equal(badAccountingSummary.resultingRecords, 1);
    assert.equal(badAccountingSummary.countsKnown, false, 'bad count accounting must not claim a selected result');

    let request;
    const httpTransport = sandbox.createSandboxTransport({
        fetchImpl: async (url, options) => {
            request = { url, options };
            return { ok: true, status: 200, async json() { return { added: [], modified: [], removed: [], has_more: false, next_cursor: 'next', access_token: 'not-returned' }; } };
        }
    });
    const response = await httpTransport.sync({ clientId: base.clientId, secret: base.secret, accessToken: base.accessToken, cursor: 'cursor-1' });
    assert.deepEqual(response, { added: [], modified: [], removed: [], has_more: false, next_cursor: 'next' });
    assert.equal(request.url, sandbox.SANDBOX_SYNC_URL);
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.redirect, 'error');
    assert.deepEqual(JSON.parse(request.options.body), { client_id: base.clientId, secret: base.secret, access_token: base.accessToken, cursor: 'cursor-1' });
    const nullableTransport = sandbox.createSandboxTransport({ fetchImpl: async () => ({ ok: true, status: 200, async json() { return {
        added: [{ transaction_id: 'nullable-fields', date: '2026-10-16', amount: 1, account_id: 'acct-checking', currency_code: 'USD', name: 'Nullable fields',
            merchant_name: null, authorized_date: null, pending_transaction_id: null, iso_currency_code: null,
            transaction_code: null, category: null, personal_finance_category: null
        }], modified: [], removed: [], has_more: false, next_cursor: 'nullable-next'
    }; } }) });
    const nullableResponse = await nullableTransport.sync(base);
    assert.equal(nullableResponse.added.length, 1);
    for (const key of ['merchant_name', 'authorized_date', 'pending_transaction_id', 'iso_currency_code', 'transaction_code', 'category', 'personal_finance_category']) {
        assert.equal(Object.prototype.hasOwnProperty.call(nullableResponse.added[0], key), false, `null ${key} should be omitted`);
    }
    const redactingTransport = sandbox.createSandboxTransport({ fetchImpl: async () => ({ ok: true, status: 200, async json() { return {
        added: [{ transaction_id: 'safe-id', date: '2026-10-16', amount: 1, account_id: 'acct-checking', currency_code: 'USD', name: 'Safe', access_token: 'response-secret', client_id: 'response-client', secret: 'response-secret'
    }], modified: [], removed: [], has_more: false, next_cursor: 'safe-next', access_token: 'response-secret' }; } }) });
    const redactedResponse = await redactingTransport.sync(base);
    assert.equal(JSON.stringify(redactedResponse).includes('response-secret'), false);
    assert.equal(JSON.stringify(redactedResponse).includes('response-client'), false);
    assert.throws(() => sandbox.createSandboxTransport({ baseUrl: 'https://api.plaid.com', fetchImpl: async () => ({}) }), /exactly https:\/\/sandbox\.plaid\.com/);
    await assert.rejects(() => sandbox.createSandboxTransport({ fetchImpl: async () => { throw new Error('synthetic-secret should not escape'); } }).sync(base), /request failed/);
    for (const malformed of [
        {},
        { added: [{ transaction_id: 'nonempty-empty-cursor' }], modified: [], removed: [], has_more: false, next_cursor: '' },
        { added: [], modified: [], removed: [], has_more: true, next_cursor: '' },
        { added: [], modified: [], removed: [], has_more: false },
        { added: {}, modified: [], removed: [], has_more: false, next_cursor: 'cursor' },
        { added: [], modified: [], removed: [], has_more: 'false', next_cursor: 'cursor' }
    ]) {
        const malformedTransport = sandbox.createSandboxTransport({ fetchImpl: async () => ({ ok: true, status: 200, async json() { return malformed; } }) });
        await assert.rejects(() => malformedTransport.sync(base), /incomplete Transactions Sync response/);
    }
    const initialPendingTransport = sandbox.createSandboxTransport({ fetchImpl: async () => ({ ok: true, status: 200, async json() {
        return { added: [], modified: [], removed: [], has_more: false, next_cursor: '', request_id: 'req-initial-empty' };
    } }) });
    await assert.rejects(() => initialPendingTransport.sync({ ...base, cursor: '' }), error => {
        assert.equal(error.code, sandbox.INITIAL_SYNC_PENDING);
        assert.deepEqual(sandbox.safeSyncDiagnostic(error), { stage: 'sync', status: 200, code: 'INITIAL_SYNC_PENDING', request_id: 'req-initial-empty' });
        return true;
    });
    await assert.rejects(() => initialPendingTransport.sync({ ...base, cursor: 'prior-cursor' }), /incomplete Transactions Sync response/);
    const secretRequestInitialTransport = sandbox.createSandboxTransport({ fetchImpl: async () => ({ ok: true, status: 200, async json() {
        return { added: [], modified: [], removed: [], has_more: false, next_cursor: '', request_id: base.accessToken };
    } }) });
    await assert.rejects(() => secretRequestInitialTransport.sync({ ...base, cursor: '' }), error => {
        assert.deepEqual(sandbox.safeSyncDiagnostic(error), { stage: 'sync', status: 200, code: 'INITIAL_SYNC_PENDING' });
        return true;
    });
    const directInitialPending = new PlaidTransactionsSyncAdapter({
        accountMap: base.accountMap,
        client: { async sync() { return { added: [], modified: [], removed: [], has_more: false, next_cursor: '' }; } }
    });
    await assert.rejects(() => directInitialPending.fetchDelta({ accessToken: base.accessToken, cursor: '', connectionKey: base.connectionKey }), error => {
        assert.equal(error.code, sandbox.INITIAL_SYNC_PENDING);
        return true;
    });
    for (const amount of [null, '12', NaN, Infinity]) {
        const invalidAmountTransport = sandbox.createSandboxTransport({ fetchImpl: async () => ({ ok: true, status: 200, async json() { return {
            added: [{ transaction_id: 'invalid-amount', date: '2026-10-16', amount, account_id: 'acct-checking', currency_code: 'USD', name: 'Invalid amount' }],
            modified: [], removed: [], has_more: false, next_cursor: 'invalid-amount-next'
        }; } }) });
        await assert.rejects(() => invalidAmountTransport.sync(base), /transaction amount is invalid/);
    }
    let mutationCalls = 0;
    const mutationTransport = sandbox.createSandboxTransport({ fetchImpl: async () => {
        mutationCalls += 1;
        if (mutationCalls === 1) return { ok: false, status: 400, async json() { return { error_code: sandbox.TRANSACTIONS_SYNC_MUTATION, secret: 'must-not-escape' }; } };
        return { ok: true, status: 200, async json() { return { added: [], modified: [], removed: [], has_more: false, next_cursor: 'after-mutation' }; } };
    } });
    const mutationProvider = sandbox.createSandboxProvider({ config, transport: mutationTransport, maxMutationRestarts: 1 });
    const mutationResult = await mutationProvider.fetchDelta({ accessToken: config.accessToken, cursor: '', connectionKey: config.connectionKey, cutoverDate: config.cutoverDate });
    assert.equal(mutationCalls, 2);
    assert.equal(mutationResult.cursor, 'after-mutation');
    assert.deepEqual(mutationResult.counts, { rawObservations: 0, skippedObservations: 0, cutoffExcluded: 0, resultingRecords: 0 }, 'mutation restart must discard counts from the abandoned pagination attempt');
    const failedTransport = sandbox.createSandboxTransport({ fetchImpl: async () => ({ ok: false, status: 400, async json() { return { error_code: 'BAD_REQUEST', secret: 'must-not-escape' }; } }) });
    await assert.rejects(() => failedTransport.sync(base), error => error.message === 'Plaid Sandbox request failed.' && !error.message.includes('must-not-escape'));
    let syncDiagnosticCalls = 0;
    const syncDiagnosticProvider = sandbox.createSandboxProvider({
        config,
        maxRetries: 3,
        transport: sandbox.createSandboxTransport({ fetchImpl: async () => {
            syncDiagnosticCalls += 1;
            return { ok: false, status: 400, async json() { return { error_type: 'INVALID_REQUEST', error_code: 'INVALID_FIELD', request_id: 'req-sync-1', error_message: 'must-not-escape' }; } };
        } })
    });
    await assert.rejects(() => syncDiagnosticProvider.fetchDelta({ accessToken: config.accessToken, cursor: '', connectionKey: config.connectionKey, cutoverDate: config.cutoverDate }), error => {
        assert.equal(syncDiagnosticCalls, 1);
        const safe = sandbox.sanitizeRunnerError(error);
        assert.equal(safe, 'Sandbox Transactions Sync failed at transactions-sync. HTTP 400. type=INVALID_REQUEST. code=INVALID_FIELD. request_id=req-sync-1.');
        assert.doesNotMatch(safe, /must-not-escape/);
        assert.deepEqual(sandbox.safeSyncDiagnostic(error), {
            stage: 'sync', status: 400, type: 'INVALID_REQUEST', code: 'INVALID_FIELD', request_id: 'req-sync-1'
        });
        return true;
    });
    let exhaustedReadyCalls = 0;
    const exhaustedReadyProvider = sandbox.createSandboxProvider({
        config,
        maxRetries: 0,
        transport: sandbox.createSandboxTransport({ fetchImpl: async () => {
            exhaustedReadyCalls += 1;
            return { ok: true, status: 200, async json() {
                return { error_type: 'INVALID_REQUEST', error_code: sandbox.TRANSACTIONS_PRODUCT_NOT_READY, request_id: 'req-ready-200' };
            } };
        } })
    });
    await assert.rejects(() => exhaustedReadyProvider.fetchDelta({ accessToken: config.accessToken, cursor: '', connectionKey: config.connectionKey, cutoverDate: config.cutoverDate }), error => {
        assert.equal(exhaustedReadyCalls, 1);
        assert.deepEqual(sandbox.safeSyncDiagnostic(error), {
            stage: 'sync', status: 200, type: 'INVALID_REQUEST', code: 'PRODUCT_NOT_READY', request_id: 'req-ready-200'
        });
        return true;
    });
    const untrustedSyncDiagnostic = new Error('provider body contains synthetic-secret');
    assert.equal(sandbox.safeSyncDiagnostic(untrustedSyncDiagnostic), null, 'unbranded provider failures must not become diagnostics');
    assert.deepEqual(sandbox.safeStaticSyncDiagnostic(new Error('Plaid transaction account is not mapped.')), {
        stage: 'sync', code: 'ACCOUNT_NOT_MAPPED'
    });
    assert.equal(sandbox.safeStaticSyncDiagnostic(new Error('Plaid transaction account is not mapped. leaked-secret')), null, 'hostile static error text must not become a cause code');
    assert.deepEqual(sandbox.safeStaticSyncDiagnostic(new Error('Provider transaction is missing a reviewable date.')), {
        stage: 'sync', code: 'MISSING_REVIEWABLE_DATE'
    });
    for (const [message, code] of [
        ['Plaid Sandbox transaction contains an invalid category.', 'INVALID_CATEGORY'],
        ['Plaid Sandbox transaction contains an invalid finance category.', 'INVALID_FINANCE_CATEGORY'],
        ['Plaid Sandbox transaction contains an invalid pending flag.', 'INVALID_PENDING'],
        ['Plaid sync returned an incomplete page.', 'INCOMPLETE_PAGE']
    ]) {
        assert.deepEqual(sandbox.safeStaticSyncDiagnostic(new Error(message)), { stage: 'sync', code });
    }
    const successfulSyncCounts = runner.summarizeSyncResult({
        pages: [{ records: [{ id: 'provider-record' }] }],
        counts: { rawObservations: 1, skippedObservations: 0, cutoffExcluded: 0, resultingRecords: 1 }
    });
    const backendFailure = { stage: 'backend', status: 500, code: 'BACKEND_REQUEST_FAILED' };
    const retainedFailureOutput = { ...successfulSyncCounts, ...backendFailure };
    assert.equal(retainedFailureOutput.resultingRecords, 1, 'backend failure output must retain successful provider counts');
    assert.deepEqual({ stage: retainedFailureOutput.stage, status: retainedFailureOutput.status, code: retainedFailureOutput.code }, backendFailure);
    const syncNetworkProvider = sandbox.createSandboxProvider({
        config,
        maxRetries: 1,
        transport: sandbox.createSandboxTransport({ timeoutMs: 5, fetchImpl: async () => { throw new Error('network credential must not escape'); } })
    });
    await assert.rejects(() => syncNetworkProvider.fetchDelta({ accessToken: config.accessToken, cursor: '', connectionKey: config.connectionKey, cutoverDate: config.cutoverDate }), error => {
        assert.equal(sandbox.sanitizeRunnerError(error), 'Sandbox Transactions Sync failed at transactions-sync.');
        return true;
    });
    let sameItemSyncCalls = 0;
    let syncOutput = '';
    const sameItemRetryTransport = sandbox.createSandboxTransport({ fetchImpl: async () => {
        sameItemSyncCalls += 1;
        if (sameItemSyncCalls === 1) return { ok: false, status: 503, async json() { return { error_type: 'API_ERROR', error_code: 'INTERNAL_SERVER_ERROR', request_id: 'req-same-item' }; } };
        return { ok: true, status: 200, async json() { return { added: [], modified: [], removed: [], has_more: false, next_cursor: 'same-item-next' }; } };
    } });
    const sameItemRetryProvider = sandbox.createSandboxProvider({ config, transport: sameItemRetryTransport, maxRetries: 0 });
    const sameItemRetryResult = await runner.runSandboxSync(sameItemRetryProvider, config, {
        maxSyncRetries: 1,
        maxEmptyRetries: 0,
        syncRetry: async () => true,
        output: { write(value) { syncOutput += value; } }
    });
    assert.equal(sameItemSyncCalls, 2, 'sync retry must reuse the same Item without a new setup call');
    assert.equal(sameItemRetryResult.cursor, 'same-item-next');
    assert.match(syncOutput, /Transactions Sync failed at transactions-sync\. HTTP 503\./);
    assert.doesNotMatch(syncOutput, /access_token|secret|response|error_message/i);
    for (const body of [
        { error_type: 'API_ERROR', error_code: 'INVALID_API_KEYS', request_id: 'req-fatal-status' },
        { error_type: 'INVALID_REQUEST', error_code: 'INVALID_FIELD', request_id: 'req-fatal-type' }
    ]) {
        const contradictoryTransport = sandbox.createSandboxTransport({ fetchImpl: async () => ({ ok: false, status: 503, async json() { return body; } }) });
        await assert.rejects(() => contradictoryTransport.sync(base), error => {
            assert.equal(sandbox.isTransientSyncFailure(error), false, 'auth/input diagnostics stay fatal even with a 5xx status');
            return true;
        });
    }
    const notReadyTransport = sandbox.createSandboxTransport({ fetchImpl: async () => ({ ok: false, status: 400, async json() { return { error_type: 'INVALID_REQUEST', error_code: sandbox.TRANSACTIONS_PRODUCT_NOT_READY, request_id: 'ready-123', secret: 'must-not-escape' }; } }) });
    await assert.rejects(() => notReadyTransport.sync(base), error => {
        assert.equal(error.message, 'Sandbox Transactions data is not ready; retry the sync.');
        assert.deepEqual(sandbox.safeSyncDiagnostic(error), { stage: 'sync', status: 400, type: 'INVALID_REQUEST', code: 'PRODUCT_NOT_READY', request_id: 'ready-123' });
        return true;
    });
    const notReadyProvider = sandbox.createSandboxProvider({ config, transport: { async sync() { return { error_code: sandbox.TRANSACTIONS_PRODUCT_NOT_READY }; } }, maxRetries: 0 });
    await assert.rejects(() => notReadyProvider.fetchDelta({ accessToken: config.accessToken, cursor: '', connectionKey: config.connectionKey, cutoverDate: config.cutoverDate }), error => error.message === 'Plaid sync data is not ready; retry the sync.');
    let readyRetryCalls = 0;
    const readyRetryProvider = { fetchDelta: async () => {
        readyRetryCalls += 1;
        if (readyRetryCalls === 1) {
            const error = new Error('Plaid sync data is not ready; retry the sync.');
            error.code = sandbox.TRANSACTIONS_PRODUCT_NOT_READY;
            throw error;
        }
        return { pages: [{ records: [] }], cursor: 'ready-cursor' };
    } };
    const readyRetryResult = await runner.runSandboxSync(readyRetryProvider, config, { maxReadyRetries: 1, maxEmptyRetries: 0, retry: async () => true });
    assert.equal(readyRetryCalls, 2);
    assert.equal(readyRetryResult.cursor, 'ready-cursor');
    let deadlineCalls = 0;
    let deadlineRequest;
    await assert.rejects(() => runner.runSandboxSync({
        fetchDelta: async request => {
            deadlineCalls += 1;
            deadlineRequest = request;
            await new Promise(resolve => setTimeout(resolve, 50));
            return { pages: [{ records: [] }], cursor: 'late-cursor' };
        }
    }, config, { deadlineMs: 10, maxEmptyRetries: 0 }), error => error && error.code === sandbox.SYNC_DEADLINE_EXCEEDED);
    assert.equal(deadlineCalls, 1, 'sync deadline must prevent a second provider call');
    assert.ok(Number.isSafeInteger(deadlineRequest.deadlineAt), 'provider receives a fixed deadline');
    const stalledBodyTransport = sandbox.createSandboxTransport({ timeoutMs: 10, fetchImpl: async () => ({ ok: true, status: 200, json() { return new Promise(() => {}); } }) });
    const stalledStarted = Date.now();
    await assert.rejects(() => stalledBodyTransport.sync(base), error => error.message === 'Plaid Sandbox request failed.');
    assert.ok(Date.now() - stalledStarted < 500, 'stalled response bodies must be bounded by transport timeout');

    assert.throws(() => sandbox.createSandboxConfig({ enabled: true, secret: base.secret, accessToken: base.accessToken, connectionKey: base.connectionKey, accountMap: base.accountMap }), /client ID/);
    assert.throws(() => sandbox.createSandboxConfig({ ...base, clientId: '' }), /client ID/);
    assert.throws(() => sandbox.createSandboxConfig({ ...base, baseUrl: 'https://sandbox.plaid.com.evil.test' }), /exactly https:\/\/sandbox\.plaid\.com/);
    assert.throws(() => sandbox.createSandboxConfig({ ...base, cutoverDate: null }), /cutover date/);
    assert.throws(() => sandbox.createSandboxConfig({ ...base, accountMap: { 'acct': 'Invented Account' } }), /unsupported display name/);
    assert.throws(() => sandbox.createSandboxConfig({ ...base, accountMap: {} }), /account mapping is required/);
    assert.throws(() => sandbox.createSandboxConfig({ ...base, ignoredAccountIds: ['acct-checking'] }), /must not overlap mapped accounts/);
    assert.throws(() => new PlaidTransactionsSyncAdapter({ client: { sync: async () => ({}) }, accountMap: base.accountMap, ignoredAccountIds: ['acct-checking'] }), /must not overlap mapped accounts/);
    assert.throws(() => new PlaidTransactionsSyncAdapter({ client: { sync: async () => ({}) }, accountMap: base.accountMap, ignoredAccountIds: [''] }), /non-empty strings/);
    assert.throws(() => new PlaidTransactionsSyncAdapter({ client: { sync: async () => ({}) }, accountMap: base.accountMap, ignoredAccountIds: ['acct-checking', 7] }), /non-empty strings/);

    let defaultNetworkCalls = 0;
    const disabled = sandbox.createSandboxProvider({ fetchImpl: async () => { defaultNetworkCalls += 1; } });
    await assert.rejects(() => disabled.fetchDelta(), /disabled/);
    assert.equal(defaultNetworkCalls, 0);

    const auth = { uid: 'sandbox-user', email: 'reviewer@example.test', tokenVerified: true, householdId: 'sandbox-household' };
    const composed = sandbox.createSandboxBudgetService({
        backend: new ProtectedReviewBackend({ householdId: 'sandbox-household', allowedUsers: [auth.email] }),
        syncEnabled: false
    });
    assert.equal(composed.syncService.enabled, false);
    assert.equal(composed.syncService.cutoverDate, appConfig.FIRST_SYNC_CUTOVER_DATE);
    await composed.backend.listPending(auth);
    await assert.rejects(() => composed.backend.listPending({ ...auth, email: 'unapproved@example.test' }), /approved app user/);
    await assert.rejects(() => composed.syncService.runOnOpen(auth, 'chase'), /fail-closed/);
    const injectedComposition = sandbox.createSandboxBudgetService({
        backend: composed.backend,
        syncEnabled: true,
        cutoverDate: appConfig.FIRST_SYNC_CUTOVER_DATE,
        provider: { fetchDelta: async () => ({ pages: [], cursor: 'synthetic-cursor' }) },
        connectionOwners: { chase: auth.uid },
        connectionResolver: async () => ({})
    });
    assert.equal(injectedComposition.syncService.enabled, true);
    let resolverNetworkCalls = 0;
    const boundService = sandbox.createSandboxBudgetService({
        ...base,
        householdId: auth.householdId,
        allowedUsers: [auth.email],
        syncEnabled: true,
        connectionOwners: { wrong: auth.uid },
        transport: { sync: async () => { resolverNetworkCalls += 1; return { added: [], modified: [], removed: [], has_more: false, next_cursor: 'never' }; } }
    });
    await assert.rejects(() => boundService.syncService.runOnOpen(auth, 'wrong'), /does not match/);
    assert.equal(resolverNetworkCalls, 0);

    const browserSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert.doesNotMatch(browserSource, /client[_-]?secret|access[_-]?token/i);
    assert.doesNotMatch(JSON.stringify(config), /synthetic-(?:secret|access-token)/);
    for (const malicious of ['JSON synthetic-secret', 'Sandbox secret synthetic-secret', 'base URL synthetic-secret', 'provider payload synthetic-secret']) {
        assert.equal(sandbox.sanitizeRunnerError(new Error(malicious)), 'Sandbox runner failed without exposing provider or credential details.');
    }
    assert.equal(sandbox.sanitizeRunnerError(new Error('Sandbox secret is required.')), 'Sandbox secret is required.');
    await assert.rejects(() => runner.main(['--secret=synthetic-secret']), /Unsupported Sandbox runner option/);
    console.log('PASS: Sandbox-only URL/input gating, injected Transactions Sync routing, disabled default, redacted config/errors, and existing alias validation.');
})().catch(error => { console.error(error); process.exitCode = 1; });

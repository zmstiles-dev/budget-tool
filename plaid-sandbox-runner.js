/*
 * User-run, server-only Plaid Sandbox input path.
 *
 * Default mode validates masked prompt input in memory and makes no network
 * request. Passing --sync explicitly performs only Transactions Sync and
 * prints counts, never provider rows, cursors, credentials, or response body.
 */
'use strict';

const readline = require('node:readline');
const sandbox = require('./plaid-sandbox.js');
const appConfig = require('./transaction-config.js');
const REPORTED_ERROR = Symbol('sandbox-runner-reported-error');

function askLine(prompt, input, output) {
    return new Promise((resolve, reject) => {
        const reader = readline.createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
        reader.question(prompt, answer => { reader.close(); resolve(answer.trim()); });
        reader.once('error', reject);
    });
}

function askSecret(prompt, input, output) {
    if (!input || !output || input.isTTY !== true || typeof input.setRawMode !== 'function') throw new Error('Sandbox secret input requires an interactive TTY.');
    return new Promise((resolve, reject) => {
        let value = '';
        let pending = '';
        let pasteMode = false;
        let settled = false;
        const pasteStart = '\u001b[200~';
        const pasteEnd = '\u001b[201~';
        const isPrefix = (valueText, marker) => marker.startsWith(valueText);
        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error);
            else {
                output.write('\n');
                resolve(result);
            }
        };
        const invalidInput = () => {
            const error = new Error('Sandbox secret input contains unsupported terminal controls.');
            error.code = 'SANDBOX_SECRET_INPUT_INVALID';
            return error;
        };
        const consume = () => {
            while (!settled && pending) {
                const marker = pasteMode ? pasteEnd : pasteStart;
                if (pending.startsWith(marker)) {
                    pending = pending.slice(marker.length);
                    pasteMode = !pasteMode;
                    continue;
                }
                if (isPrefix(pending, marker)) return;
                if (pending[0] === '\u001b') {
                    finish(invalidInput());
                    return;
                }
                const codePoint = pending.codePointAt(0);
                const character = String.fromCodePoint(codePoint);
                pending = pending.slice(character.length);
                if (character === '\u0003') {
                    const error = new Error('Sandbox secret input was cancelled.');
                    error.code = 'SANDBOX_SECRET_INPUT_CANCELLED';
                    finish(error);
                    return;
                }
                if (character === '\r' || character === '\n') {
                    if (pasteMode) {
                        finish(invalidInput());
                        return;
                    }
                    finish(null, value);
                    return;
                }
                if (character === '\u007f' || character === '\b') {
                    if (pasteMode) {
                        finish(invalidInput());
                        return;
                    }
                    value = value.slice(0, -1);
                    continue;
                }
                if (codePoint < 0x20 || codePoint === 0x7f) {
                    finish(invalidInput());
                    return;
                }
                value += character;
            }
        };
        const onData = chunk => {
            pending += chunk.toString('utf8');
            consume();
        };
        const cleanup = () => {
            input.removeListener('data', onData);
            try { input.setRawMode(false); } catch (_) { /* preserve the safe input error */ }
            input.pause();
        };
        try {
            output.write(prompt);
            input.setRawMode(true);
            input.resume();
            input.on('data', onData);
        } catch (error) {
            cleanup();
            reject(new Error('Sandbox secret input could not be initialized.'));
        }
    });
}

async function promptSandboxConfig(options) {
    const opts = options || {};
    const input = opts.input || process.stdin;
    const output = opts.output || process.stdout;
    const clientId = await askSecretWithRetry('Plaid Sandbox client ID (hidden): ', value => askSecret(value, input, output), output);
    const secret = await askSecretWithRetry('Plaid Sandbox secret (hidden): ', value => askSecret(value, input, output), output);
    const accessToken = await askSecretWithRetry('Plaid Sandbox access token (hidden): ', value => askSecret(value, input, output), output);
    const connectionKey = await askLine('Connection key (for example chase): ', input, output);
    const accountMapText = await askLine('Provider account map JSON (stable ID to existing display name): ', input, output);
    let accountMap;
    try { accountMap = JSON.parse(accountMapText); } catch (_) { throw new Error('Sandbox provider account map must be valid JSON.'); }
    const cursor = await askLine('Existing Transactions Sync cursor (blank for first sync): ', input, output);
    const cutoffInput = await askLine('First-sync cutoff YYYY-MM-DD (blank for configured default): ', input, output);
    return sandbox.createSandboxConfig({
        enabled: true,
        clientId,
        secret,
        accessToken,
        connectionKey,
        accountMap,
        ...(cursor ? { cursor } : {}),
        ...(cutoffInput ? { cutoverDate: cutoffInput } : {})
    });
}

function unattendedValue(environment, name) {
    const value = environment && environment[name];
    return typeof value === 'string' ? value.trim() : '';
}

async function createUnattendedSandboxSetup(options) {
    const opts = options || {};
    const environment = opts.env || process.env;
    const clientId = unattendedValue(environment, 'PLAID_CLIENT_ID');
    const secret = unattendedValue(environment, 'PLAID_SANDBOX_SECRET');
    const connectionKey = 'sandbox-test';
    if (!clientId) throw new Error('Sandbox unattended mode requires PLAID_CLIENT_ID.');
    if (!secret) throw new Error('Sandbox unattended mode requires PLAID_SANDBOX_SECRET.');
    const createSetup = typeof opts.createSandboxSetup === 'function' ? opts.createSandboxSetup : sandbox.createSandboxSetup;
    const setup = await createSetup({
        allowNetwork: true,
        clientId,
        secret,
        institutionId: 'ins_109508',
        overrideUsername: 'user_good',
        overridePassword: 'pass_good',
        fetchImpl: opts.fetchImpl
    });
    const accounts = setup && Array.isArray(setup.accounts) ? setup.accounts : [];
    const checking = accounts.filter(account => String(account && account.type || '').toLowerCase() === 'depository'
        && String(account && account.subtype || '').toLowerCase() === 'checking');
    if (checking.length !== 1) throw new Error('Sandbox unattended setup requires exactly one depository checking account.');
    const selected = checking[0];
    const accountId = selected && selected.account_id;
    if (typeof accountId !== 'string' || !accountId.trim()) throw new Error('Sandbox unattended setup returned an invalid checking account.');
    const ignoredAccountIds = accounts.map(account => account && account.account_id).filter(value => value !== accountId);
    return sandbox.createSandboxConfig({
        enabled: true,
        clientId,
        secret,
        accessToken: setup && setup.accessToken,
        connectionKey,
        accountMap: { [accountId]: 'Checking Account' },
        ignoredAccountIds
    });
}

async function askSecretWithRetry(prompt, askHidden, output) {
    while (true) {
        try {
            return await askHidden(prompt);
        } catch (error) {
            if (!error || error.code !== 'SANDBOX_SECRET_INPUT_INVALID') throw error;
            output.write('Secret input contained unsupported terminal controls; please retry this field.\n');
        }
    }
}

function countValue(value, fallback) {
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function summarizeSyncResult(result) {
    const pages = result && Array.isArray(result.pages) ? result.pages : [];
    const pageRecords = pages.reduce((count, page) => count + (page && Array.isArray(page.records) ? page.records.length : 0), 0);
    const supplied = result && result.counts && typeof result.counts === 'object' ? result.counts : {};
    const countKeys = ['rawObservations', 'skippedObservations', 'cutoffExcluded', 'resultingRecords'];
    const validSuppliedCounts = countKeys.every(key => Number.isSafeInteger(supplied[key]) && supplied[key] >= 0);
    const countsKnown = validSuppliedCounts && supplied.resultingRecords === pageRecords && supplied.rawObservations === supplied.skippedObservations + supplied.cutoffExcluded + pageRecords;
    const summary = {
        rawObservations: countValue(supplied.rawObservations, pageRecords),
        skippedObservations: countValue(supplied.skippedObservations, 0),
        cutoffExcluded: countValue(supplied.cutoffExcluded, 0),
        resultingRecords: pageRecords
    };
    Object.defineProperty(summary, 'countsKnown', { value: countsKnown, enumerable: false });
    return summary;
}

function syncEmptyLabel(counts) {
    if (!counts.countsKnown) return 'counts-unknown';
    return counts.rawObservations === 0 ? 'raw-empty' : 'selected-empty';
}

function syncCountLabel(counts) {
    return counts.countsKnown
        ? `raw=${counts.rawObservations}, skipped-observations=${counts.skippedObservations}, cutoff-excluded=${counts.cutoffExcluded}, selected=${counts.resultingRecords}`
        : 'aggregate counts unavailable';
}

function accountChoiceLabel(account) {
    const parts = [account && account.name, account && account.official_name, account && account.type, account && account.subtype]
        .map(value => String(value || '').trim()).filter(Boolean);
    return parts.join(' / ') || 'Unnamed Sandbox account';
}

function parseAccountLabels(value, accounts) {
    let labels;
    try { labels = JSON.parse(value); } catch (_) { throw new Error('Sandbox account mapping choices must be valid JSON.'); }
    if (!Array.isArray(labels) || labels.length !== accounts.length) throw new Error('Sandbox account mapping choices must match the numbered accounts.');
    const accountMap = {};
    labels.forEach((label, index) => {
        const displayName = String(label ?? '').trim();
        if (!displayName || /^skip$/i.test(displayName)) return;
        accountMap[accounts[index].account_id] = displayName;
    });
    return accountMap;
}

async function promptSandboxSetup(options) {
    const opts = options || {};
    const input = opts.input || process.stdin;
    const output = opts.output || process.stdout;
    const ask = typeof opts.askLine === 'function' ? opts.askLine : prompt => askLine(prompt, input, output);
    const askHidden = typeof opts.askSecret === 'function' ? opts.askSecret : prompt => askSecret(prompt, input, output);
    const createSetup = typeof opts.createSandboxSetup === 'function' ? opts.createSandboxSetup : sandbox.createSandboxSetup;
    const clientId = await askSecretWithRetry('Plaid Sandbox client ID (hidden): ', askHidden, output);
    const secret = await askSecretWithRetry('Plaid Sandbox secret (hidden): ', askHidden, output);
    const institutionId = (await ask('Sandbox institution ID [ins_109508]: ')) || 'ins_109508';
    const overrideUsername = (await ask('Sandbox test username [user_good]: ')) || 'user_good';
    const overridePassword = await askSecretWithRetry('Sandbox test password (hidden; blank uses pass_good): ', askHidden, output);
    const setup = await createSetup({
        allowNetwork: true,
        clientId,
        secret,
        institutionId,
        overrideUsername,
        overridePassword
    });
    if (!setup || !Array.isArray(setup.accounts) || !setup.accounts.length) throw new Error('Sandbox setup returned no accounts to map.');
    output.write('Sandbox account choices (IDs remain private to this process):\n');
    setup.accounts.forEach((account, index) => output.write(`  ${index + 1}. ${accountChoiceLabel(account)}\n`));
    const accountMap = await promptAccountMapping(setup.accounts, { askLine: ask, output });
    const ignoredAccountIds = setup.accounts
        .map(account => account && account.account_id)
        .filter(accountId => typeof accountId === 'string' && accountId.trim() && !Object.prototype.hasOwnProperty.call(accountMap, accountId));
    let connectionKey = '';
    while (!connectionKey) {
        connectionKey = String(await ask('Connection key (for example chase): ') || '').trim();
        if (!connectionKey) output.write('Connection key is required; please enter a non-blank key.\n');
    }
    return sandbox.createSandboxConfig({
        enabled: true,
        clientId,
        secret,
        accessToken: setup.accessToken,
        connectionKey,
        accountMap,
        ignoredAccountIds
    });
}

async function promptAccountMapping(accounts, options) {
    const opts = options || {};
    const ask = opts.askLine;
    const output = opts.output || process.stdout;
    if (!Array.isArray(accounts) || !accounts.length || typeof ask !== 'function') throw new Error('Sandbox account mapping prompt is unavailable.');
    const labels = appConfig.accountDisplayNames;
    while (true) {
        const accountMap = {};
        for (let index = 0; index < accounts.length; index += 1) {
            const account = accounts[index];
            output.write(`\nMap account ${index + 1} (${accountChoiceLabel(account)}):\n`);
            labels.forEach((label, labelIndex) => output.write(`  ${labelIndex + 1}. ${label}\n`));
            output.write('  0. Skip this account\n');
            while (true) {
                const choice = String(await ask('Choose a display name number, or type skip/blank: ') || '').trim();
                if (!choice || /^skip$/i.test(choice) || choice === '0') break;
                if (!/^\d+$/.test(choice) || Number(choice) < 1 || Number(choice) > labels.length) {
                    output.write('Invalid choice; please choose one of the displayed numbers, skip, or blank.\n');
                    continue;
                }
                const accountId = account && account.account_id;
                if (typeof accountId !== 'string' || !accountId.trim()) throw new Error('Sandbox account lookup returned an invalid account.');
                accountMap[accountId] = labels[Number(choice) - 1];
                break;
            }
        }
        if (Object.keys(accountMap).length) return accountMap;
        output.write('No accounts are mapped. Choose at least one account; restarting the mapping menu using the same Sandbox Item.\n');
    }
}

async function runSandboxSync(provider, config, options) {
    const opts = options || {};
    const providerOptions = opts.providerOptions && typeof opts.providerOptions === 'object' ? opts.providerOptions : {};
    const deadlineMs = Number.isSafeInteger(opts.deadlineMs) && opts.deadlineMs > 0
        ? opts.deadlineMs
        : sandbox.DEFAULT_SYNC_DEADLINE_MS;
    const deadlineAt = Number.isSafeInteger(opts.deadlineAt) && opts.deadlineAt > 0
        ? opts.deadlineAt
        : Date.now() + deadlineMs;
    const bounded = async operation => {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) throw sandbox.createSyncDeadlineError();
        let timer;
        const deadline = new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(sandbox.createSyncDeadlineError()), remaining);
        });
        try {
            const promise = typeof operation === 'function' ? operation() : operation;
            return await Promise.race([Promise.resolve(promise), deadline]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    };
    const fetchDelta = request => {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const callerSignal = request && request.signal;
        let removeAbortListener = () => {};
        if (controller && callerSignal && typeof callerSignal.addEventListener === 'function') {
            const abort = () => controller.abort();
            if (callerSignal.aborted) abort();
            else {
                callerSignal.addEventListener('abort', abort, { once: true });
                removeAbortListener = () => callerSignal.removeEventListener('abort', abort);
            }
        }
        const requestWithDeadline = { ...request, deadlineAt, ...(controller ? { signal: controller.signal } : {}) };
        if (deadlineAt <= Date.now()) {
            if (controller) controller.abort();
            removeAbortListener();
            return Promise.reject(sandbox.createSyncDeadlineError());
        }
        return bounded(() => provider.fetchDelta(requestWithDeadline)).finally(() => {
            if (controller) controller.abort();
            removeAbortListener();
        });
    };
    const maxReadyRetries = Number.isSafeInteger(opts.maxReadyRetries) && opts.maxReadyRetries >= 0 ? opts.maxReadyRetries : 2;
    const maxSyncRetries = Number.isSafeInteger(opts.maxSyncRetries) && opts.maxSyncRetries >= 0 ? opts.maxSyncRetries : 1;
    const maxEmptyRetries = Number.isSafeInteger(opts.maxEmptyRetries) && opts.maxEmptyRetries >= 0 ? opts.maxEmptyRetries : 1;
    const output = opts.output || process.stdout;
    const retry = typeof opts.retry === 'function' ? opts.retry : async attempt => {
        const answer = await askLine(`Sandbox data is not ready. Retry using the same Item? [y/N] (attempt ${attempt}/${maxReadyRetries}): `, opts.input || process.stdin, opts.output || process.stdout);
        return /^y(?:es)?$/i.test(answer);
    };
    const syncRetry = typeof opts.syncRetry === 'function' ? opts.syncRetry : async attempt => {
        const answer = await askLine(`Sandbox Transactions Sync failed. Retry the same Item? [y/N] (attempt ${attempt}/${maxSyncRetries}): `, opts.input || process.stdin, opts.output || process.stdout);
        return /^y(?:es)?$/i.test(answer);
    };
    const emptyRetry = typeof opts.emptyRetry === 'function' ? opts.emptyRetry : async (attempt, counts) => {
        const answer = await askLine(`Transactions Sync ${syncEmptyLabel(counts)} (${syncCountLabel(counts)}). Retry the same Item? [y/N] (attempt ${attempt}/${maxEmptyRetries}): `, opts.input || process.stdin, opts.output || process.stdout);
        return /^y(?:es)?$/i.test(answer);
    };
    let attempt = 0;
    let syncAttempt = 0;
    let emptyAttempt = 0;
    while (true) {
        try {
            const result = await fetchDelta({
                ...providerOptions,
                accessToken: config.accessToken,
                cursor: config.cursor || '',
                connectionKey: config.connectionKey,
                cutoverDate: config.cutoverDate
            });
            const counts = summarizeSyncResult(result);
            if (counts.resultingRecords > 0 || emptyAttempt >= maxEmptyRetries || !(await bounded(() => emptyRetry(emptyAttempt + 1, counts)))) return result;
            emptyAttempt += 1;
        } catch (error) {
            const readinessCode = String(error && (error.code || error.error_code) || '');
            if (readinessCode === sandbox.TRANSACTIONS_PRODUCT_NOT_READY || readinessCode === sandbox.INITIAL_SYNC_PENDING) {
                if (attempt >= maxReadyRetries || !(await bounded(() => retry(attempt + 1)))) throw error;
                attempt += 1;
                continue;
            }
            if (!sandbox.isTrustedSyncDiagnostic(error) || !sandbox.isTransientSyncFailure(error)) throw error;
            output.write(`${sandbox.sanitizeRunnerError(error)}\n`);
            Object.defineProperty(error, REPORTED_ERROR, { value: true, configurable: true });
            if (syncAttempt >= maxSyncRetries || !(await bounded(() => syncRetry(syncAttempt + 1, error)))) throw error;
            syncAttempt += 1;
        }
    }
}

async function main(argv) {
    const args = argv || process.argv.slice(2);
    if (args.some(argument => !['--sync', '--create-item'].includes(argument))) throw new Error('Unsupported Sandbox runner option.');
    const shouldSync = args.includes('--sync');
    const config = args.includes('--create-item') ? await promptSandboxSetup() : await promptSandboxConfig();
    if (args.includes('--create-item') && !shouldSync) {
        console.log('Sandbox Item and account mapping validated in memory; no local or Firebase data was persisted. The Sandbox Item remains available in the user\'s Plaid Sandbox account.');
        return;
    }
    if (!shouldSync) {
        console.log('Sandbox configuration validated in memory; no network request was made.');
        return;
    }
    const provider = sandbox.createSandboxProvider({ config });
    const result = await runSandboxSync(provider, config);
    const counts = summarizeSyncResult(result);
    const persistenceNote = 'The process exits without local or Firebase persistence; its in-memory token is discarded and cannot resume this Item after exit. The upstream Sandbox Item remains available, and a fresh --create-item run may create another Item.';
    if (counts.resultingRecords === 0) {
        const emptyKind = syncEmptyLabel(counts);
        if (emptyKind === 'raw-empty') console.log(`Sandbox Transactions Sync raw-empty: no raw observations were returned (raw=${counts.rawObservations}, selected=${counts.resultingRecords}); no app data was staged. ${persistenceNote}`);
        else if (emptyKind === 'selected-empty') console.log(`Sandbox Transactions Sync selected-empty: raw observations were returned but none produced app records (raw=${counts.rawObservations}, skipped-observations=${counts.skippedObservations}, cutoff-excluded=${counts.cutoffExcluded}, selected=${counts.resultingRecords}); no app data was staged. ${persistenceNote}`);
        else console.log(`Sandbox Transactions Sync counts-unknown: no app records were returned by this provider response (aggregate counts unavailable); no app data was staged. ${persistenceNote}`);
    } else {
        console.log(`Sandbox Transactions Sync completed: pages=${result.pages.length}, raw=${counts.rawObservations}, skipped-observations=${counts.skippedObservations}, cutoff-excluded=${counts.cutoffExcluded}, selected=${counts.resultingRecords}; no app data was staged.`);
    }
}

if (require.main === module) {
    main().catch(error => {
        if (!error || error[REPORTED_ERROR] !== true) console.error(sandbox.sanitizeRunnerError(error));
        process.exitCode = 1;
    });
}

module.exports = { askLine, askSecret, askSecretWithRetry, promptSandboxConfig, createUnattendedSandboxSetup, promptSandboxSetup, promptAccountMapping, parseAccountLabels, summarizeSyncResult, runSandboxSync, main };

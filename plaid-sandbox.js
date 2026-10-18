/*
 * Server-only Plaid Sandbox bootstrap.
 *
 * This module never reads process.env, files, browser storage, or credentials
 * on import. A user-run entry point may pass masked prompt values in memory;
 * tests inject the transport. Provider setup is limited to documented
 * Sandbox Item creation/account discovery, and provider reads are limited to
 * the Transactions Sync endpoint.
 */
'use strict';

const backendApi = require('./transaction-backend.js');
const reviewApi = require('./transaction-review.js');
const appConfig = require('./transaction-config.js');
const { createBudgetService } = require('./transaction-service.js');

const SANDBOX_ORIGIN = 'https://sandbox.plaid.com';
const SANDBOX_SYNC_URL = `${SANDBOX_ORIGIN}/transactions/sync`;
const SANDBOX_PUBLIC_TOKEN_URL = `${SANDBOX_ORIGIN}/sandbox/public_token/create`;
const ITEM_EXCHANGE_URL = `${SANDBOX_ORIGIN}/item/public_token/exchange`;
const ACCOUNTS_GET_URL = `${SANDBOX_ORIGIN}/accounts/get`;
const TRANSACTIONS_SYNC_MUTATION = 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION';
const TRANSACTIONS_PRODUCT_NOT_READY = 'PRODUCT_NOT_READY';
const INITIAL_SYNC_PENDING = 'INITIAL_SYNC_PENDING';
const SYNC_DEADLINE_EXCEEDED = 'SYNC_DEADLINE_EXCEEDED';
const DEFAULT_SYNC_DEADLINE_MS = 90_000;
const SETUP_ERROR_BRAND = Symbol('sandbox-setup-diagnostic');
const SETUP_ERROR_STAGES = new Set(['create-public-token', 'exchange-public-token', 'accounts-get', 'transactions-sync']);
const SAFE_PLAID_ERROR_TYPES = new Set([
    'API_ERROR', 'INSTITUTION_ERROR', 'ITEM_ERROR', 'INVALID_REQUEST', 'INVALID_INPUT',
    'RATE_LIMIT_EXCEEDED', 'SANDBOX_ERROR'
]);
const SAFE_PLAID_ERROR_CODES = new Set([
    'ACCESS_NOT_GRANTED', 'BAD_REQUEST', 'INSTITUTION_DOWN', 'INSTITUTION_NOT_FOUND',
    'INSTITUTION_NOT_SUPPORTED', 'INTERNAL_SERVER_ERROR', 'INVALID_ACCESS_TOKEN',
    'INVALID_API_KEYS', 'INVALID_FIELD', 'INVALID_INPUT', 'INVALID_INSTITUTION',
    'INVALID_PRODUCT', 'INVALID_PUBLIC_TOKEN', 'ITEM_LOCKED',
    'ITEM_LOGIN_REQUIRED', 'ITEM_NOT_FOUND', 'MISSING_FIELDS', 'PRODUCT_NOT_READY',
    'RATE_LIMIT_EXCEEDED', 'SANDBOX_PRODUCT_NOT_ENABLED', 'UNAUTHORIZED_ENVIRONMENT',
    'UNAUTHORIZED_ROUTE_ACCESS', TRANSACTIONS_SYNC_MUTATION, INITIAL_SYNC_PENDING, SYNC_DEADLINE_EXCEEDED,
    'INCOMPLETE_SYNC_RESPONSE'
]);
const SAFE_SYNC_ERROR_MESSAGES = new Set([
    'Plaid Sandbox request failed.',
    'Plaid Sandbox returned invalid JSON.',
    'Plaid Sandbox returned an incomplete Transactions Sync response.',
    'Plaid sync initial response is empty; retry the same Item.',
    'Plaid sync exceeded its bounded execution window.',
    'Plaid Sandbox returned a provider error.',
    'Plaid Sandbox returned an invalid transaction observation.',
    'Plaid Sandbox transaction is missing an identifier.',
    'Plaid Sandbox transaction amount is invalid.',
    'Plaid Sandbox transaction contains an invalid field.',
    'Plaid Sandbox transaction contains an invalid pending flag.',
    'Plaid Sandbox transaction contains an invalid category.',
    'Plaid Sandbox transaction contains an invalid finance category.'
]);
const SAFE_RESPONSE_SHAPE_KEYS = Object.freeze(['added', 'modified', 'removed', 'has_more', 'next_cursor']);
const SAFE_RESPONSE_SHAPE_TYPES = new Set(['missing', 'array', 'boolean', 'string', 'null', 'number', 'object', 'undefined']);
const SAFE_STATIC_SYNC_FAILURES = new Map([
    ['Plaid Sandbox returned an incomplete Transactions Sync response.', 'INCOMPLETE_SYNC_RESPONSE'],
    ['Plaid sync initial response is empty; retry the same Item.', INITIAL_SYNC_PENDING],
    ['Plaid sync exceeded its bounded execution window.', SYNC_DEADLINE_EXCEEDED],
    ['Plaid Sandbox returned a provider error.', 'PROVIDER_ERROR'],
    ['Plaid Sandbox returned an invalid transaction observation.', 'INVALID_OBSERVATION'],
    ['Plaid Sandbox transaction is missing an identifier.', 'MISSING_IDENTIFIER'],
    ['Plaid Sandbox transaction amount is invalid.', 'INVALID_AMOUNT'],
    ['Plaid Sandbox transaction contains an invalid field.', 'INVALID_FIELD'],
    ['Plaid Sandbox transaction contains an invalid pending flag.', 'INVALID_PENDING'],
    ['Plaid Sandbox transaction contains an invalid category.', 'INVALID_CATEGORY'],
    ['Plaid Sandbox transaction contains an invalid finance category.', 'INVALID_FINANCE_CATEGORY'],
    ['Plaid transaction account is not mapped.', 'ACCOUNT_NOT_MAPPED'],
    ['Provider transaction is missing a reviewable date.', 'MISSING_REVIEWABLE_DATE'],
    ['Removed provider transaction could not be hydrated from accepted history.', 'REMOVED_NOT_HYDRATED'],
    ['Plaid transaction currency is not supported; USD is required.', 'UNSUPPORTED_CURRENCY'],
    ['Plaid transaction amount is invalid.', 'INVALID_AMOUNT'],
    ['Plaid transaction is missing transaction_id.', 'MISSING_TRANSACTION_ID'],
    ['Plaid sync returned an incomplete page.', 'INCOMPLETE_PAGE'],
    ['Plaid sync cursor did not advance.', 'CURSOR_DID_NOT_ADVANCE'],
    ['Plaid sync exceeded the page limit.', 'PAGE_LIMIT_EXCEEDED'],
    ['Plaid sync changed during pagination too many times.', 'MUTATION_RESTART_LIMIT'],
    ['Plaid sync did not complete.', 'SYNC_DID_NOT_COMPLETE'],
    ['Plaid sync provider request failed.', 'PROVIDER_REQUEST_FAILED'],
    ['Plaid sync requires a server-side access token resolver.', 'ACCESS_TOKEN_RESOLVER_REQUIRED'],
    ['Plaid sync cutover date is invalid.', 'INVALID_CUTOVER_DATE'],
    ['Plaid account name mapping is not configured.', 'ACCOUNT_MAPPING_REQUIRED']
]);

function text(value) {
    return String(value ?? '').trim();
}

function validDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(value));
    if (!match) return false;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() + 1 === Number(match[2]) && date.getUTCDate() === Number(match[3]);
}

function own(options, key) {
    return Object.prototype.hasOwnProperty.call(options || {}, key);
}

function safeSetupRequestId(value, sensitiveValues) {
    const candidate = text(value);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(candidate)) return '';
    const lower = candidate.toLowerCase();
    if ((sensitiveValues || []).some(secret => {
        const valueText = text(secret).toLowerCase();
        return valueText && (lower.includes(valueText) || valueText.includes(lower));
    })) return '';
    return candidate;
}

function responseShapeType(value, present) {
    if (!present) return 'missing';
    if (Array.isArray(value)) return 'array';
    if (value === null) return 'null';
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'string') return 'string';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'object') return 'object';
    return typeof value;
}

function safeResponseShape(value) {
    const isDescriptor = value && typeof value === 'object' && !Array.isArray(value)
        && SAFE_RESPONSE_SHAPE_KEYS.every(key => value[key] && typeof value[key] === 'object' && !Array.isArray(value[key])
            && typeof value[key].present === 'boolean' && SAFE_RESPONSE_SHAPE_TYPES.has(value[key].type));
    if (isDescriptor) {
        const descriptor = {};
        for (const key of SAFE_RESPONSE_SHAPE_KEYS) {
            const field = value[key];
            const safe = { present: field.present, type: field.type };
            if (field.count !== undefined && Number.isSafeInteger(field.count) && field.count >= 0 && field.count <= 1000) safe.count = field.count;
            descriptor[key] = Object.freeze(safe);
        }
        return Object.freeze(descriptor);
    }
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    const shape = {};
    for (const key of SAFE_RESPONSE_SHAPE_KEYS) {
        const present = Boolean(source && Object.prototype.hasOwnProperty.call(source, key));
        const field = { present, type: responseShapeType(source && source[key], present) };
        if (present && Array.isArray(source[key])) field.count = Math.min(source[key].length, 1000);
        shape[key] = Object.freeze(field);
    }
    return Object.freeze(shape);
}

function setupFailure(stage, details, message) {
    const value = details || {};
    const diagnostic = { stage: SETUP_ERROR_STAGES.has(stage) ? stage : 'unknown' };
    if (Number.isInteger(value.status) && value.status >= 100 && value.status <= 599) diagnostic.status = value.status;
    if (SAFE_PLAID_ERROR_TYPES.has(value.type)) diagnostic.type = value.type;
    if (SAFE_PLAID_ERROR_CODES.has(value.code)) diagnostic.code = value.code;
    const requestId = safeSetupRequestId(value.requestId, value.sensitiveValues);
    if (requestId) diagnostic.request_id = requestId;
    if (value.responseShape !== undefined) diagnostic.response_shape = safeResponseShape(value.responseShape);
    const error = new Error(message || 'Sandbox setup request failed.');
    Object.defineProperty(error, SETUP_ERROR_BRAND, { value: true });
    Object.defineProperty(error, 'setupDiagnostic', { value: Object.freeze(diagnostic) });
    return error;
}

function setupErrorDetails(body, response, sensitiveValues) {
    const source = setupResponseObject(body) || {};
    const responseSecrets = ['access_token', 'public_token', 'link_token', 'secret', 'client_secret']
        .map(key => source[key]).filter(value => value !== undefined && value !== null);
    return {
        status: response && Number.isInteger(response.status) ? response.status : undefined,
        type: text(source.error_type),
        code: text(source.error_code),
        requestId: source.request_id,
        sensitiveValues: [...(sensitiveValues || []), ...responseSecrets]
    };
}

function preserveSandboxSyncError(error) {
    if (error && error[SETUP_ERROR_BRAND] === true && error.setupDiagnostic && error.setupDiagnostic.stage === 'transactions-sync') {
        const code = error.setupDiagnostic.code;
        // Readiness is owned by runSandboxSync's same-Item window. Provider
        // retries are reserved for transport/provider transients, so a real
        // adapter with its default retry budget cannot hide readiness or
        // permanent auth/input/schema failures.
        if (code === INITIAL_SYNC_PENDING || code === TRANSACTIONS_PRODUCT_NOT_READY) return { error, retryable: false };
        return { error, retryable: isTransientSyncFailure(error) };
    }
    if (error && SAFE_SYNC_ERROR_MESSAGES.has(error.message)) return { error, retryable: false };
    return null;
}

function isTrustedSyncDiagnostic(error) {
    return Boolean(error && error[SETUP_ERROR_BRAND] === true && error.setupDiagnostic && error.setupDiagnostic.stage === 'transactions-sync');
}

// Return only the fields that setupFailure already validated and froze.  The
// local approved bridge uses this after a provider failure so it can report a
// useful stage/status/code without ever handling provider error text or body
// data.  Unbranded errors intentionally produce no diagnostic.
function safeSandboxDiagnostic(error) {
    if (!(error && error[SETUP_ERROR_BRAND] === true && error.setupDiagnostic && typeof error.setupDiagnostic === 'object')) return null;
    const source = error.setupDiagnostic;
    if (!SETUP_ERROR_STAGES.has(source.stage)) return null;
    const diagnostic = { stage: source.stage === 'transactions-sync' ? 'sync' : 'setup' };
    if (Number.isInteger(source.status) && source.status >= 100 && source.status <= 599) diagnostic.status = source.status;
    if (SAFE_PLAID_ERROR_TYPES.has(source.type)) diagnostic.type = source.type;
    if (SAFE_PLAID_ERROR_CODES.has(source.code)) diagnostic.code = source.code;
    if (typeof source.request_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(source.request_id)) diagnostic.request_id = source.request_id;
    if (source.response_shape !== undefined) diagnostic.response_shape = safeResponseShape(source.response_shape);
    return Object.freeze(diagnostic);
}

function safeSyncDiagnostic(error) {
    const diagnostic = safeSandboxDiagnostic(error);
    return diagnostic && diagnostic.stage === 'sync' ? diagnostic : null;
}

// Static adapter failures are useful for local diagnosis, but only exact
// messages already accepted by sanitizeRunnerError may receive a cause code.
// This prevents arbitrary provider text from becoming output metadata.
function safeStaticSyncDiagnostic(error) {
    const message = text(error && error.message);
    const code = SAFE_STATIC_SYNC_FAILURES.get(message);
    if (!code || sanitizeRunnerError(error) !== message) return null;
    return Object.freeze({ stage: 'sync', code });
}

function isTransientSyncFailure(error) {
    if (!(error && error[SETUP_ERROR_BRAND] === true && error.setupDiagnostic && error.setupDiagnostic.stage === 'transactions-sync')) return false;
    const diagnostic = error.setupDiagnostic;
    const code = text(diagnostic.code);
    if (code === TRANSACTIONS_PRODUCT_NOT_READY || code === INITIAL_SYNC_PENDING) return true;
    if (error.message === 'Plaid Sandbox returned invalid JSON.') return false;
    const permanentCodes = new Set([
        'ACCESS_NOT_GRANTED', 'BAD_REQUEST', 'INVALID_ACCESS_TOKEN', 'INVALID_API_KEYS',
        'INVALID_FIELD', 'INVALID_INPUT', 'INVALID_INSTITUTION', 'INVALID_PRODUCT',
        'INVALID_PUBLIC_TOKEN', 'ITEM_LOCKED', 'ITEM_LOGIN_REQUIRED', 'ITEM_NOT_FOUND',
        'MISSING_FIELDS', 'SANDBOX_PRODUCT_NOT_ENABLED', 'UNAUTHORIZED_ENVIRONMENT',
        'UNAUTHORIZED_ROUTE_ACCESS', 'INCOMPLETE_SYNC_RESPONSE', 'PROVIDER_ERROR'
    ]);
    if (permanentCodes.has(code) || diagnostic.type === 'INVALID_REQUEST' || diagnostic.type === 'INVALID_INPUT') return false;
    if (Number.isInteger(diagnostic.status)) return diagnostic.status === 408 || diagnostic.status === 425 || diagnostic.status === 429 || diagnostic.status >= 500;
    return error.message === 'Plaid Sandbox request failed.';
}

function createSyncDeadlineError() {
    const error = new Error('Plaid sync exceeded its bounded execution window.');
    error.code = SYNC_DEADLINE_EXCEEDED;
    error.error_code = SYNC_DEADLINE_EXCEEDED;
    return error;
}

async function invokeSetupStage(stage, action) {
    try {
        return await action();
    } catch (error) {
        if (error && error[SETUP_ERROR_BRAND] === true) throw error;
        throw setupFailure(stage, {});
    }
}

function normalizeAccountMap(value, enabled) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        if (enabled) throw new Error('Sandbox provider account mapping is required.');
        return {};
    }
    const output = {};
    for (const [providerAccountId, displayName] of Object.entries(value)) {
        const id = text(providerAccountId);
        const name = text(displayName);
        if (!id || !name || !appConfig.accountDisplayNames.includes(name)) throw new Error('Sandbox provider account mapping contains an unsupported display name.');
        output[id] = name;
    }
    if (enabled && !Object.keys(output).length) throw new Error('Sandbox provider account mapping is required.');
    return output;
}

function normalizeIgnoredAccountIds(value, accountMap) {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error('Sandbox ignored account IDs must be an array.');
    const ids = [...new Set(value.map(item => text(item)).filter(Boolean))];
    if (ids.some(id => Object.prototype.hasOwnProperty.call(accountMap, id))) throw new Error('Sandbox ignored account IDs must not overlap mapped accounts.');
    return ids;
}

function createSandboxConfig(options) {
    const opts = options || {};
    const enabled = opts.enabled === true;
    const cutoverDate = own(opts, 'cutoverDate') ? opts.cutoverDate : appConfig.FIRST_SYNC_CUTOVER_DATE;
    if (!validDate(cutoverDate)) throw new Error('Sandbox first-sync cutover date must be a valid YYYY-MM-DD date.');
    const baseUrl = own(opts, 'baseUrl') ? text(opts.baseUrl) : SANDBOX_ORIGIN;
    if (baseUrl !== SANDBOX_ORIGIN) throw new Error('Sandbox provider base URL must be exactly https://sandbox.plaid.com.');
    const accountMap = normalizeAccountMap(opts.accountMap, enabled);
    const ignoredAccountIds = normalizeIgnoredAccountIds(opts.ignoredAccountIds, accountMap);
    const clientId = text(opts.clientId);
    const secret = text(opts.secret);
    const accessToken = text(opts.accessToken);
    const connectionKey = text(opts.connectionKey);
    if (enabled && !clientId) throw new Error('Sandbox client ID is required.');
    if (enabled && !secret) throw new Error('Sandbox secret is required.');
    if (enabled && !accessToken) throw new Error('Sandbox access token is required.');
    if (enabled && !connectionKey) throw new Error('Sandbox connection key is required.');
    const config = {
        enabled,
        baseUrl,
        cutoverDate: text(cutoverDate),
        connectionKey,
        cursor: text(opts.cursor),
        accountMap: Object.freeze(accountMap),
        ignoredAccountIds: Object.freeze(ignoredAccountIds)
    };
    // Keep secret inputs available to the server adapter while excluding them
    // from JSON export, object-key logging, and accidental browser handoff.
    Object.defineProperties(config, {
        clientId: { value: clientId, enumerable: false, writable: false },
        secret: { value: secret, enumerable: false, writable: false },
        accessToken: { value: accessToken, enumerable: false, writable: false }
    });
    return Object.freeze(config);
}

function safeSyncResponse(body, diagnosticDetails) {
    const source = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
    if (!source) throw setupFailure('transactions-sync', { ...(diagnosticDetails || {}), code: 'INCOMPLETE_SYNC_RESPONSE', responseShape: body }, 'Plaid Sandbox returned an incomplete Transactions Sync response.');
    if (text(source.error_code) === TRANSACTIONS_SYNC_MUTATION) throw mutationError();
    if (text(source.error_code) === TRANSACTIONS_PRODUCT_NOT_READY) throw productNotReadyError({ ...(diagnosticDetails || {}), code: TRANSACTIONS_PRODUCT_NOT_READY });
    if (text(source.error_code)) throw new Error('Plaid Sandbox returned a provider error.');
    if (!Array.isArray(source.added) || !Array.isArray(source.modified) || !Array.isArray(source.removed) || typeof source.has_more !== 'boolean' || typeof source.next_cursor !== 'string') {
        throw setupFailure('transactions-sync', { ...(diagnosticDetails || {}), code: 'INCOMPLETE_SYNC_RESPONSE', responseShape: source }, 'Plaid Sandbox returned an incomplete Transactions Sync response.');
    }
    const initialEmpty = diagnosticDetails && diagnosticDetails.initialSync === true
        && source.added.length === 0 && source.modified.length === 0 && source.removed.length === 0
        && source.has_more === false && source.next_cursor === '';
    if (initialEmpty) {
        const details = { sensitiveValues: Array.isArray(diagnosticDetails && diagnosticDetails.sensitiveValues) ? diagnosticDetails.sensitiveValues : [] };
        if (diagnosticDetails && Number.isInteger(diagnosticDetails.status) && diagnosticDetails.status >= 100 && diagnosticDetails.status <= 599) details.status = diagnosticDetails.status;
        if (diagnosticDetails && typeof diagnosticDetails.requestId === 'string') details.requestId = diagnosticDetails.requestId;
        const error = setupFailure('transactions-sync', { ...details, code: INITIAL_SYNC_PENDING }, 'Plaid sync initial response is empty; retry the same Item.');
        error.code = INITIAL_SYNC_PENDING;
        error.error_code = INITIAL_SYNC_PENDING;
        throw error;
    }
    if (!text(source.next_cursor)) throw new Error('Plaid Sandbox returned an incomplete Transactions Sync response.');
    return {
        added: source.added.map(item => safeProviderTransaction(item, 'added')),
        modified: source.modified.map(item => safeProviderTransaction(item, 'modified')),
        removed: source.removed.map(item => safeProviderTransaction(item, 'removed')),
        has_more: source.has_more,
        next_cursor: source.next_cursor
    };
}

function safeProviderTransaction(item, kind) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Plaid Sandbox returned an invalid transaction observation.');
    const safe = {};
    const transactionId = typeof item.transaction_id === 'string' ? text(item.transaction_id) : typeof item.id === 'string' ? text(item.id) : '';
    if (!transactionId) throw new Error('Plaid Sandbox transaction is missing an identifier.');
    safe.transaction_id = transactionId;
    const hasAmount = Object.prototype.hasOwnProperty.call(item, 'amount');
    if (kind !== 'removed' && (!hasAmount || typeof item.amount !== 'number' || !Number.isFinite(item.amount))) throw new Error('Plaid Sandbox transaction amount is invalid.');
    if (hasAmount) {
        if (typeof item.amount !== 'number' || !Number.isFinite(item.amount)) throw new Error('Plaid Sandbox transaction amount is invalid.');
        safe.amount = item.amount;
    }
    const strings = ['date', 'date_modified', 'authorized_date', 'pending_transaction_id', 'account_id', 'account', 'iso_currency_code', 'currency_code', 'name', 'merchant_name', 'transaction_code', 'classification'];
    const nullableStrings = new Set(['date_modified', 'authorized_date', 'pending_transaction_id', 'iso_currency_code', 'currency_code', 'merchant_name', 'transaction_code', 'classification']);
    strings.forEach(key => {
        if (item[key] === undefined) return;
        if (item[key] === null && nullableStrings.has(key)) return;
        if (typeof item[key] !== 'string') throw new Error('Plaid Sandbox transaction contains an invalid field.');
        safe[key] = item[key];
    });
    if (item.pending !== undefined) {
        if (typeof item.pending !== 'boolean') throw new Error('Plaid Sandbox transaction contains an invalid pending flag.');
        safe.pending = item.pending;
    }
    if (item.category !== undefined && item.category !== null) {
        if (typeof item.category === 'string') safe.category = item.category;
        else if (Array.isArray(item.category) && item.category.every(value => typeof value === 'string')) safe.category = item.category.slice();
        else throw new Error('Plaid Sandbox transaction contains an invalid category.');
    }
    if (item.personal_finance_category !== undefined && item.personal_finance_category !== null) {
        const category = item.personal_finance_category;
        if (!category || typeof category !== 'object' || Array.isArray(category)) throw new Error('Plaid Sandbox transaction contains an invalid finance category.');
        const safeCategory = {};
        for (const key of ['primary', 'detailed', 'confidence_level']) {
            if (category[key] === undefined) continue;
            if (category[key] === null) continue;
            if (typeof category[key] !== 'string') throw new Error('Plaid Sandbox transaction contains an invalid finance category.');
            safeCategory[key] = category[key];
        }
        safe.personal_finance_category = safeCategory;
    }
    return safe;
}

function mutationError() {
    const error = new Error('Plaid Sandbox pagination changed.');
    error.code = TRANSACTIONS_SYNC_MUTATION;
    error.error_code = TRANSACTIONS_SYNC_MUTATION;
    return error;
}

function productNotReadyError(details) {
    const error = setupFailure('transactions-sync', details || {}, 'Sandbox Transactions data is not ready; retry the sync.');
    error.code = TRANSACTIONS_PRODUCT_NOT_READY;
    error.error_code = TRANSACTIONS_PRODUCT_NOT_READY;
    return error;
}

function safeProviderErrorCode(body) {
    const code = body && typeof body === 'object' ? text(body.error_code) : '';
    return [TRANSACTIONS_SYNC_MUTATION, TRANSACTIONS_PRODUCT_NOT_READY].includes(code) ? code : '';
}

function createSandboxTransport(options) {
    const opts = options || {};
    const baseUrl = own(opts, 'baseUrl') ? text(opts.baseUrl) : SANDBOX_ORIGIN;
    if (baseUrl !== SANDBOX_ORIGIN) throw new Error('Sandbox provider base URL must be exactly https://sandbox.plaid.com.');
    const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (typeof fetchImpl !== 'function') throw new Error('A server fetch implementation is required for Sandbox transport.');
    const timeoutMs = Number.isSafeInteger(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 30_000;
    return Object.freeze({
        async sync(request) {
            const input = request || {};
            if (!text(input.clientId) || !text(input.secret) || !text(input.accessToken)) throw new Error('Sandbox transport credentials are missing.');
            const payload = {
                client_id: text(input.clientId),
                secret: text(input.secret),
                access_token: text(input.accessToken),
                cursor: text(input.cursor)
            };
            const sensitiveValues = [payload.client_id, payload.secret, payload.access_token];
            let response;
            let body;
            let timer;
            let deadlineTimer;
            let removeAbortListener = () => {};
            const controller = typeof AbortController === 'function' ? new AbortController() : null;
            const deadlineAt = Number.isSafeInteger(input.deadlineAt) && input.deadlineAt > 0 ? input.deadlineAt : null;
            if (deadlineAt !== null && deadlineAt <= Date.now()) throw createSyncDeadlineError();
            const timeoutPromise = new Promise((resolve, reject) => {
                timer = setTimeout(() => {
                    if (controller) controller.abort();
                    const timeout = new Error('Plaid Sandbox request timed out.');
                    timeout.code = 'SANDBOX_TIMEOUT';
                    reject(timeout);
                }, timeoutMs);
            });
            const deadlinePromise = deadlineAt === null ? new Promise(() => {}) : new Promise((resolve, reject) => {
                const remaining = Math.max(1, deadlineAt - Date.now());
                deadlineTimer = setTimeout(() => {
                    if (controller) controller.abort();
                    reject(createSyncDeadlineError());
                }, remaining);
            });
            if (controller && input.signal && typeof input.signal.addEventListener === 'function') {
                const abort = () => controller.abort();
                if (input.signal.aborted) abort();
                else {
                    input.signal.addEventListener('abort', abort, { once: true });
                    removeAbortListener = () => input.signal.removeEventListener('abort', abort);
                }
            }
            try {
                const requestOptions = {
                    method: 'POST',
                    redirect: 'error',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(payload)
                };
                if (controller) {
                    requestOptions.signal = controller.signal;
                }
                try {
                    response = await Promise.race([Promise.resolve(fetchImpl(SANDBOX_SYNC_URL, requestOptions)), timeoutPromise, deadlinePromise]);
                } catch (error) {
                    if (error && error.code === SYNC_DEADLINE_EXCEEDED) throw error;
                    throw setupFailure('transactions-sync', {}, 'Plaid Sandbox request failed.');
                }
                let bodyPromise;
                try {
                    bodyPromise = response && typeof response.json === 'function' ? response.json() : Promise.reject(new Error('invalid response'));
                } catch (_) {
                    throw setupFailure('transactions-sync', { status: response && response.status, sensitiveValues }, 'Plaid Sandbox returned invalid JSON.');
                }
                try {
                    body = await Promise.race([Promise.resolve(bodyPromise), timeoutPromise, deadlinePromise]);
                } catch (error) {
                    if (error && error.code === SYNC_DEADLINE_EXCEEDED) throw error;
                    if (error && error.code === 'SANDBOX_TIMEOUT') throw setupFailure('transactions-sync', { status: response && response.status, sensitiveValues }, 'Plaid Sandbox request failed.');
                    throw setupFailure('transactions-sync', { status: response && response.status, sensitiveValues }, 'Plaid Sandbox returned invalid JSON.');
                }
            } finally {
                if (timer) clearTimeout(timer);
                if (deadlineTimer) clearTimeout(deadlineTimer);
                removeAbortListener();
            }
            if (!response || response.ok !== true) {
                if (safeProviderErrorCode(body) === TRANSACTIONS_SYNC_MUTATION) throw mutationError();
                if (safeProviderErrorCode(body) === TRANSACTIONS_PRODUCT_NOT_READY) throw productNotReadyError(setupErrorDetails(body, response, sensitiveValues));
                throw setupFailure('transactions-sync', setupErrorDetails(body, response, sensitiveValues), 'Plaid Sandbox request failed.');
            }
            return safeSyncResponse(body, { ...setupErrorDetails(body, response, sensitiveValues), initialSync: !text(input.cursor) });
        }
    });
}

function setupResponseObject(body) {
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
}

function safeSetupAccounts(body) {
    const source = setupResponseObject(body);
    if (!source || !Array.isArray(source.accounts)) throw new Error('Sandbox account lookup returned an invalid response.');
    return source.accounts.map(account => {
        if (!account || typeof account !== 'object' || Array.isArray(account) || typeof account.account_id !== 'string' || !text(account.account_id)) {
            throw new Error('Sandbox account lookup returned an invalid account.');
        }
        const safe = {};
        for (const key of ['name', 'official_name', 'type', 'subtype']) {
            if (account[key] === undefined || account[key] === null) continue;
            if (typeof account[key] !== 'string') throw new Error('Sandbox account lookup returned an invalid account.');
            safe[key] = account[key];
        }
        // Account IDs are required for the in-memory mapping, but are kept
        // non-enumerable so accidental JSON/log output does not expose them.
        Object.defineProperty(safe, 'account_id', { value: text(account.account_id), enumerable: false, writable: false });
        return Object.freeze(safe);
    });
}

function createSandboxSetupTransport(options) {
    const opts = options || {};
    const baseUrl = own(opts, 'baseUrl') ? text(opts.baseUrl) : SANDBOX_ORIGIN;
    if (baseUrl !== SANDBOX_ORIGIN) throw new Error('Sandbox provider base URL must be exactly https://sandbox.plaid.com.');
    if (opts.allowNetwork !== true) throw new Error('Sandbox setup network requires explicit opt-in.');
    const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (typeof fetchImpl !== 'function') throw new Error('A server fetch implementation is required for Sandbox transport.');
    const timeoutMs = Number.isSafeInteger(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 30_000;
    const post = async (url, payload, stage) => {
        let response;
        let body;
        const sensitiveValues = [payload && payload.client_id, payload && payload.secret, payload && payload.public_token, payload && payload.access_token];
        let timer;
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timeoutPromise = new Promise((resolve, reject) => {
            timer = setTimeout(() => {
                if (controller) controller.abort();
                const timeout = new Error('Plaid Sandbox request timed out.');
                timeout.code = 'SANDBOX_TIMEOUT';
                reject(timeout);
            }, timeoutMs);
        });
        try {
            const requestOptions = {
                method: 'POST',
                redirect: 'error',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload)
            };
            if (controller) requestOptions.signal = controller.signal;
            try {
                response = await Promise.race([Promise.resolve(fetchImpl(url, requestOptions)), timeoutPromise]);
            } catch (_) {
                throw setupFailure(stage, {});
            }
            let bodyPromise;
            try {
                bodyPromise = response && typeof response.json === 'function' ? response.json() : Promise.reject(new Error('invalid response'));
            } catch (_) {
                throw setupFailure(stage, { status: response && response.status, sensitiveValues }, 'Sandbox setup returned invalid JSON.');
            }
            try {
                body = await Promise.race([Promise.resolve(bodyPromise), timeoutPromise]);
            } catch (error) {
                if (error && error.code === 'SANDBOX_TIMEOUT') throw setupFailure(stage, { status: response && response.status, sensitiveValues });
                throw setupFailure(stage, { status: response && response.status, sensitiveValues }, 'Sandbox setup returned invalid JSON.');
            }
        } finally {
            if (timer) clearTimeout(timer);
        }
        if (!response || response.ok !== true) {
            const details = setupErrorDetails(body, response, sensitiveValues);
            if (details.code === TRANSACTIONS_PRODUCT_NOT_READY) {
                throw setupFailure(stage, details, 'Sandbox Transactions data is not ready; retry the sync.');
            }
            throw setupFailure(stage, details);
        }
        return setupResponseObject(body) || (() => { throw setupFailure(stage, {}, 'Sandbox setup returned an invalid response.'); })();
    };
    return Object.freeze({
        async createPublicToken(input) {
            const value = input || {};
            if (!text(value.clientId) || !text(value.secret) || !text(value.institutionId)) throw new Error('Sandbox setup inputs are incomplete.');
            const username = text(value.overrideUsername) || 'user_good';
            const password = text(value.overridePassword) || 'pass_good';
            const body = await post(SANDBOX_PUBLIC_TOKEN_URL, {
                client_id: text(value.clientId),
                secret: text(value.secret),
                institution_id: text(value.institutionId),
                initial_products: ['transactions'],
                options: {
                    override_username: username,
                    override_password: password
                }
            }, 'create-public-token');
            const publicToken = text(body.public_token);
            if (!publicToken) throw setupFailure('create-public-token', {}, 'Sandbox setup returned no public token.');
            return { publicToken };
        },
        async exchangePublicToken(input) {
            const value = input || {};
            if (!text(value.clientId) || !text(value.secret) || !text(value.publicToken)) throw new Error('Sandbox setup inputs are incomplete.');
            const body = await post(ITEM_EXCHANGE_URL, {
                client_id: text(value.clientId),
                secret: text(value.secret),
                public_token: text(value.publicToken)
            }, 'exchange-public-token');
            const accessToken = text(body.access_token);
            if (!accessToken) throw setupFailure('exchange-public-token', {}, 'Sandbox setup returned no access token.');
            return { accessToken, itemId: text(body.item_id) };
        },
        async getAccounts(input) {
            const value = input || {};
            if (!text(value.clientId) || !text(value.secret) || !text(value.accessToken)) throw new Error('Sandbox setup inputs are incomplete.');
            const body = await post(ACCOUNTS_GET_URL, {
                client_id: text(value.clientId),
                secret: text(value.secret),
                access_token: text(value.accessToken)
            }, 'accounts-get');
            try {
                return { accounts: safeSetupAccounts(body) };
            } catch (_) {
                throw setupFailure('accounts-get', {}, 'Sandbox account lookup returned an invalid response.');
            }
        }
    });
}

async function createSandboxSetup(options) {
    const opts = options || {};
    if (opts.allowNetwork !== true) throw new Error('Sandbox setup network requires explicit opt-in.');
    const clientId = text(opts.clientId);
    const secret = text(opts.secret);
    const institutionId = text(opts.institutionId);
    if (!clientId || !secret || !institutionId) throw new Error('Sandbox setup inputs are incomplete.');
    const transportOptions = {
        allowNetwork: true,
        fetchImpl: opts.fetchImpl,
        timeoutMs: opts.timeoutMs,
        ...(own(opts, 'baseUrl') ? { baseUrl: opts.baseUrl } : {})
    };
    const transport = opts.transport || createSandboxSetupTransport(transportOptions);
    if (!transport || typeof transport.createPublicToken !== 'function' || typeof transport.exchangePublicToken !== 'function' || typeof transport.getAccounts !== 'function') {
        throw new Error('Sandbox setup transport is incomplete.');
    }
    const created = await invokeSetupStage('create-public-token', () => transport.createPublicToken({
        clientId,
        secret,
        institutionId,
        overrideUsername: opts.overrideUsername,
        overridePassword: opts.overridePassword
    }));
    const publicToken = text(created && created.publicToken);
    if (!publicToken) throw setupFailure('create-public-token', {}, 'Sandbox setup returned no public token.');
    const exchanged = await invokeSetupStage('exchange-public-token', () => transport.exchangePublicToken({ clientId, secret, publicToken }));
    const accessToken = text(exchanged && exchanged.accessToken);
    if (!accessToken) throw setupFailure('exchange-public-token', {}, 'Sandbox setup returned no access token.');
    const accountResult = await invokeSetupStage('accounts-get', () => transport.getAccounts({ clientId, secret, accessToken }));
    let accounts;
    try {
        accounts = safeSetupAccounts(accountResult);
    } catch (_) {
        throw setupFailure('accounts-get', {}, 'Sandbox account lookup returned an invalid response.');
    }
    const result = { accounts };
    Object.defineProperties(result, {
        publicToken: { value: publicToken, enumerable: false, writable: false },
        accessToken: { value: accessToken, enumerable: false, writable: false },
        itemId: { value: text(exchanged && exchanged.itemId), enumerable: false, writable: false }
    });
    return Object.freeze(result);
}

function createSandboxProvider(options) {
    const opts = options || {};
    const config = opts.config || createSandboxConfig(opts);
    if (config.enabled !== true) return new reviewApi.DisabledProviderAdapter('Plaid Sandbox sync is disabled until the user explicitly enables the server runner.');
    const transport = opts.transport || createSandboxTransport({ baseUrl: config.baseUrl, fetchImpl: opts.fetchImpl });
    if (!transport || typeof transport.sync !== 'function') throw new Error('Sandbox transport must expose sync(request).');
    return new backendApi.PlaidTransactionsSyncAdapter({
        accountMap: config.accountMap,
        ignoredAccountIds: config.ignoredAccountIds,
        preserveError: preserveSandboxSyncError,
        client: {
            sync: payload => {
                const request = {
                    clientId: config.clientId,
                    secret: config.secret,
                    accessToken: payload && payload.access_token,
                    cursor: payload && payload.cursor
                };
                if (payload && payload.deadlineAt !== undefined) request.deadlineAt = payload.deadlineAt;
                if (payload && payload.signal !== undefined) request.signal = payload.signal;
                return transport.sync(request);
            }
        },
        maxPages: opts.maxPages,
        maxRetries: opts.maxRetries,
        maxMutationRestarts: opts.maxMutationRestarts,
        backoffMs: opts.backoffMs,
        sleep: opts.sleep,
        clock: opts.clock,
        resolveRemoved: opts.resolveRemoved,
        classify: opts.classify
    });
}

function createSandboxBudgetService(options) {
    const opts = options || {};
    // Injected providers are the credential-free test seam; only the real
    // Sandbox provider path requires the user-supplied secret inputs.
    const config = opts.config || createSandboxConfig({ ...opts, enabled: opts.syncEnabled === true && !opts.provider });
    const provider = opts.provider || createSandboxProvider({ ...opts, config });
    return createBudgetService({
        ...opts,
        provider,
        syncEnabled: opts.syncEnabled === true,
        cutoverDate: own(opts, 'cutoverDate') ? opts.cutoverDate : config.cutoverDate,
        accountAliases: appConfig.legacyAccountAliases,
        connectionResolver: opts.connectionResolver || (async connection => {
            if (!config.connectionKey || text(connection) !== config.connectionKey) throw new Error('Sandbox connection key does not match the configured provider connection.');
            return { accessToken: config.accessToken };
        })
    });
}

function sanitizeRunnerError(error) {
    if (error && error[SETUP_ERROR_BRAND] === true && error.setupDiagnostic && typeof error.setupDiagnostic === 'object') {
        const diagnostic = error.setupDiagnostic;
        if (!SETUP_ERROR_STAGES.has(diagnostic.stage)) return 'Sandbox runner failed without exposing provider or credential details.';
        const details = [diagnostic.stage === 'transactions-sync' ? 'Sandbox Transactions Sync failed at transactions-sync.' : `Sandbox setup failed at ${diagnostic.stage}.`];
        if (Number.isInteger(diagnostic.status) && diagnostic.status >= 100 && diagnostic.status <= 599) details.push(`HTTP ${diagnostic.status}.`);
        if (SAFE_PLAID_ERROR_TYPES.has(diagnostic.type)) details.push(`type=${diagnostic.type}.`);
        if (SAFE_PLAID_ERROR_CODES.has(diagnostic.code)) details.push(`code=${diagnostic.code}.`);
        if (typeof diagnostic.request_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(diagnostic.request_id)) details.push(`request_id=${diagnostic.request_id}.`);
        return details.join(' ');
    }
    const message = text(error && error.message);
    const safeMessages = new Set([
        'Sandbox client ID is required.',
        'Sandbox secret is required.',
        'Sandbox access token is required.',
        'Sandbox connection key is required.',
        'Sandbox provider account mapping is required.',
        'Sandbox provider account mapping contains an unsupported display name.',
        'Sandbox first-sync cutover date must be a valid YYYY-MM-DD date.',
        'Sandbox provider base URL must be exactly https://sandbox.plaid.com.',
        'A server fetch implementation is required for Sandbox transport.',
        'Sandbox secret input requires an interactive TTY.',
        'Sandbox secret input could not be initialized.',
        'Sandbox secret input contains unsupported terminal controls.',
        'Sandbox provider account map must be valid JSON.',
        'Sandbox setup network requires explicit opt-in.',
        'Sandbox setup inputs are incomplete.',
        'Sandbox setup request failed.',
        'Sandbox setup returned invalid JSON.',
        'Sandbox setup returned an invalid response.',
        'Sandbox setup returned no public token.',
        'Sandbox setup returned no access token.',
        'Sandbox account lookup returned an invalid response.',
        'Sandbox account lookup returned an invalid account.',
        'Sandbox transport credentials are missing.',
        'Sandbox setup transport is incomplete.',
        'Sandbox account mapping choices must be valid JSON.',
        'Sandbox account mapping choices must match the numbered accounts.',
        'Sandbox setup returned no accounts to map.',
        'Plaid Sandbox request failed.',
        'Plaid Sandbox returned invalid JSON.',
        'Plaid Sandbox returned an incomplete Transactions Sync response.',
        'Plaid sync initial response is empty; retry the same Item.',
        'Plaid sync exceeded its bounded execution window.',
        'Plaid Sandbox returned a provider error.',
        'Plaid Sandbox returned an invalid transaction observation.',
        'Plaid Sandbox transaction is missing an identifier.',
        'Plaid Sandbox transaction amount is invalid.',
        'Plaid Sandbox transaction contains an invalid field.',
        'Plaid Sandbox transaction contains an invalid pending flag.',
        'Plaid Sandbox transaction contains an invalid category.',
        'Plaid Sandbox transaction contains an invalid finance category.',
        'Plaid sync provider request failed.',
        'Plaid sync changed during pagination too many times.',
        'Plaid sync returned an incomplete page.',
        'Plaid sync cursor did not advance.',
        'Plaid sync exceeded the page limit.',
        'Plaid sync did not complete.',
        'Plaid sync requires a server-side access token resolver.',
        'Plaid sync cutover date is invalid.',
        'Plaid ignored account IDs must be an array.',
        'Plaid ignored account IDs must be non-empty strings.',
        'Plaid ignored account IDs must not overlap mapped accounts.',
        'Plaid transaction is missing transaction_id.',
        'Removed provider transaction could not be hydrated from accepted history.',
        'Plaid account name mapping is not configured.',
        'Plaid transaction currency is not supported; USD is required.',
        'Plaid transaction account is not mapped.',
        'Plaid transaction amount is invalid.',
        'Provider transaction is missing a reviewable date.',
        'Sandbox Transactions data is not ready; retry the sync.',
        'Plaid sync data is not ready; retry the sync.',
        'Unsupported Sandbox runner option.'
    ]);
    if (safeMessages.has(message)) return message;
    return 'Sandbox runner failed without exposing provider or credential details.';
}

module.exports = {
    SANDBOX_ORIGIN,
    SANDBOX_SYNC_URL,
    SANDBOX_PUBLIC_TOKEN_URL,
    ITEM_EXCHANGE_URL,
    ACCOUNTS_GET_URL,
    TRANSACTIONS_SYNC_MUTATION,
    TRANSACTIONS_PRODUCT_NOT_READY,
    INITIAL_SYNC_PENDING,
    SYNC_DEADLINE_EXCEEDED,
    DEFAULT_SYNC_DEADLINE_MS,
    createSandboxConfig,
    createSandboxTransport,
    createSandboxSetupTransport,
    createSandboxSetup,
    createSandboxProvider,
    createSandboxBudgetService,
    isTrustedSyncDiagnostic,
    safeSandboxDiagnostic,
    safeSyncDiagnostic,
    safeStaticSyncDiagnostic,
    isTransientSyncFailure,
    createSyncDeadlineError,
    sanitizeRunnerError
};

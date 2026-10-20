/*
 * Production transport and provider lifecycle composition.
 *
 * This module deliberately keeps Firebase Functions, Secret Manager and the
 * Plaid SDK at the edge. The review backend remains the credential-free
 * contract used by the local emulator tests. Production secrets are resolved
 * only for the server-side provider call and are never written to Firestore,
 * returned to the browser, or included in error messages.
 */
'use strict';

const crypto = require('node:crypto');
const backendApi = require('./transaction-backend.js');
const { createBudgetService } = require('./transaction-service.js');

const PRODUCTION_ORIGIN = 'https://zmstiles-dev.github.io';
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
// Exchange receipts are retained for idempotence and recovery. They are never
// pruned automatically because a started or pending exchange may still be the
// only durable record that prevents a second Item. A bounded ledger rejects a
// new request once it is full and leaves every existing receipt untouched.
const MAX_EXCHANGE_LEDGER_ENTRIES = 64;
const HOUSEHOLD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const UID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const EMAIL_PATTERN = /^[a-z0-9._%+-]+@[a-z0-9.-]+$/;
const SAFE_LINK_ERROR_MESSAGES = new Set([
    'Bearer authentication is required.',
    'Authenticated user is not an existing app user.',
    'Production app-user authorization is not configured.',
    'Authenticated household membership is not configured.',
    'User is not a member of this household.',
    'A production Firebase Admin authorization client is required.',
    'A production Secret Manager client is required.',
    'Production provider configuration is incomplete.',
    'Provider connection key is not configured.',
    'Provider connection is not configured for this household.',
    'Provider connection is not configured.',
    'Provider institution is not configured.',
    'Provider Link operations are disabled by server configuration.',
    'User is not authorized for this provider connection.',
    'A Link token is required.',
    'A public token is required.',
    'A Link exchange request ID is required.',
    'Link exchange is already in progress; retry with the same request ID.',
    'Link exchange ledger is full; reconcile before starting another exchange.',
    'Link exchange requires reconciliation before retrying.',
    'Link token creation is already in progress; retry after the existing session is reconciled.',
    'Link token session is already reserved; continue the existing session.',
    'Link token session requires reconciliation before retrying.',
    'Link exchange cannot replace an existing Item.',
    'Link exchange is not pending.',
    'Link account bindings are required.',
    'Link account bindings contain an unknown provider account ID.',
    'Link account bindings contain an unsupported display account.',
    'Link account bindings must cover every non-ignored provider account.',
    'Provider account IDs must be stable non-empty strings.',
    'Provider account type or currency is not configured.',
    'A provider account mapping is not configured.',
    'Provider account mapping is invalid.',
    'Cleanup is not authorized.',
    'Cleanup is not configured.',
    'Cleanup target preconditions are not met.',
    'Cleanup is already in progress; reconcile before retrying.',
    'Cleanup requires reconciliation before retrying.',
    'Provider cleanup failed.',
    'Provider item does not match cleanup target.',
    'Sync activation is not ready.',
    'Sync settings are not configured.',
    'Sync settings revision is required.',
    'Sync settings changed since they were loaded.',
    'Cutoff date must be a real YYYY-MM-DD date.',
    'Cutoff date cannot be in the future.',
    'Cutoff date can only move forward; earlier dates require an explicit backfill operation.',
    'Plaid Link returned an invalid response.',
    'Plaid Link request failed.',
    'Secret storage failed.',
    'Secret resolution failed.',
    'Request body must be valid JSON.',
    'Request body is too large.',
    'CORS origin is not allowed.'
]);

function text(value) {
    return String(value ?? '').trim();
}

function validHouseholdId(value) {
    const normalized = text(value);
    return HOUSEHOLD_ID_PATTERN.test(normalized);
}

function validUid(value) {
    const normalized = text(value);
    return UID_PATTERN.test(normalized);
}

function validEmail(value) {
    const normalized = text(value);
    return EMAIL_PATTERN.test(normalized);
}

function validDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(value));
    if (!match) return false;
    const check = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return check.getUTCFullYear() === Number(match[1]) && check.getUTCMonth() + 1 === Number(match[2]) && check.getUTCDate() === Number(match[3]);
}

function validVaultReferenceName(value) {
    return typeof value === 'string' && /^projects\/[A-Za-z0-9._-]+\/secrets\/[A-Za-z0-9_-]+$/.test(value);
}

function validVaultReferenceVersion(value) {
    return typeof value === 'string' && /^projects\/[A-Za-z0-9._-]+\/secrets\/[A-Za-z0-9_-]+\/versions\/[1-9][0-9]*$/.test(value);
}

function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function own(value, key) {
    return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function safeKey(value, label) {
    const key = text(value);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(key) || key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new Error(`${label || 'Provider connection key'} is not configured.`);
    }
    return key;
}

function requestId(value, label) {
    const id = text(value);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error(`${label || 'A Link exchange request ID'} is required.`);
    return id;
}

function digest(value) {
    return crypto.createHash('sha256').update(text(value)).digest('hex');
}

function cleanupPlanDigest(plan) {
    const value = plan || {};
    return digest(stableCanonical({
        targetKey: text(value.targetKey),
        targetItemId: text(value.targetItemId),
        targetExchangeId: text(value.targetExchangeId),
        targetSecretName: text(value.targetSecretName),
        targetSecretVersion: text(value.targetSecretVersion),
        targetInstitution: text(value.targetInstitution),
        finalKey: text(value.finalKey),
        finalItemId: text(value.finalItemId),
        finalInstitution: text(value.finalInstitution),
        targetOwnerUid: text(value.targetOwnerUid),
        finalOwnerUid: text(value.finalOwnerUid),
        replacementOwnerUid: text(value.replacementOwnerUid),
        finalSecretName: text(value.finalSecretName),
        finalSecretVersion: text(value.finalSecretVersion),
        finalMappingHash: text(value.finalMappingHash),
        householdId: text(value.householdId)
    }));
}

function stableCanonical(value) {
    if (Array.isArray(value)) return `[${value.map(stableCanonical).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableCanonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function mappingMetadataDigest(connectionKey, connection) {
    const value = connection || {};
    const accounts = Array.isArray(value.accounts)
        ? value.accounts.map(account => {
            const balances = account && account.balances && typeof account.balances === 'object' ? account.balances : {};
            const currency = text(account && (account.currency || account.iso_currency_code || account.isoCurrencyCode || balances.iso_currency_code || balances.isoCurrencyCode || balances.currency_code)).toUpperCase();
            return {
                accountId: text(account && (account.accountId || account.account_id)),
                type: text(account && account.type).toLowerCase(),
                subtype: text(account && account.subtype).toLowerCase(),
                currency
            };
        }).sort((left, right) => left.accountId.localeCompare(right.accountId))
        : [];
    const accountMap = value.accountMap && typeof value.accountMap === 'object' && !Array.isArray(value.accountMap)
        ? Object.keys(value.accountMap).sort().map(accountId => [text(accountId), text(value.accountMap[accountId])])
        : [];
    const policyRevision = Number.isSafeInteger(value.mappingPolicyRevision) && value.mappingPolicyRevision > 0 ? value.mappingPolicyRevision : 1;
    return digest(stableCanonical({
        connectionKey: text(connectionKey),
        itemId: text(value.itemId),
        ownerUid: text(value.ownerUid),
        householdId: text(value.householdId),
        vaultReference: {
            secretName: text(value.secretName),
            secretVersion: text(value.secretVersion)
        },
        policyRevision,
        accounts,
        aliases: accountMap
    }));
}

function exactConnectionKeys(value, expected) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function stableMappingIsValid(key, record, policy) {
    const accounts = Array.isArray(record && record.accounts) ? record.accounts : [];
    const accountMap = record && record.accountMap && typeof record.accountMap === 'object' && !Array.isArray(record.accountMap) ? record.accountMap : null;
    if (!accountMap || !accounts.length || policy && Number.isSafeInteger(policy.expectedCount) && accounts.length !== policy.expectedCount) return false;
    const aliases = policy && policy.aliases && typeof policy.aliases === 'object' ? policy.aliases : null;
    const seen = new Set();
    const seenAliases = new Set();
    for (const account of accounts) {
        const balances = account && account.balances && typeof account.balances === 'object' ? account.balances : {};
        const id = text(account && (account.accountId || account.account_id));
        const type = text(account && account.type).toLowerCase();
        const subtype = text(account && account.subtype).toLowerCase();
        const currency = text(account && (account.currency || account.iso_currency_code || balances.iso_currency_code || balances.currency_code)).toUpperCase();
        const alias = text(accountMap[id]);
        if (!id || seen.has(id) || seenAliases.has(alias) || !alias || !type || !subtype || currency !== 'USD') return false;
        if (aliases && (!aliases[alias] || text(aliases[alias].type).toLowerCase() !== type || text(aliases[alias].subtype).toLowerCase() !== subtype || text(aliases[alias].currency).toUpperCase() !== currency)) return false;
        seen.add(id);
        seenAliases.add(alias);
    }
    return Object.keys(accountMap).length === seen.size && Object.keys(accountMap).every(id => seen.has(id));
}

function completedExchangeMatchesRecord(record) {
    const value = record || {};
    const ledger = value.exchangeLedger;
    if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) return false;
    return Object.values(ledger).some(entry => {
        const result = entry && entry.status === 'complete' && entry.result;
        return !!result && text(result.itemId) === text(value.itemId)
            && text(result.secretName) === text(value.secretName)
            && text(result.secretVersion) === text(value.secretVersion);
    });
}

function createProtectedSyncReadiness(options) {
    const opts = options || {};
    if (!opts.db || typeof opts.db.collection !== 'function') throw new Error('A Firestore sync readiness client is required.');
    const householdId = text(opts.householdId);
    const cutoffDate = text(opts.cutoverDate || '2026-10-09');
    const requiredKeys = [...new Set((opts.requiredConnectionKeys || ['chase', 'capital-one']).map(text).filter(Boolean))].sort();
    const expectedInstitutions = opts.expectedInstitutions && typeof opts.expectedInstitutions === 'object' ? opts.expectedInstitutions : {};
    const configCollection = text(opts.configCollection || 'protectedAppConfig');
    const configDocument = text(opts.configDocument || 'transactionService');
    const connectionCollection = text(opts.connectionsCollection || 'protectedConnections');
    const mappingPolicies = opts.mappingPolicies && typeof opts.mappingPolicies === 'object' ? opts.mappingPolicies : {};
    if (!validHouseholdId(householdId) || !requiredKeys.length || !requiredKeys.every(safeKey) || !validDate(cutoffDate)) throw new Error('Sync activation configuration is incomplete.');
    return async function readSyncReadiness(auth, connectionKey) {
        const actor = auth || {};
        if (!validUid(actor.uid) || !validEmail(actor.email) || text(actor.householdId) !== householdId) throw new Error('Sync activation is not ready.');
        const configSnapshot = await opts.db.collection(configCollection).doc(configDocument).get();
        const config = configSnapshot && configSnapshot.exists ? configSnapshot.data() || {} : {};
        const activation = config.syncActivation;
        if (config.allowed !== true || text(config.householdId) !== householdId || !activation || typeof activation !== 'object' || Array.isArray(activation) || activation.enabled !== true) return Object.freeze({ ready: false, revision: null, cutoffDate, cutoffRevision: null, connectionKeys: requiredKeys });
        if (text(activation.cutoffDate) !== cutoffDate || !Number.isSafeInteger(activation.revision) || activation.revision < 1 || !exactConnectionKeys(activation.connections, requiredKeys)) throw new Error('Sync activation is not ready.');
        const runtime = config.syncSettings;
        const runtimeCutoff = runtime === undefined || runtime === null ? cutoffDate : text(runtime.cutoffDate);
        const runtimeRevision = runtime === undefined || runtime === null ? activation.revision : runtime.revision;
        if (runtime !== undefined && runtime !== null && (!runtime || typeof runtime !== 'object' || Array.isArray(runtime) || !validDate(runtimeCutoff) || runtimeCutoff < cutoffDate || !Number.isSafeInteger(runtimeRevision) || runtimeRevision < 1)) throw new Error('Sync activation is not ready.');
        if (connectionKey && !requiredKeys.includes(text(connectionKey))) throw new Error('Sync connection is not activated.');
        const proofs = activation.connections;
        const records = {};
        for (const key of requiredKeys) {
            const proof = proofs[key];
            const expectedInstitution = text(expectedInstitutions[key]);
            if (!proof || typeof proof !== 'object' || Array.isArray(proof) || text(proof.expectedInstitution) !== expectedInstitution || !/^ins_[A-Za-z0-9_-]{2,64}$/.test(expectedInstitution) || !safeKey(key) || !validUid(proof.ownerUid) || connectionKey && text(proof.ownerUid) !== text(actor.uid) || !validHouseholdId(proof.householdId) || text(proof.householdId) !== householdId || !safeKey(proof.itemId) || !/^[a-f0-9]{64}$/.test(text(proof.mappingHash)) || !Number.isSafeInteger(proof.policyRevision) || proof.policyRevision < 1) throw new Error('Sync activation is not ready.');
            const snapshot = await opts.db.collection(connectionCollection).doc(key).get();
            const record = snapshot && snapshot.exists ? snapshot.data() || {} : {};
            const reservation = record.linkReservation;
            const reservationValid = reservation === undefined || reservation === null || reservation && reservation.status === 'issued' && completedExchangeMatchesRecord(record);
            if (!validUid(record.ownerUid) || text(record.ownerUid) !== text(proof.ownerUid) || connectionKey && text(record.ownerUid) !== text(actor.uid) || text(record.householdId) !== householdId || record.enabled !== true || text(record.itemId) !== text(proof.itemId) || !validVaultReferenceName(record.secretName) || !validVaultReferenceVersion(record.secretVersion) || !stableMappingIsValid(key, record, mappingPolicies[key]) || record.pendingExchange !== undefined || !reservationValid || Object.values(record.exchangeLedger || {}).some(entry => entry && ['started', 'pending-binding', 'needs-reconciliation'].includes(entry.status)) || (Number.isSafeInteger(record.mappingPolicyRevision) && record.mappingPolicyRevision > 0 ? record.mappingPolicyRevision : 1) !== proof.policyRevision || mappingMetadataDigest(key, record) !== text(proof.mappingHash)) throw new Error('Sync activation is not ready.');
            records[key] = { itemId: text(record.itemId), mappingHash: text(proof.mappingHash), expectedInstitution };
        }
        return Object.freeze({ ready: true, revision: activation.revision, cutoffDate: runtimeCutoff, cutoffRevision: runtimeRevision, connectionKeys: requiredKeys, connections: records });
    };
}

function createProtectedDisconnectPlan(options) {
    const opts = options || {};
    if (!opts.db || typeof opts.db.collection !== 'function') throw new Error('A Firestore cleanup client is required.');
    const householdId = text(opts.householdId);
    const configCollection = text(opts.configCollection || 'protectedAppConfig');
    const configDocument = text(opts.configDocument || 'transactionService');
    const connectionCollection = text(opts.connectionsCollection || 'protectedConnections');
    if (!validHouseholdId(householdId)) throw new Error('Cleanup configuration is incomplete.');
    return async function readDisconnectPlan(auth, requestedKey) {
        const actor = auth || {};
        if (!validUid(actor.uid) || !validEmail(actor.email) || text(actor.householdId) !== householdId) throw new Error('Cleanup is not authorized.');
        const configSnapshot = await opts.db.collection(configCollection).doc(configDocument).get();
        const config = configSnapshot && configSnapshot.exists ? configSnapshot.data() || {} : {};
        const plan = config.cleanupPlan;
        if (!plan || typeof plan !== 'object' || Array.isArray(plan) || plan.enabled !== true || text(plan.householdId) !== householdId) throw new Error('Cleanup is not configured.');
        const targetKey = text(plan.targetConnectionKey);
        if (!safeKey(targetKey) || (requestedKey && text(requestedKey) !== targetKey) || !safeKey(plan.finalConnectionKey) || targetKey === text(plan.finalConnectionKey) || !safeKey(plan.targetItemId) || !safeKey(plan.finalItemId) || text(plan.targetItemId) === text(plan.finalItemId) || !/^ins_[A-Za-z0-9_-]{2,64}$/.test(text(plan.targetInstitution)) || !/^ins_[A-Za-z0-9_-]{2,64}$/.test(text(plan.finalInstitution)) || !requestId(plan.targetExchangeId, 'Cleanup exchange ID') || !validVaultReferenceName(plan.targetSecretName) || !validVaultReferenceVersion(plan.targetSecretVersion) || !validVaultReferenceName(plan.finalSecretName) || !validVaultReferenceVersion(plan.finalSecretVersion) || !validUid(plan.targetOwnerUid) || !validUid(plan.finalOwnerUid) || !validUid(plan.replacementOwnerUid) || text(plan.finalOwnerUid) !== text(plan.replacementOwnerUid) || !/^[a-f0-9]{64}$/.test(text(plan.finalMappingHash))) throw new Error('Cleanup is not configured.');
        const targetSnapshot = await opts.db.collection(connectionCollection).doc(targetKey).get();
        const finalSnapshot = await opts.db.collection(connectionCollection).doc(text(plan.finalConnectionKey)).get();
        const target = targetSnapshot && targetSnapshot.exists ? targetSnapshot.data() || {} : {};
        const finalized = finalSnapshot && finalSnapshot.exists ? finalSnapshot.data() || {} : {};
        const forbiddenFinalizedFields = ['itemId', 'accounts', 'accountMap', 'secretName', 'secretVersion'];
        const resolvedPlan = { targetKey, targetItemId: text(plan.targetItemId), targetInstitution: text(plan.targetInstitution), targetExchangeId: text(plan.targetExchangeId), targetOwnerUid: text(plan.targetOwnerUid), targetSecretName: text(plan.targetSecretName), targetSecretVersion: text(plan.targetSecretVersion), finalKey: text(plan.finalConnectionKey), finalItemId: text(plan.finalItemId), finalInstitution: text(plan.finalInstitution), finalOwnerUid: text(plan.finalOwnerUid), replacementOwnerUid: text(plan.replacementOwnerUid), finalSecretName: text(plan.finalSecretName), finalSecretVersion: text(plan.finalSecretVersion), finalMappingHash: text(plan.finalMappingHash), householdId, configCollection, configDocument, connectionCollection };
        resolvedPlan.cleanupDigest = cleanupPlanDigest(resolvedPlan);
        if (!cleanupStateValid(config, target, finalized, resolvedPlan, actor, householdId)) throw new Error('Cleanup target preconditions are not met.');
        return Object.freeze(resolvedPlan);
    };
}

function cleanupStateValid(config, target, finalized, plan, auth, householdId) {
    const cleanup = config && config.cleanupPlan;
    const activation = config && config.syncActivation;
    const forbiddenFinalizedFields = ['itemId', 'accounts', 'accountMap', 'secretName', 'secretVersion'];
    const ledger = target && target.exchangeLedger && target.exchangeLedger[plan.targetExchangeId];
    return !!config && config.allowed === true && text(config.householdId) === householdId
        && cleanup && cleanup.enabled === true && text(cleanup.householdId) === householdId
        && text(cleanup.targetConnectionKey) === plan.targetKey && text(cleanup.targetItemId) === plan.targetItemId
        && text(cleanup.targetExchangeId) === plan.targetExchangeId && text(cleanup.targetSecretName) === plan.targetSecretName && text(cleanup.targetSecretVersion) === plan.targetSecretVersion
        && text(cleanup.targetInstitution) === plan.targetInstitution && text(cleanup.targetOwnerUid) === plan.targetOwnerUid && text(cleanup.finalConnectionKey) === plan.finalKey && text(cleanup.finalItemId) === plan.finalItemId
        && text(cleanup.finalInstitution) === plan.finalInstitution && text(cleanup.finalOwnerUid) === plan.finalOwnerUid && text(cleanup.replacementOwnerUid) === plan.replacementOwnerUid
        && text(cleanup.finalSecretName) === plan.finalSecretName && text(cleanup.finalSecretVersion) === plan.finalSecretVersion && text(cleanup.finalMappingHash) === plan.finalMappingHash
        && (!activation || activation.enabled !== true)
        && !!target && text(target.ownerUid) === plan.targetOwnerUid && text(target.ownerUid) === text(auth && auth.uid) && text(target.householdId) === householdId
        && !forbiddenFinalizedFields.some(field => Object.prototype.hasOwnProperty.call(target, field))
        && target.pendingExchange && typeof target.pendingExchange === 'object'
        && text(target.pendingExchange.itemId) === plan.targetItemId && text(target.pendingExchange.exchangeId) === plan.targetExchangeId
        && (!target.pendingExchange.institutionId || text(target.pendingExchange.institutionId) === plan.targetInstitution)
        && text(target.pendingExchange.secretName) === plan.targetSecretName && text(target.pendingExchange.secretVersion) === plan.targetSecretVersion
        && validVaultReferenceName(target.pendingExchange.secretName) && validVaultReferenceVersion(target.pendingExchange.secretVersion)
        && ledger && ledger.status === 'pending-binding' && text(ledger.itemId) === plan.targetItemId
        && text(ledger.secretVersion) === text(target.pendingExchange.secretVersion)
        && !!finalized && validUid(finalized.ownerUid) && text(finalized.householdId) === householdId
        && text(finalized.itemId) === plan.finalItemId && text(finalized.ownerUid) === text(plan.finalOwnerUid)
        && text(finalized.secretName) === plan.finalSecretName && text(finalized.secretVersion) === plan.finalSecretVersion
        && mappingMetadataDigest(plan.finalKey, finalized) === plan.finalMappingHash;
}

function maxBodyBytes(value) {
    return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_MAX_BODY_BYTES;
}

function bodyValue(request) {
    if (!request || typeof request !== 'object') return undefined;
    if (own(request, 'body')) return request.body;
    if (own(request, 'rawBody')) return request.rawBody;
    return undefined;
}

function parseBodyValue(value, limit) {
    if (value === undefined || value === null || value === '') return {};
    let raw;
    if (Buffer.isBuffer(value)) raw = value.toString('utf8');
    else if (typeof value === 'string') raw = value;
    else if (typeof value === 'object') {
        const serialized = JSON.stringify(value);
        if (Buffer.byteLength(serialized, 'utf8') > limit) throw new Error('Request body is too large.');
        return value;
    } else throw new Error('Request body must be valid JSON.');
    if (Buffer.byteLength(raw, 'utf8') > limit) throw new Error('Request body is too large.');
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
        throw new Error('Request body must be valid JSON.');
    }
}

async function readRequestBody(request, options) {
    const limit = maxBodyBytes(options && options.maxBodyBytes);
    const available = bodyValue(request);
    if (available !== undefined) return parseBodyValue(available, limit);
    if (!request || typeof request.on !== 'function') return {};
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        let settled = false;
        const fail = error => {
            if (settled) return;
            settled = true;
            reject(error);
        };
        request.on('data', chunk => {
            if (settled) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            size += buffer.length;
            if (size > limit) fail(new Error('Request body is too large.'));
            else chunks.push(buffer);
        });
        request.on('end', () => {
            if (settled) return;
            settled = true;
            try { resolve(parseBodyValue(Buffer.concat(chunks), limit)); } catch (error) { reject(error); }
        });
        request.on('error', fail);
    });
}

function adaptParsedRequest(request, limit) {
    if (!request || typeof request !== 'object') return request;
    const value = bodyValue(request);
    if (value === undefined) return request;
    const bodyLimit = maxBodyBytes(limit);
    const rawValue = Buffer.isBuffer(value) ? value : typeof value === 'string' ? value : null;
    if (rawValue !== null && Buffer.byteLength(rawValue, 'utf8') > bodyLimit) throw new Error('Request body is too large.');
    const parsed = rawValue === null ? parseBodyValue(value, bodyLimit) : null;
    // The existing handler expects a Node request stream. Firebase Functions
    // may expose an already-consumed parsed body, so provide a tiny stream
    // facade and preserve every other request property/method.
    const adapted = Object.create(request);
    adapted.body = parsed === null ? undefined : parsed;
    adapted.rawBody = undefined;
    adapted.on = (event, callback) => {
        if (typeof callback !== 'function') return adapted;
        if (event === 'data') process.nextTick(() => callback(rawValue === null ? JSON.stringify(parsed) : rawValue));
        if (event === 'end') process.nextTick(callback);
        return adapted;
    };
    return adapted;
}

function normalizeSecretPayload(response) {
    const value = response && response.payload && response.payload.data;
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    if (typeof value === 'string') return value;
    if (value && typeof value.toString === 'function') return value.toString('utf8');
    return '';
}

class SecretManagerTokenStore {
    constructor(options) {
        const opts = options || {};
        if (!opts.client || typeof opts.client.accessSecretVersion !== 'function' || typeof opts.client.addSecretVersion !== 'function') throw new Error('A production Secret Manager client is required.');
        this.client = opts.client;
        this.projectId = text(opts.projectId);
        this.secretNames = opts.secretNames && typeof opts.secretNames === 'object' && !Array.isArray(opts.secretNames) ? { ...opts.secretNames } : {};
        this.secretPrefix = text(opts.secretPrefix || 'budget-tool-plaid-token');
        this.cacheTtlMs = Number.isFinite(opts.cacheTtlMs) && opts.cacheTtlMs >= 0 ? opts.cacheTtlMs : 30_000;
        this.clock = typeof opts.clock === 'function' ? opts.clock : () => Date.now();
        this.cache = new Map();
        if (!this.projectId && !Object.keys(this.secretNames).length) throw new Error('Production Secret Manager project or secret names are required.');
    }

    secretNameFor(connectionKey) {
        const key = safeKey(connectionKey, 'Provider connection key');
        const configured = text(this.secretNames[key]);
        if (configured) {
            if (!/^projects\/[^/]+\/secrets\/[A-Za-z0-9_-]+$/.test(configured)) throw new Error('Production provider configuration is incomplete.');
            return configured;
        }
        if (!this.projectId) throw new Error('Production provider configuration is incomplete.');
        return `projects/${this.projectId}/secrets/${this.secretPrefix}-${key}`;
    }

    invalidate(connectionKey) {
        const key = safeKey(connectionKey, 'Provider connection key');
        for (const cacheKey of this.cache.keys()) if (cacheKey.startsWith(`${key}:`)) this.cache.delete(cacheKey);
    }

    async prepareForExchange() {
        // Secret Manager versions are created only after provider exchange;
        // this compatibility store has no local durable capacity to reserve.
    }

    async setAccessToken(connectionKey, accessToken) {
        const token = text(accessToken);
        if (!token || token.length > 4096) throw new Error('Secret storage failed.');
        const secretName = this.secretNameFor(connectionKey);
        try {
            const result = await this.client.addSecretVersion({ parent: secretName, payload: { data: Buffer.from(token, 'utf8') } });
            this.invalidate(connectionKey);
            const version = result && (Array.isArray(result) ? result[0] : result);
            const versionName = text(version && version.name);
            if (!/^projects\/[^/]+\/secrets\/[A-Za-z0-9_-]+\/versions\/\d+$/.test(versionName)) throw new Error('Secret storage failed.');
            return Object.freeze({ connectionKey: safeKey(connectionKey, 'Provider connection key'), secretName, versionName });
        } catch (_) {
            throw new Error('Secret storage failed.');
        }
    }

    async resolveAccessToken(connectionKey, versionName) {
        const key = safeKey(connectionKey, 'Provider connection key');
        const version = text(versionName);
        if (!/^projects\/[^/]+\/secrets\/[A-Za-z0-9_-]+\/versions\/\d+$/.test(version)) throw new Error('Secret resolution failed.');
        const cacheKey = `${key}:${version}`;
        const cached = this.cache.get(cacheKey);
        const now = Number(this.clock());
        if (cached && cached.expiresAt > now) return cached.value;
        try {
            const result = await this.client.accessSecretVersion({ name: version });
            const token = normalizeSecretPayload(Array.isArray(result) ? result[0] : result);
            if (!token || token.length > 4096) throw new Error('empty secret');
            this.cache.set(cacheKey, { value: token, expiresAt: now + this.cacheTtlMs });
            return token;
        } catch (_) {
            throw new Error('Secret resolution failed.');
        }
    }
}

const TOKEN_VAULT_COLLECTION = 'protectedProviderTokens';
const TOKEN_VAULT_MAX_VERSIONS = 64;
const TOKEN_VAULT_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

function decodeVaultKey(value) {
    if (Buffer.isBuffer(value)) return value.length === 32 ? Buffer.from(value) : null;
    const source = text(value);
    if (!source) return null;
    try {
        const decoded = Buffer.from(source, 'base64url');
        return decoded.length === 32 ? decoded : null;
    } catch (_) {
        return null;
    }
}

function normalizeVaultKeyring(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Token vault configuration is incomplete.');
    const entries = Object.entries(value);
    if (!entries.length || entries.length > 4) throw new Error('Token vault configuration is incomplete.');
    const keyring = Object.create(null);
    for (const [keyId, rawKey] of entries) {
        if (!TOKEN_VAULT_KEY_ID_PATTERN.test(keyId)) throw new Error('Token vault configuration is incomplete.');
        const decoded = decodeVaultKey(rawKey);
        if (!decoded) throw new Error('Token vault configuration is incomplete.');
        keyring[keyId] = decoded;
    }
    return Object.freeze(keyring);
}

function vaultKeyAvailable(keyring, keyId) {
    return own(keyring, keyId) && Buffer.isBuffer(keyring[keyId]) && keyring[keyId].length === 32;
}

function vaultBindingAad(binding) {
    if (!binding) return '';
    return JSON.stringify([binding.exchangeId, binding.ownerUid, binding.householdId, binding.itemId]);
}

function vaultAad(projectId, householdId, connectionKey, version, keyId, binding) {
    return `${projectId}|${householdId}|${connectionKey}|${version}|${keyId}|${vaultBindingAad(binding)}`;
}

function vaultClockMs(clock) {
    const value = clock();
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : Date.now();
}

function vaultExchangeBinding(value, householdId, requireItemId = true) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const exchangeId = text(value.exchangeId);
    const ownerUid = text(value.ownerUid);
    const bindingHousehold = text(value.householdId);
    const itemId = text(value.itemId);
    if (!exchangeId || exchangeId.length > 127 || !/^[A-Za-z0-9_-]+$/.test(exchangeId) || !ownerUid || !validUid(ownerUid) || bindingHousehold !== householdId || !validHouseholdId(bindingHousehold) || requireItemId && (!itemId || itemId.length > 256)) return null;
    return Object.freeze({ exchangeId, ownerUid, householdId: bindingHousehold, itemId });
}

function encryptVaultToken(token, key, aad, clock) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return {
        algorithm: 'aes-256-gcm',
        iv: iv.toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'),
        aad,
        createdAt: clock()
    };
}

function decryptVaultToken(envelope, key, aad) {
    const encoded = value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
    if (!envelope || envelope.schemaVersion !== 1 || envelope.algorithm !== 'aes-256-gcm' || envelope.aad !== aad || !encoded(envelope.iv) || !encoded(envelope.ciphertext) || !encoded(envelope.tag)) throw new Error('Token vault envelope is invalid.');
    const iv = Buffer.from(text(envelope.iv), 'base64url');
    const ciphertext = Buffer.from(text(envelope.ciphertext), 'base64url');
    const tag = Buffer.from(text(envelope.tag), 'base64url');
    if (iv.length !== 12 || !ciphertext.length || tag.length !== 16 || ciphertext.length > 8192) throw new Error('Token vault envelope is invalid.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

class FirestoreEncryptedTokenStore {
    constructor(options) {
        const opts = options || {};
        if (!opts.db || typeof opts.db.collection !== 'function' || typeof opts.db.runTransaction !== 'function') throw new Error('A Firestore transaction client is required.');
        this.db = opts.db;
        this.projectId = text(opts.projectId);
        this.householdId = text(opts.householdId);
        this.collectionName = text(opts.collection || TOKEN_VAULT_COLLECTION);
        this.keyring = normalizeVaultKeyring(opts.keyring);
        this.currentKeyId = text(opts.currentKeyId);
        this.maxVersions = Number.isSafeInteger(opts.maxVersions) && opts.maxVersions > 0 && opts.maxVersions <= TOKEN_VAULT_MAX_VERSIONS ? opts.maxVersions : TOKEN_VAULT_MAX_VERSIONS;
        this.clock = typeof opts.clock === 'function' ? opts.clock : () => new Date().toISOString();
        this.cacheTtlMs = Number.isFinite(opts.cacheTtlMs) && opts.cacheTtlMs >= 0 ? opts.cacheTtlMs : 30_000;
        if (!this.projectId || !validHouseholdId(this.householdId) || !vaultKeyAvailable(this.keyring, this.currentKeyId)) throw new Error('Token vault configuration is incomplete.');
        this.cache = new Map();
    }

    assertKey(connectionKey) {
        return safeKey(connectionKey, 'Provider connection key');
    }

    secretNameFor(connectionKey) {
        return `projects/${this.projectId}/secrets/${this.assertKey(connectionKey)}`;
    }

    versionNameFor(connectionKey, version) {
        const number = Number(version);
        if (!Number.isSafeInteger(number) || number < 1) throw new Error('Secret resolution failed.');
        return `${this.secretNameFor(connectionKey)}/versions/${number}`;
    }

    parseVersionName(connectionKey, versionName) {
        const expected = this.secretNameFor(connectionKey);
        const value = text(versionName);
        const prefix = `${expected}/versions/`;
        if (!value.startsWith(prefix)) throw new Error('Secret resolution failed.');
        const rawVersion = value.slice(prefix.length);
        if (!/^\d+$/.test(rawVersion)) throw new Error('Secret resolution failed.');
        const version = Number(rawVersion);
        if (!Number.isSafeInteger(version) || version < 1 || version > this.maxVersions) throw new Error('Secret resolution failed.');
        return version;
    }

    slotRef(connectionKey) {
        return this.db.collection(this.collectionName).doc(this.assertKey(connectionKey));
    }

    invalidate(connectionKey) {
        const key = this.assertKey(connectionKey);
        for (const cacheKey of this.cache.keys()) if (cacheKey.startsWith(`${key}:`)) this.cache.delete(cacheKey);
    }

    assertKeyMaterial(keyId) {
        const normalized = text(keyId);
        if (!TOKEN_VAULT_KEY_ID_PATTERN.test(normalized) || !vaultKeyAvailable(this.keyring, normalized)) throw new Error('Token vault state is invalid.');
        return normalized;
    }

    validateEnvelope(connectionKey, version, envelope, expectedBinding) {
        if (!envelope || envelope.schemaVersion !== 1 || envelope.slot !== connectionKey || envelope.version !== version) throw new Error('Token vault state is invalid.');
        const keyId = this.assertKeyMaterial(envelope.keyId);
        const binding = envelope.binding === undefined ? null : vaultExchangeBinding(envelope.binding, this.householdId);
        if (envelope.binding !== undefined && !binding) throw new Error('Token vault state is invalid.');
        if (expectedBinding && (!binding || JSON.stringify(binding) !== JSON.stringify(expectedBinding))) throw new Error('Token vault state is invalid.');
        const aad = vaultAad(this.projectId, this.householdId, connectionKey, version, keyId, binding);
        decryptVaultToken(envelope, this.keyring[keyId], aad);
        return { keyId, binding };
    }

    validateSlotState(connectionKey, value, allowMissing = true) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            if (allowMissing) return { schemaVersion: 1, slot: connectionKey, householdId: this.householdId, latestVersion: 0, exchangeReferences: {} };
            throw new Error('Token vault state is invalid.');
        }
        if (value.schemaVersion !== 1 || value.slot !== connectionKey || value.householdId !== this.householdId || !Number.isSafeInteger(value.latestVersion) || value.latestVersion < 0 || value.latestVersion > this.maxVersions) throw new Error('Token vault state is invalid.');
        if (value.exchangeReferences !== undefined && (!value.exchangeReferences || typeof value.exchangeReferences !== 'object' || Array.isArray(value.exchangeReferences))) throw new Error('Token vault state is invalid.');
        return value;
    }

    async validateReference(connectionKey, binding, reference, versionSnapshot) {
        if (!reference || typeof reference !== 'object' || Array.isArray(reference)) throw new Error('Token vault state is invalid.');
        if (text(reference.exchangeId) !== binding.exchangeId || text(reference.ownerUid) !== binding.ownerUid || text(reference.householdId) !== binding.householdId || binding.itemId && text(reference.itemId) !== binding.itemId) throw new Error('Token vault state is invalid.');
        const version = Number(reference.version);
        if (!Number.isSafeInteger(version) || version < 1 || version > this.maxVersions) throw new Error('Token vault state is invalid.');
        const itemId = text(reference.itemId);
        if (!itemId || itemId.length > 256) throw new Error('Token vault state is invalid.');
        const fullBinding = Object.freeze({ ...binding, itemId });
        const keyId = this.assertKeyMaterial(reference.keyId);
        const secretName = this.secretNameFor(connectionKey);
        const versionName = this.versionNameFor(connectionKey, version);
        if (text(reference.secretName) !== secretName || text(reference.versionName) !== versionName) throw new Error('Token vault state is invalid.');
        const snapshot = versionSnapshot || await this.slotRef(connectionKey).collection('versions').doc(String(version)).get();
        if (!snapshot || !snapshot.exists) throw new Error('Token vault state is invalid.');
        const envelope = snapshot.data() || {};
        const validated = this.validateEnvelope(connectionKey, version, envelope, fullBinding);
        if (validated.keyId !== keyId || !validated.binding || JSON.stringify(validated.binding) !== JSON.stringify(fullBinding)) throw new Error('Token vault state is invalid.');
        return { version, keyId, itemId, secretName, versionName };
    }

    async prepareForExchange(connectionKey, context) {
        const key = this.assertKey(connectionKey);
        if (!vaultKeyAvailable(this.keyring, this.currentKeyId)) throw new Error('Token vault configuration is incomplete.');
        const binding = vaultExchangeBinding(context, this.householdId, false);
        if (!binding) throw new Error('Token vault configuration is incomplete.');
        const snapshot = await this.slotRef(key).get();
        const current = snapshot && snapshot.exists ? this.validateSlotState(key, snapshot.data(), false) : this.validateSlotState(key, null, true);
        const references = current.exchangeReferences || {};
        if (!own(references, binding.exchangeId) && Object.keys(references).length >= this.maxVersions) throw new Error('Token vault version limit reached.');
        if (current.latestVersion >= this.maxVersions && !own(references, binding.exchangeId)) throw new Error('Token vault version limit reached.');
        if (own(references, binding.exchangeId)) await this.validateReference(key, binding, references[binding.exchangeId]);
    }

    async setAccessToken(connectionKey, accessToken, context) {
        const key = this.assertKey(connectionKey);
        const token = text(accessToken);
        if (!token || token.length > 4096) throw new Error('Secret storage failed.');
        const secretName = this.secretNameFor(key);
        const binding = vaultExchangeBinding(context, this.householdId);
        try {
            const result = await this.db.runTransaction(async transaction => {
                const slotRef = this.slotRef(key);
                const snapshot = await transaction.get(slotRef);
                const hasCurrent = Boolean(snapshot && snapshot.exists);
                const current = this.validateSlotState(key, hasCurrent ? snapshot.data() : null, !hasCurrent);
                const existingReferences = current.exchangeReferences || {};
                if (binding) {
                    if (own(existingReferences, binding.exchangeId)) {
                        const existing = existingReferences[binding.exchangeId];
                        const version = Number(existing && existing.version);
                        if (!existing || existing.ownerUid !== binding.ownerUid || existing.householdId !== binding.householdId || existing.itemId !== binding.itemId || !Number.isSafeInteger(version) || version < 1 || version > this.maxVersions) throw new Error('Token vault state is invalid.');
                        const existingVersion = await transaction.get(slotRef.collection('versions').doc(String(version)));
                        const validated = await this.validateReference(key, binding, existing, existingVersion);
                        return { version: validated.version, keyId: validated.keyId, itemId: validated.itemId, reused: true };
                    }
                    if (Object.keys(existingReferences).length >= this.maxVersions) throw new Error('Token vault version limit reached.');
                }
                const latest = current.latestVersion;
                if (!Number.isSafeInteger(latest) || latest < 0 || latest >= this.maxVersions) throw new Error('Token vault version limit reached.');
                const version = latest + 1;
                const versionRef = slotRef.collection('versions').doc(String(version));
                const existingVersion = await transaction.get(versionRef);
                if (existingVersion && existingVersion.exists) throw new Error('Token vault state is invalid.');
                const aad = vaultAad(this.projectId, this.householdId, key, version, this.currentKeyId, binding);
                const envelope = encryptVaultToken(token, this.keyring[this.currentKeyId], aad, this.clock);
                const versionName = this.versionNameFor(key, version);
                const nextReferences = { ...existingReferences };
                if (binding) nextReferences[binding.exchangeId] = { ...binding, version, keyId: this.currentKeyId, secretName, versionName };
                transaction.set(versionRef, {
                    schemaVersion: 1,
                    slot: key,
                    version,
                    keyId: this.currentKeyId,
                    ...(binding ? { binding } : {}),
                    ...envelope
                });
                transaction.set(slotRef, {
                    schemaVersion: 1,
                    slot: key,
                    householdId: this.householdId,
                    latestVersion: version,
                    exchangeReferences: nextReferences,
                    updatedAt: this.clock()
                });
                return { version, keyId: this.currentKeyId, itemId: binding && binding.itemId, reused: false };
            });
            const versionName = this.versionNameFor(key, result.version);
            if (!result.reused) this.invalidate(key);
            return Object.freeze({ connectionKey: key, secretName, versionName, keyId: result.keyId, itemId: result.itemId || undefined, reused: result.reused === true });
        } catch (error) {
            if (error && error.message === 'Token vault version limit reached.') throw new Error('Secret storage failed.');
            throw new Error('Secret storage failed.');
        }
    }

    async findAccessTokenReference(connectionKey, context) {
        const key = this.assertKey(connectionKey);
        const binding = vaultExchangeBinding(context, this.householdId, false);
        if (!binding) return null;
        try {
            const snapshot = await this.slotRef(key).get();
            if (!snapshot || !snapshot.exists) return null;
            const value = this.validateSlotState(key, snapshot.data(), false);
            const references = value.exchangeReferences || {};
            if (!own(references, binding.exchangeId)) return null;
            const validated = await this.validateReference(key, binding, references[binding.exchangeId]);
            return Object.freeze({ connectionKey: key, secretName: validated.secretName, versionName: validated.versionName, keyId: validated.keyId, itemId: validated.itemId });
        } catch (_) {
            return null;
        }
    }

    async rewrapAccessToken(connectionKey, versionName) {
        const key = this.assertKey(connectionKey);
        const version = this.parseVersionName(key, versionName);
        try {
            const result = await this.db.runTransaction(async transaction => {
                const slotRef = this.slotRef(key);
                const slotSnapshot = await transaction.get(slotRef);
                const versionRef = this.slotRef(key).collection('versions').doc(String(version));
                const snapshot = await transaction.get(versionRef);
                const envelope = snapshot && snapshot.exists ? snapshot.data() || {} : null;
                const validated = this.validateEnvelope(key, version, envelope);
                const token = decryptVaultToken(envelope, this.keyring[validated.keyId], vaultAad(this.projectId, this.householdId, key, version, validated.keyId, validated.binding));
                const slot = slotSnapshot && slotSnapshot.exists ? this.validateSlotState(key, slotSnapshot.data(), false) : null;
                if (validated.keyId === this.currentKeyId) return { version, keyId: this.currentKeyId, changed: false };
                const aad = vaultAad(this.projectId, this.householdId, key, version, this.currentKeyId, validated.binding);
                const replacement = encryptVaultToken(token, this.keyring[this.currentKeyId], aad, this.clock);
                transaction.set(versionRef, {
                    schemaVersion: 1,
                    slot: key,
                    version,
                    keyId: this.currentKeyId,
                    ...(validated.binding ? { binding: validated.binding } : {}),
                    ...replacement,
                    rewrappedAt: this.clock()
                });
                if (slot) {
                    const references = slot.exchangeReferences || {};
                    const nextReferences = { ...references };
                    let referencesChanged = false;
                    for (const [exchangeId, reference] of Object.entries(references)) {
                        if (!reference || typeof reference !== 'object' || Array.isArray(reference)) throw new Error('Token vault state is invalid.');
                        if (Number(reference.version) === version && text(reference.keyId) === validated.keyId) {
                            nextReferences[exchangeId] = { ...reference, keyId: this.currentKeyId };
                            referencesChanged = true;
                        }
                    }
                    if (referencesChanged) transaction.set(slotRef, { ...slot, exchangeReferences: nextReferences, updatedAt: this.clock() });
                }
                return { version, keyId: this.currentKeyId, changed: true };
            });
            this.invalidate(key);
            return Object.freeze({ connectionKey: key, secretName: this.secretNameFor(key), versionName: this.versionNameFor(key, result.version), keyId: result.keyId, changed: result.changed });
        } catch (_) {
            throw new Error('Secret resolution failed.');
        }
    }

    async resolveAccessToken(connectionKey, versionName) {
        const key = this.assertKey(connectionKey);
        const version = this.parseVersionName(key, versionName);
        const cacheKey = `${key}:${version}`;
        const cached = this.cache.get(cacheKey);
        const now = vaultClockMs(this.clock);
        if (cached && cached.expiresAt > now) return cached.value;
        if (cached) this.cache.delete(cacheKey);
        try {
            const versionRef = this.slotRef(key).collection('versions').doc(String(version));
            const snapshot = await versionRef.get();
            const envelope = snapshot && snapshot.exists ? snapshot.data() || {} : null;
            const validated = this.validateEnvelope(key, version, envelope);
            const token = decryptVaultToken(envelope, this.keyring[validated.keyId], vaultAad(this.projectId, this.householdId, key, version, validated.keyId, validated.binding));
            if (!token || token.length > 4096) throw new Error('invalid token');
            this.cache.set(cacheKey, { value: token, expiresAt: now + this.cacheTtlMs });
            return token;
        } catch (_) {
            throw new Error('Secret resolution failed.');
        }
    }
}

function normalizeProviderResponse(value) {
    if (value && value.data && typeof value.data === 'object') return value.data;
    return value && typeof value === 'object' ? value : {};
}

function providerMethod(client, names, request) {
    const name = names.find(candidate => client && typeof client[candidate] === 'function');
    if (!name) throw new Error('Production provider configuration is incomplete.');
    return client[name](request);
}

function normalizeLinkToken(response) {
    const body = normalizeProviderResponse(response);
    const linkToken = text(body.link_token || body.linkToken);
    if (!linkToken || linkToken.length > 4096) throw new Error('Plaid Link returned an invalid response.');
    return linkToken;
}

function normalizeExchange(response) {
    const body = normalizeProviderResponse(response);
    const accessToken = text(body.access_token || body.accessToken);
    const itemId = text(body.item_id || body.itemId);
    if (!accessToken || !itemId || accessToken.length > 4096 || itemId.length > 256) throw new Error('Plaid Link returned an invalid response.');
    return { accessToken, itemId };
}

function normalizeAccounts(response) {
    const body = normalizeProviderResponse(response);
    const accounts = Array.isArray(body.accounts) ? body.accounts : null;
    if (!accounts) throw new Error('Plaid Link returned an invalid response.');
    return accounts.map(account => {
        const id = text(account && account.account_id || account && account.accountId);
        if (!id || id.length > 256) throw new Error('Provider account IDs must be stable non-empty strings.');
        const currency = text(account && account.balances && (account.balances.iso_currency_code || account.balances.isoCurrencyCode || account.balances.currency_code)).toUpperCase();
        // Plaid's mask is display metadata only. Bound it to the final four
        // digits before returning it to the browser; never expose a full
        // provider account number or use the mask as an account authority.
        const maskDigits = text(account && (account.mask || account.last4)).replace(/\D/g, '').slice(-4);
        return {
            accountId: id,
            name: text(account && account.name).slice(0, 256),
            officialName: text(account && account.official_name || account && account.officialName).slice(0, 256),
            type: text(account && account.type).slice(0, 64),
            subtype: text(account && account.subtype).slice(0, 64),
            ...(currency ? { currency } : {}),
            ...(maskDigits.length >= 2 ? { mask: maskDigits } : {})
        };
    });
}

function normalizeAliasSet(value) {
    if (!Array.isArray(value) || !value.length) throw new Error('A provider account mapping is not configured.');
    const aliases = [...new Set(value.map(text).filter(Boolean))];
    if (!aliases.length || aliases.some(alias => alias.length > 128)) throw new Error('A provider account mapping is not configured.');
    return aliases;
}

function normalizeAccountBindings(accounts, bindings, allowedAliases, ignoredAccountIds, accountPolicy) {
    if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings) || !Object.keys(bindings).length) throw new Error('Link account bindings are required.');
    const accountIds = new Set(accounts.map(account => account.accountId));
    const ignored = new Set((ignoredAccountIds || []).map(text).filter(Boolean));
    const mapping = {};
    const usedAliases = new Set();
    const policy = accountPolicy && typeof accountPolicy === 'object' ? accountPolicy : {};
    const allowedTypes = new Set(Array.isArray(policy.types) ? policy.types.map(value => text(value).toLowerCase()).filter(Boolean) : []);
    const allowedSubtypes = new Set(Array.isArray(policy.subtypes) ? policy.subtypes.map(value => text(value).toLowerCase()).filter(Boolean) : []);
    const expectedCurrency = text(policy.currency || '').toUpperCase();
    const aliasPolicies = policy.aliases && typeof policy.aliases === 'object' ? policy.aliases : {};
    const matchesPolicy = (account, candidate) => {
        const types = new Set(Array.isArray(candidate && candidate.types) ? candidate.types.map(value => text(value).toLowerCase()).filter(Boolean) : []);
        const subtypes = new Set(Array.isArray(candidate && candidate.subtypes) ? candidate.subtypes.map(value => text(value).toLowerCase()).filter(Boolean) : []);
        const currency = text(candidate && candidate.currency || '').toUpperCase();
        return (!types.size || types.has(text(account.type).toLowerCase()))
            && (!subtypes.size || subtypes.has(text(account.subtype).toLowerCase()))
            && (!currency || currency === text(account.currency).toUpperCase());
    };
    for (const account of accounts) {
        if (ignored.has(account.accountId)) continue;
        if (Object.keys(aliasPolicies).length) {
            if (!Object.values(aliasPolicies).some(candidate => matchesPolicy(account, candidate))) throw new Error('Provider account type or currency is not configured.');
        } else if ((allowedTypes.size && !allowedTypes.has(text(account.type).toLowerCase())) || (allowedSubtypes.size && !allowedSubtypes.has(text(account.subtype).toLowerCase())) || (expectedCurrency && text(account.currency).toUpperCase() !== expectedCurrency)) {
            throw new Error('Provider account type or currency is not configured.');
        }
    }
    for (const [providerAccountId, displayName] of Object.entries(bindings)) {
        const id = text(providerAccountId);
        const alias = text(displayName);
        if (!accountIds.has(id)) throw new Error('Link account bindings contain an unknown provider account ID.');
        if (!allowedAliases.includes(alias)) throw new Error('Link account bindings contain an unsupported display account.');
        if (aliasPolicies[alias] && !matchesPolicy(accounts.find(account => account.accountId === id), aliasPolicies[alias])) throw new Error('Provider account type or currency is not configured.');
        if (usedAliases.has(alias)) throw new Error('Provider account mapping is invalid.');
        usedAliases.add(alias);
        mapping[id] = alias;
    }
    for (const account of accounts) {
        if (!Object.prototype.hasOwnProperty.call(mapping, account.accountId) && !ignored.has(account.accountId)) throw new Error('Link account bindings must cover every non-ignored provider account.');
    }
    return mapping;
}

function publicExchangeResult(result) {
    return {
        connectionKey: text(result && result.connectionKey),
        itemId: text(result && result.itemId),
        accounts: clone(result && result.accounts) || [],
        accountMap: clone(result && result.accountMap) || {}
    };
}

function publicPendingExchangeResult(result) {
    return {
        status: 'pending-binding',
        connectionKey: text(result && result.connectionKey),
        exchangeId: text(result && result.exchangeId),
        itemId: text(result && result.itemId),
        accounts: clone(result && result.accounts) || [],
        accountMap: {}
    };
}

class FirestoreProviderConnectionRepository {
    constructor(options) {
        const opts = options || {};
        if (!opts.db || typeof opts.db.collection !== 'function' || typeof opts.db.runTransaction !== 'function') throw new Error('A Firestore transaction client is required.');
        this.db = opts.db;
        this.collectionName = text(opts.collection || 'protectedConnections');
        this.allowedConnectionKeys = new Set((opts.allowedConnectionKeys || []).map(text).filter(Boolean));
        this.clock = typeof opts.clock === 'function' ? opts.clock : () => new Date().toISOString();
        if (!this.allowedConnectionKeys.size) throw new Error('Production provider configuration is incomplete.');
    }

    assertKey(value) {
        const key = safeKey(value, 'Provider connection key');
        if (!this.allowedConnectionKeys.has(key)) throw new Error('Provider connection key is not configured.');
        return key;
    }

    ref(key) { return this.db.collection(this.collectionName).doc(this.assertKey(key)); }

    authorizeRecord(record, auth, allowUnclaimed) {
        const current = record || {};
        if (!current.householdId && !current.ownerUid && allowUnclaimed) return;
        if (!current.householdId || text(current.householdId) !== text(auth && auth.householdId)) throw new Error('Provider connection is not configured for this household.');
        const ownerUid = text(current.ownerUid);
        if (ownerUid) {
            // Once a record has a stable UID, an email match cannot transfer
            // ownership after an account recreation or email alias change.
            if (!text(auth && auth.uid) || ownerUid !== text(auth && auth.uid)) throw new Error('User is not authorized for this provider connection.');
            return;
        }
        if (!text(current.ownerEmail) || text(current.ownerEmail).toLowerCase() !== text(auth && auth.email).toLowerCase()) throw new Error('User is not authorized for this provider connection.');
    }

    async getAuthorized(key, auth, options) {
        const ref = this.ref(key);
        const snapshot = await ref.get();
        if (!snapshot || !snapshot.exists) throw new Error('Provider connection is not configured.');
        const current = snapshot.data() || {};
        this.authorizeRecord(current, auth, false);
        this.assertNoUnresolvedCleanup(current);
        const value = clone(current);
        if (!(options && options.includeLedger === true)) delete value.exchangeLedger;
        return value;
    }

    assertNoUnresolvedCleanup(record) {
        const ledger = record && record.disconnectLedger;
        if (ledger && typeof ledger === 'object' && !Array.isArray(ledger) && Object.values(ledger).some(entry => entry && ['started', 'ambiguous'].includes(entry.status))) throw new Error('Cleanup requires reconciliation before retrying.');
    }

    async getForCreate(key, auth, options) {
        const ref = this.ref(key);
        const snapshot = await ref.get();
        if (!snapshot || !snapshot.exists) return null;
        const value = clone(snapshot.data());
        this.assertNoUnresolvedCleanup(value);
        const retired = value.retiredCleanup;
        if (retired && retired.status === 'removed') {
            const sameRecovery = retired.replacementClaim && retired.replacementClaim.status === 'consumed'
                && value.linkReservation && value.linkReservation.status === 'needs-reconciliation'
                && text(options && options.sessionId) === text(value.linkReservation.sessionId);
            if (retired.replacementClaim && retired.replacementClaim.status === 'consumed' && !sameRecovery) throw new Error('Link exchange requires reconciliation before retrying.');
            const activeReservation = value.linkReservation && value.linkReservation.status && value.linkReservation.status !== 'expired' && !(sameRecovery && value.linkReservation.status === 'needs-reconciliation');
            if (text(value.householdId) !== text(auth && auth.householdId) || text(retired.replacementOwnerUid) !== text(auth && auth.uid) || value.itemId || value.pendingExchange || activeReservation) throw new Error('User is not authorized for this provider connection.');
            return value;
        }
        this.authorizeRecord(value, auth, false);
        return value;
    }

    async reserveLinkToken(key, auth, sessionId, mode, ttlMs, replacementClaim) {
        const connectionKey = this.assertKey(key);
        const id = requestId(sessionId, 'A Link session ID');
        const ttl = Number.isSafeInteger(ttlMs) && ttlMs > 0 ? ttlMs : 10 * 60 * 1000;
        const now = Date.parse(this.clock());
        const createdAt = Number.isFinite(now) ? now : Date.now();
        return this.db.runTransaction(async transaction => {
            const ref = this.ref(connectionKey);
            const snapshot = await transaction.get(ref);
            const current = snapshot && snapshot.exists ? snapshot.data() : {};
            this.assertNoUnresolvedCleanup(current);
            const retired = current.retiredCleanup && current.retiredCleanup.status === 'removed';
            const sameRecovery = retired && current.retiredCleanup.replacementClaim && current.retiredCleanup.replacementClaim.status === 'consumed'
                && current.linkReservation && current.linkReservation.status === 'needs-reconciliation'
                && text(current.linkReservation.sessionId) === id;
            if (sameRecovery && (text(current.householdId) !== text(auth && auth.householdId) || text(current.retiredCleanup.replacementOwnerUid) !== text(auth && auth.uid))) throw new Error('User is not authorized for this provider connection.');
            if (retired) {
                if (current.retiredCleanup.replacementClaim && current.retiredCleanup.replacementClaim.status === 'consumed' && !sameRecovery) throw new Error('Link exchange requires reconciliation before retrying.');
                if (!sameRecovery && (!replacementClaim || text(replacementClaim.replacementOwnerUid) !== text(auth && auth.uid) || text(current.retiredCleanup.replacementOwnerUid) !== text(auth && auth.uid) || text(current.retiredCleanup.cleanupDigest) !== text(replacementClaim.cleanupDigest))) throw new Error('User is not authorized for this provider connection.');
                const activeReservation = current.linkReservation && current.linkReservation.status && current.linkReservation.status !== 'expired' && !(sameRecovery && current.linkReservation.status === 'needs-reconciliation');
                if (current.itemId || current.pendingExchange || activeReservation) throw new Error('Link exchange cannot replace an existing Item.');
            } else this.authorizeRecord(current, auth, true);
            if (mode === 'create' && current.itemId) throw new Error('Link exchange cannot replace an existing Item.');
            if (current.exchangeLedger && Object.values(current.exchangeLedger).some(entry => entry && (entry.status === 'started' || entry.status === 'pending-binding' || entry.status === 'needs-reconciliation'))) {
                throw new Error('Link exchange requires reconciliation before retrying.');
            }
            const reservation = current.linkReservation;
            const expiresAt = Date.parse(text(reservation && reservation.expiresAt));
            if (reservation && reservation.status && !sameRecovery && (!Number.isFinite(expiresAt) || expiresAt > createdAt)) {
                if (reservation.sessionId === id) throw new Error('Link token session is already reserved; continue the existing session.');
                throw new Error('Link token creation is already in progress; retry after the existing session is reconciled.');
            }
            const next = clone(current);
            next.connectionKey = connectionKey;
            next.householdId = text(auth && auth.householdId);
            next.ownerUid = text(auth && auth.uid);
            next.ownerEmail = text(auth && auth.email).toLowerCase();
            if (retired) next.retiredCleanup = { ...current.retiredCleanup, replacementClaim: { status: 'consumed', consumedAt: this.clock() } };
            next.linkReservation = {
                status: 'reserved',
                sessionId: id,
                mode: text(mode || 'create'),
                createdAt: new Date(createdAt).toISOString(),
                expiresAt: new Date(createdAt + ttl).toISOString()
            };
            transaction.set(ref, next);
            return { status: 'reserved', connection: next, sessionId: id };
        });
    }

    async completeLinkToken(key, auth, sessionId) {
        const connectionKey = this.assertKey(key);
        const id = requestId(sessionId, 'A Link session ID');
        return this.db.runTransaction(async transaction => {
            const ref = this.ref(connectionKey);
            const snapshot = await transaction.get(ref);
            const current = snapshot && snapshot.exists ? snapshot.data() : {};
            this.authorizeRecord(current, auth, false);
            this.assertNoUnresolvedCleanup(current);
            const reservation = current.linkReservation;
            if (!reservation || reservation.sessionId !== id || reservation.status !== 'reserved') throw new Error('Link token session requires reconciliation before retrying.');
            const next = clone(current);
            next.linkReservation = { ...reservation, status: 'issued', issuedAt: this.clock() };
            transaction.set(ref, next);
            return clone(next.linkReservation);
        });
    }

    async markLinkTokenNeedsReconciliation(key, auth, sessionId) {
        const connectionKey = this.assertKey(key);
        const id = requestId(sessionId, 'A Link session ID');
        try {
            await this.db.runTransaction(async transaction => {
                const ref = this.ref(connectionKey);
                const snapshot = await transaction.get(ref);
                const current = snapshot && snapshot.exists ? snapshot.data() : {};
                this.authorizeRecord(current, auth, false);
                const reservation = current.linkReservation;
                if (!reservation || reservation.sessionId !== id || reservation.status !== 'reserved') return;
                const next = clone(current);
                next.linkReservation = { ...reservation, status: 'needs-reconciliation', reconciledAt: this.clock() };
                transaction.set(ref, next);
            });
        } catch (_) {
            // Preserve the provider failure; the reservation remains fail-closed.
        }
    }

    async getOwner(key, householdId) {
        const snapshot = await this.ref(key).get();
        if (!snapshot || !snapshot.exists) return null;
        const value = snapshot.data() || {};
        if (text(value.householdId) !== text(householdId) || !text(value.ownerUid) && !text(value.ownerEmail)) return null;
        return text(value.ownerUid) || text(value.ownerEmail).toLowerCase();
    }

    async claimExchange(key, auth, exchangeId, publicToken) {
        const connectionKey = this.assertKey(key);
        const id = requestId(exchangeId, 'A Link exchange request ID');
        const tokenText = text(publicToken);
        const tokenDigest = tokenText ? digest(tokenText) : '';
        return this.db.runTransaction(async transaction => {
            const ref = this.ref(connectionKey);
            const snapshot = await transaction.get(ref);
            const current = snapshot && snapshot.exists ? snapshot.data() : {};
            this.assertNoUnresolvedCleanup(current);
            this.authorizeRecord(current, auth, true);
            const ledger = current.exchangeLedger && current.exchangeLedger[id];
            if (ledger && ledger.status === 'complete') {
                if (tokenDigest && (!ledger.publicTokenDigest || ledger.publicTokenDigest !== tokenDigest)) throw new Error('Link exchange requires reconciliation before retrying.');
                return { status: 'complete', result: clone(ledger.result), connection: clone(current) };
            }
            if (ledger && ledger.status === 'pending-binding') {
                if (tokenDigest && ledger.publicTokenDigest !== tokenDigest) throw new Error('Link exchange requires reconciliation before retrying.');
                return { status: 'pending-binding', exchange: clone(ledger), connection: clone(current) };
            }
            if (ledger && ledger.status === 'started') {
                if (!tokenDigest) throw new Error('A public token is required.');
                if (ledger.publicTokenDigest !== tokenDigest) throw new Error('Link exchange requires reconciliation before retrying.');
                throw new Error('Link exchange is already in progress; retry with the same request ID.');
            }
            if (ledger && ledger.status === 'needs-reconciliation') throw new Error('Link exchange requires reconciliation before retrying.');
            if (current.itemId) throw new Error('Link exchange cannot replace an existing Item.');
            const ledgerEntries = current.exchangeLedger && typeof current.exchangeLedger === 'object' && !Array.isArray(current.exchangeLedger)
                ? Object.keys(current.exchangeLedger)
                : [];
            if (ledgerEntries.length >= MAX_EXCHANGE_LEDGER_ENTRIES) throw new Error('Link exchange ledger is full; reconcile before starting another exchange.');
            const unresolved = current.exchangeLedger && typeof current.exchangeLedger === 'object' && !Array.isArray(current.exchangeLedger)
                ? Object.entries(current.exchangeLedger).some(([ledgerId, entry]) => ledgerId !== id && entry && ['started', 'pending-binding', 'needs-reconciliation'].includes(entry.status))
                : false;
            if (unresolved) throw new Error('Link exchange requires reconciliation before retrying.');
            if (!tokenDigest) throw new Error('A public token is required.');
            const next = clone(current);
            next.connectionKey = connectionKey;
            next.householdId = text(auth && auth.householdId);
            next.ownerUid = text(auth && auth.uid);
            next.ownerEmail = text(auth && auth.email).toLowerCase();
            next.exchangeLedger = next.exchangeLedger || {};
            next.exchangeLedger[id] = { status: 'started', publicTokenDigest: tokenDigest, startedAt: this.clock() };
            transaction.set(ref, next);
            return { status: 'started', connection: next };
        });
    }

    async stageExchange(key, auth, exchangeId, details) {
        const connectionKey = this.assertKey(key);
        const id = requestId(exchangeId, 'A Link exchange request ID');
        return this.db.runTransaction(async transaction => {
            const ref = this.ref(connectionKey);
            const snapshot = await transaction.get(ref);
            const current = snapshot && snapshot.exists ? snapshot.data() : {};
            this.authorizeRecord(current, auth, false);
            this.assertNoUnresolvedCleanup(current);
            const ledger = current.exchangeLedger && current.exchangeLedger[id];
            if (ledger && ledger.status === 'complete') return { status: 'complete', result: clone(ledger.result) };
            if (ledger && ledger.status === 'pending-binding') return { status: 'pending-binding', exchange: clone(ledger) };
            if (!ledger || ledger.status !== 'started') throw new Error('Link exchange requires reconciliation before retrying.');
            const itemId = text(details && details.itemId);
            const secretName = text(details && details.secretName);
            const secretVersion = text(details && details.secretVersion);
            if (!itemId || !secretName || !/^projects\/[^/]+\/secrets\/[A-Za-z0-9_-]+\/versions\/\d+$/.test(secretVersion)) throw new Error('Provider account mapping is invalid.');
            const next = clone(current);
            next.pendingExchange = { exchangeId: id, itemId, secretName, secretVersion, enabled: false, stagedAt: this.clock() };
            next.exchangeLedger = next.exchangeLedger || {};
            next.exchangeLedger[id] = { status: 'pending-binding', exchangeId: id, publicTokenDigest: ledger.publicTokenDigest, itemId, secretName, secretVersion, stagedAt: this.clock() };
            transaction.set(ref, next);
            return { status: 'pending-binding', exchange: clone(next.exchangeLedger[id]) };
        });
    }

    async completeExchange(key, auth, exchangeId, details) {
        const connectionKey = this.assertKey(key);
        const id = requestId(exchangeId, 'A Link exchange request ID');
        return this.db.runTransaction(async transaction => {
            const ref = this.ref(connectionKey);
            const snapshot = await transaction.get(ref);
            const current = snapshot && snapshot.exists ? snapshot.data() : {};
            this.authorizeRecord(current, auth, false);
            this.assertNoUnresolvedCleanup(current);
            const ledger = current.exchangeLedger && current.exchangeLedger[id];
            if (ledger && ledger.status === 'complete') return clone(ledger.result);
            if (!ledger || !['started', 'pending-binding'].includes(ledger.status)) throw new Error('Link exchange requires reconciliation before retrying.');
            const result = {
                connectionKey,
                itemId: text(details.itemId || ledger.itemId),
                accountMap: clone(details.accountMap),
                accounts: clone(details.accounts),
                secretName: text(details.secretName || ledger.secretName),
                secretVersion: text(details.secretVersion || ledger.secretVersion),
                updatedAt: this.clock()
            };
            if (!result.itemId || !result.secretName || !/^projects\/[^/]+\/secrets\/[A-Za-z0-9_-]+\/versions\/\d+$/.test(result.secretVersion) || !result.accountMap || !Object.keys(result.accountMap).length) throw new Error('Provider account mapping is invalid.');
            const next = clone(current);
            next.connectionKey = connectionKey;
            next.householdId = text(auth && auth.householdId);
            next.ownerUid = text(auth && auth.uid);
            next.ownerEmail = text(auth && auth.email).toLowerCase();
            next.itemId = result.itemId;
            next.secretName = result.secretName;
            next.secretVersion = result.secretVersion;
            next.accountMap = result.accountMap;
            next.accounts = result.accounts;
            next.enabled = false;
            delete next.pendingExchange;
            next.exchangeLedger = next.exchangeLedger || {};
            next.exchangeLedger[id] = { status: 'complete', publicTokenDigest: ledger.publicTokenDigest, result, completedAt: this.clock() };
            transaction.set(ref, next);
            return clone(result);
        });
    }

    async markNeedsReconciliation(key, auth, exchangeId) {
        const connectionKey = this.assertKey(key);
        const id = requestId(exchangeId, 'A Link exchange request ID');
        try {
            await this.db.runTransaction(async transaction => {
                const ref = this.ref(connectionKey);
                const snapshot = await transaction.get(ref);
                const current = snapshot && snapshot.exists ? snapshot.data() : {};
                this.authorizeRecord(current, auth, false);
                const next = clone(current);
                next.exchangeLedger = next.exchangeLedger || {};
                if (next.exchangeLedger[id] && next.exchangeLedger[id].status === 'started') next.exchangeLedger[id].status = 'needs-reconciliation';
                transaction.set(ref, next);
            });
        } catch (_) {
            // Preserve the original provider or secret failure. The ledger
            // remains fail-closed when marking it cannot be completed.
        }
    }
}

class PlaidLinkLifecycle {
    constructor(options) {
        const opts = options || {};
        if (!opts.client || !opts.connections || !opts.tokenStore) throw new Error('Production provider configuration is incomplete.');
        this.client = opts.client;
        this.connections = opts.connections;
        this.tokenStore = opts.tokenStore;
        this.accountAliases = normalizeAliasSet(opts.accountAliases);
        this.accountAliasesByConnection = opts.accountAliasesByConnection && typeof opts.accountAliasesByConnection === 'object' ? opts.accountAliasesByConnection : null;
        this.accountPolicies = opts.accountPolicies && typeof opts.accountPolicies === 'object' ? opts.accountPolicies : {};
        this.ignoredAccountIds = opts.ignoredAccountIds && typeof opts.ignoredAccountIds === 'object' ? opts.ignoredAccountIds : {};
        this.expectedInstitutions = opts.expectedInstitutions && typeof opts.expectedInstitutions === 'object' ? { ...opts.expectedInstitutions } : {};
        this.requireExpectedInstitutions = opts.requireExpectedInstitutions === true;
        this.cleanupPlan = typeof opts.cleanupPlan === 'function' ? opts.cleanupPlan : null;
        this.clientName = text(opts.clientName || 'Budget Tool');
        this.redirectUri = text(opts.redirectUri);
        if (this.redirectUri) {
            try {
                const parsed = new URL(this.redirectUri);
                if (parsed.protocol !== 'https:' || parsed.origin !== PRODUCTION_ORIGIN || parsed.hash) throw new Error('invalid redirect');
            } catch (_) { throw new Error('Production provider configuration is incomplete.'); }
        }
        this.clock = typeof opts.clock === 'function' ? opts.clock : () => new Date().toISOString();
        this.linkReservationTtlMs = Number.isSafeInteger(opts.linkReservationTtlMs) && opts.linkReservationTtlMs > 0 ? opts.linkReservationTtlMs : 10 * 60 * 1000;
    }

    connectionKey(value) { return this.connections.assertKey(value); }

    aliasesFor(key) {
        if (this.accountAliasesByConnection) return normalizeAliasSet(this.accountAliasesByConnection[key]);
        return this.accountAliases;
    }

    async createLinkToken(auth, input) {
        const body = input || {};
        const key = this.connectionKey(body.connectionKey);
        const mode = text(body.mode || 'create').toLowerCase();
        let replacementClaim = null;
        let sessionId = text(body.sessionId || body.linkSessionId || body.requestId);
        if (!sessionId) sessionId = crypto.randomUUID();
        const request = {
            user: { client_user_id: text(auth && auth.uid) },
            client_name: this.clientName,
            language: 'en',
            country_codes: ['US'],
            products: ['transactions'],
            ...(this.redirectUri ? { redirect_uri: this.redirectUri } : {})
        };
        if (!request.user.client_user_id) throw new Error('Production app-user authorization is not configured.');
        if (mode === 'update') {
            const connection = await this.connections.getAuthorized(key, auth);
            const accessToken = await this.tokenStore.resolveAccessToken(key, connection.secretVersion);
            request.access_token = accessToken;
            request.products = undefined;
        } else if (mode !== 'create') {
            throw new Error('Provider connection key is not configured.');
        } else {
            const lookup = typeof this.connections.getForCreate === 'function' ? this.connections.getForCreate.bind(this.connections) : this.connections.getAuthorized.bind(this.connections);
            const existing = await lookup(key, auth, { includeLedger: true, sessionId }).catch(error => {
                if (error && error.message === 'Provider connection is not configured.') return null;
                throw error;
            });
            if (existing && existing.itemId) throw new Error('Link exchange cannot replace an existing Item.');
            if (existing && existing.exchangeLedger && Object.values(existing.exchangeLedger).some(entry => entry && (entry.status === 'started' || entry.status === 'pending-binding' || entry.status === 'needs-reconciliation'))) throw new Error('Link exchange requires reconciliation before retrying.');
            if (existing && existing.retiredCleanup && existing.retiredCleanup.status === 'removed') replacementClaim = { replacementOwnerUid: existing.retiredCleanup.replacementOwnerUid, cleanupDigest: existing.retiredCleanup.cleanupDigest };
            // Institution selection is verified from the exchanged Item on
            // the server. Plaid Link create does not receive a guessed or
            // browser-authoritative institution identifier here.
        }
        if (mode === 'create') await this.connections.reserveLinkToken(key, auth, sessionId, mode, this.linkReservationTtlMs, replacementClaim);
        try {
            const response = await providerMethod(this.client, ['linkTokenCreate', 'createLinkToken'], request).catch(() => { throw new Error('Plaid Link request failed.'); });
            const linkToken = normalizeLinkToken(response);
            if (mode === 'create') await this.connections.completeLinkToken(key, auth, sessionId);
            return { connectionKey: key, mode, sessionId, linkToken };
        } catch (error) {
            if (mode === 'create') await this.connections.markLinkTokenNeedsReconciliation(key, auth, sessionId);
            throw error;
        }
    }

    async exchange(auth, input) {
        const body = input || {};
        const key = this.connectionKey(body.connectionKey);
        const publicToken = text(body.publicToken || body.public_token);
        if (publicToken.length > 4096) throw new Error('A public token is required.');
        const exchangeId = requestId(body.requestId || body.idempotencyKey, 'A Link exchange request ID');
        let claim;
        let existing;
        let recovered = false;
        try {
            existing = await this.connections.getAuthorized(key, auth, { includeLedger: true });
        } catch (error) {
            if (!error || error.message !== 'Provider connection is not configured.') throw error;
        }
        const existingLedger = existing && existing.exchangeLedger && existing.exchangeLedger[exchangeId];
        if (existingLedger && existingLedger.status === 'started' && typeof this.tokenStore.findAccessTokenReference === 'function') {
            if (publicToken && existingLedger.publicTokenDigest !== digest(publicToken)) throw new Error('Link exchange requires reconciliation before retrying.');
            const recoveredReference = await this.tokenStore.findAccessTokenReference(key, { exchangeId, ownerUid: auth && auth.uid, householdId: auth && auth.householdId });
            if (recoveredReference) {
                recovered = true;
                claim = {
                    status: 'pending-binding',
                    exchange: {
                        status: 'pending-binding',
                        exchangeId,
                        itemId: recoveredReference.itemId,
                        secretName: recoveredReference.secretName,
                        secretVersion: recoveredReference.versionName
                    }
                };
            } else {
                throw new Error('Link exchange is already in progress; retry with the same request ID.');
            }
        } else {
            claim = await this.connections.claimExchange(key, auth, exchangeId, publicToken);
        }
        if (claim.status === 'complete') return publicExchangeResult(claim.result);
        let exchanged;
        let staged;
        let recoverable = claim.status === 'pending-binding';
        try {
            if (claim.status === 'started' && typeof this.tokenStore.prepareForExchange === 'function') {
                await this.tokenStore.prepareForExchange(key, { exchangeId, ownerUid: auth && auth.uid, householdId: auth && auth.householdId });
            }
            if (claim.status === 'pending-binding') {
                staged = claim.exchange;
                if (recovered) staged = (await this.connections.stageExchange(key, auth, exchangeId, { itemId: staged.itemId, secretName: staged.secretName, secretVersion: staged.secretVersion })).exchange;
                exchanged = { itemId: text(staged && staged.itemId), accessToken: await this.tokenStore.resolveAccessToken(key, staged && staged.secretVersion) };
            } else {
                exchanged = normalizeExchange(await providerMethod(this.client, ['itemPublicTokenExchange', 'exchangePublicToken'], { public_token: publicToken }));
                const stored = await this.tokenStore.setAccessToken(key, exchanged.accessToken, { exchangeId, ownerUid: auth && auth.uid, householdId: auth && auth.householdId, itemId: exchanged.itemId });
                // The vault binding is durable before this fallible repository
                // write. A retry can recover it without re-exchanging a one-use
                // public token if the process stops between these operations.
                recoverable = typeof this.tokenStore.findAccessTokenReference === 'function';
                staged = await this.connections.stageExchange(key, auth, exchangeId, { itemId: exchanged.itemId, secretName: stored.secretName, secretVersion: stored.versionName });
                staged = staged.exchange;
            }
            const expectedInstitution = text(this.expectedInstitutions[key]);
            if (this.requireExpectedInstitutions && !expectedInstitution) throw new Error('Provider institution is not configured.');
            if (expectedInstitution) {
                const itemResponse = await providerMethod(this.client, ['itemGet', 'getItem'], { access_token: exchanged.accessToken });
                const item = normalizeProviderResponse(itemResponse).item || {};
                if (text(item.institution_id || item.institutionId) !== expectedInstitution) throw new Error('Provider institution is not configured.');
            }
            const accounts = normalizeAccounts(await providerMethod(this.client, ['accountsGet', 'getAccounts'], { access_token: exchanged.accessToken }));
            const bindings = body.accountBindings || body.accountMap;
            if (!bindings) return publicPendingExchangeResult({ connectionKey: key, exchangeId, itemId: exchanged.itemId, accounts });
            const accountMap = normalizeAccountBindings(accounts, bindings, this.aliasesFor(key), this.ignoredAccountIds[key], this.accountPolicies[key]);
            const result = await this.connections.completeExchange(key, auth, exchangeId, {
                itemId: exchanged.itemId,
                accounts,
                accountMap,
                secretName: staged && staged.secretName,
                secretVersion: staged && staged.secretVersion
            });
            return publicExchangeResult(result);
        } catch (error) {
            if (!recoverable) await this.connections.markNeedsReconciliation(key, auth, exchangeId);
            if (error && SAFE_LINK_ERROR_MESSAGES.has(error.message)) throw error;
            throw new Error('Plaid Link request failed.');
        }
    }

    async status(auth, input) {
        const body = input || {};
        const key = this.connectionKey(body.connectionKey);
        const exchangeId = requestId(body.requestId || body.idempotencyKey, 'A Link exchange request ID');
        const connection = await this.connections.getAuthorized(key, auth, { includeLedger: true });
        let ledger = connection.exchangeLedger && connection.exchangeLedger[exchangeId];
        if (ledger && ledger.status === 'complete') return publicExchangeResult(ledger.result);
        if (ledger && ledger.status === 'started' && typeof this.tokenStore.findAccessTokenReference === 'function') {
            const recovered = await this.tokenStore.findAccessTokenReference(key, { exchangeId, ownerUid: auth && auth.uid, householdId: auth && auth.householdId });
            if (recovered) {
                const staged = await this.connections.stageExchange(key, auth, exchangeId, { itemId: recovered.itemId, secretName: recovered.secretName, secretVersion: recovered.versionName });
                ledger = staged.exchange;
            }
        }
        if (!ledger || ledger.status !== 'pending-binding') throw new Error('Link exchange is not pending.');
        const accessToken = await this.tokenStore.resolveAccessToken(key, ledger.secretVersion);
        const expectedInstitution = text(this.expectedInstitutions[key]);
        if (this.requireExpectedInstitutions && !expectedInstitution) throw new Error('Provider institution is not configured.');
        if (expectedInstitution) {
            const itemResponse = await providerMethod(this.client, ['itemGet', 'getItem'], { access_token: accessToken });
            const item = normalizeProviderResponse(itemResponse).item || {};
            if (text(item.institution_id || item.institutionId) !== expectedInstitution) throw new Error('Provider institution is not configured.');
        }
        const accounts = normalizeAccounts(await providerMethod(this.client, ['accountsGet', 'getAccounts'], { access_token: accessToken }));
        return publicPendingExchangeResult({ connectionKey: key, exchangeId, itemId: ledger.itemId, accounts });
    }

    async disconnect(auth, input) {
        if (typeof this.cleanupPlan !== 'function') throw new Error('Cleanup is not configured.');
        const body = input || {};
        const plan = await this.cleanupPlan(auth, body.connectionKey);
        const db = this.connections.db;
        const ref = this.connections.ref(plan.targetKey);
        const targetSnapshot = await db.collection(this.connections.collectionName).doc(plan.targetKey).get();
        const target = targetSnapshot && targetSnapshot.exists ? targetSnapshot.data() || {} : {};
        const existingAttempt = target.disconnectLedger && target.disconnectLedger[plan.targetExchangeId];
        if (existingAttempt && ['started', 'ambiguous'].includes(existingAttempt.status)) throw new Error('Cleanup requires reconciliation before retrying.');
        const accessToken = await this.tokenStore.resolveAccessToken(plan.targetKey, plan.targetSecretVersion);
        const itemResponse = await providerMethod(this.client, ['itemGet', 'getItem'], { access_token: accessToken });
        const item = normalizeProviderResponse(itemResponse).item || {};
        if (text(item.item_id || item.itemId) !== plan.targetItemId || text(item.institution_id || item.institutionId) !== plan.targetInstitution) throw new Error('Provider item does not match cleanup target.');
        const claim = await db.runTransaction(async transaction => {
            const snapshot = await transaction.get(ref);
            const configSnapshot = await transaction.get(db.collection(plan.configCollection).doc(plan.configDocument));
            const finalizedSnapshot = await transaction.get(db.collection(plan.connectionCollection).doc(plan.finalKey));
            const current = snapshot && snapshot.exists ? snapshot.data() || {} : {};
            const config = configSnapshot && configSnapshot.exists ? configSnapshot.data() || {} : {};
            const finalized = finalizedSnapshot && finalizedSnapshot.exists ? finalizedSnapshot.data() || {} : {};
            this.connections.authorizeRecord(current, auth, false);
            if (!cleanupStateValid(config, current, finalized, plan, auth, text(auth && auth.householdId))) throw new Error('Cleanup target preconditions are not met.');
            const attempt = current.disconnectLedger && current.disconnectLedger[plan.targetExchangeId];
            if (attempt && attempt.status === 'removed') return { status: 'removed' };
            if (attempt && ['started', 'ambiguous'].includes(attempt.status)) throw new Error('Cleanup requires reconciliation before retrying.');
            const next = clone(current);
            next.disconnectLedger = next.disconnectLedger || {};
            next.disconnectLedger[plan.targetExchangeId] = { status: 'started', targetItemId: plan.targetItemId, startedAt: this.clock() };
            transaction.set(ref, next);
            return { status: 'started' };
        });
        if (claim.status === 'removed') return { status: 'removed', connectionKey: plan.targetKey };
        let providerRemoved = false;
        try {
            const removed = normalizeProviderResponse(await providerMethod(this.client, ['itemRemove', 'removeItem'], { access_token: accessToken }));
            const providerRequestId = text(removed.request_id || removed.requestId);
            if (!providerRequestId) throw new Error('Provider cleanup failed.');
            providerRemoved = true;
            await db.runTransaction(async transaction => {
                const snapshot = await transaction.get(ref);
                const configSnapshot = await transaction.get(db.collection(plan.configCollection).doc(plan.configDocument));
                const finalizedSnapshot = await transaction.get(db.collection(plan.connectionCollection).doc(plan.finalKey));
                const current = snapshot && snapshot.exists ? snapshot.data() || {} : {};
                const config = configSnapshot && configSnapshot.exists ? configSnapshot.data() || {} : {};
                const finalized = finalizedSnapshot && finalizedSnapshot.exists ? finalizedSnapshot.data() || {} : {};
                this.connections.authorizeRecord(current, auth, false);
                if (!cleanupStateValid(config, current, finalized, plan, auth, text(auth && auth.householdId))) throw new Error('Cleanup target preconditions are not met.');
                const attempt = current.disconnectLedger && current.disconnectLedger[plan.targetExchangeId];
                if (!attempt || attempt.status !== 'started') throw new Error('Cleanup requires reconciliation before retrying.');
                const next = clone(current);
                next.disconnectLedger[plan.targetExchangeId] = { ...attempt, status: 'removed', providerRequestDigest: digest(providerRequestId), completedAt: this.clock() };
                if (next.pendingExchange && text(next.pendingExchange.exchangeId) === plan.targetExchangeId) delete next.pendingExchange;
                if (next.linkReservation && text(next.linkReservation.sessionId || next.linkReservation.exchangeId) === plan.targetExchangeId) delete next.linkReservation;
                if (next.exchangeLedger && next.exchangeLedger[plan.targetExchangeId]) delete next.exchangeLedger[plan.targetExchangeId];
                next.retiredCleanup = {
                    status: 'removed',
                    removedAt: this.clock(),
                    targetConnectionKey: plan.targetKey,
                    targetItemId: plan.targetItemId,
                    targetInstitution: plan.targetInstitution,
                    targetExchangeId: plan.targetExchangeId,
                    oldOwnerUid: text(current.ownerUid),
                    replacementOwnerUid: plan.replacementOwnerUid,
                    finalConnectionKey: plan.finalKey,
                    finalItemId: plan.finalItemId,
                    cleanupDigest: plan.cleanupDigest
                };
                transaction.set(ref, next);
            });
            return { status: 'removed', connectionKey: plan.targetKey };
        } catch (error) {
            if (providerRemoved) throw new Error('Cleanup requires reconciliation before retrying.');
            try {
                await db.runTransaction(async transaction => {
                    const snapshot = await transaction.get(ref);
                    const current = snapshot && snapshot.exists ? snapshot.data() || {} : {};
                    const attempt = current.disconnectLedger && current.disconnectLedger[plan.targetExchangeId];
                    if (attempt && attempt.status === 'started') {
                        const next = clone(current);
                        next.disconnectLedger[plan.targetExchangeId] = { ...attempt, status: 'ambiguous' };
                        transaction.set(ref, next);
                    }
                });
            } catch (_) { /* Preserve fail-closed cleanup state if marking fails. */ }
            if (error && SAFE_LINK_ERROR_MESSAGES.has(error.message)) throw error;
            throw new Error('Provider cleanup failed.');
        }
    }

    async update(auth, input) {
        return this.createLinkToken(auth, { ...(input || {}), mode: 'update' });
    }
}

function safeLinkError(error) {
    const message = text(error && error.message);
    return SAFE_LINK_ERROR_MESSAGES.has(message) ? message : 'Plaid Link request failed.';
}

function responseJson(response, status, body) {
    response.statusCode = status;
    if (typeof response.setHeader === 'function') {
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
    }
    response.end(JSON.stringify(body));
}

function applyExactCors(request, response, origin) {
    const requested = text(request && request.headers && (request.headers.origin || request.headers.Origin));
    if (requested && requested !== origin) throw new Error('CORS origin is not allowed.');
    if (requested && typeof response.setHeader === 'function') {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Allow-Credentials', 'true');
        response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    }
}

function createProductionHttpHandler(options) {
    const opts = options || {};
    if (typeof opts.reviewHandler !== 'function' || typeof opts.authenticate !== 'function' || !opts.lifecycle) throw new Error('Production HTTP handler configuration is incomplete.');
    const origin = text(opts.allowedOrigin || PRODUCTION_ORIGIN);
    if (origin !== PRODUCTION_ORIGIN) throw new Error('Production HTTP handler requires the exact GitHub Pages origin.');
    const limit = maxBodyBytes(opts.maxBodyBytes);
    const lifecycle = opts.lifecycle;
    const routeType = pathname => {
        const routes = {
            '/link-token': 'create', '/link/create': 'create', '/plaid/link-token': 'create', '/plaid/link/create': 'create',
            '/link-exchange': 'exchange', '/link/exchange': 'exchange', '/plaid/exchange': 'exchange', '/plaid/link/exchange': 'exchange',
            '/link-update': 'update', '/link/update': 'update', '/plaid/update': 'update', '/plaid/link/update': 'update',
            '/link-status': 'status', '/link/status': 'status', '/plaid/status': 'status', '/plaid/link/status': 'status',
            '/link-disconnect': 'disconnect', '/link/disconnect': 'disconnect', '/plaid/disconnect': 'disconnect', '/plaid/link/disconnect': 'disconnect'
        };
        return routes[pathname] || null;
    };
    return async function productionHttpHandler(request, response) {
        let path = '/';
        try {
            path = new URL(request && request.url || '/', 'http://localhost').pathname;
            applyExactCors(request, response, origin);
            if (request && request.method === 'OPTIONS') return responseJson(response, 204, {});
            const type = routeType(path);
            if (path === '/sync-readiness' && request && request.method === 'GET') {
                const auth = await opts.authenticate(request);
                if (typeof opts.syncReadiness !== 'function') throw new Error('Sync activation is not ready.');
                const readiness = await opts.syncReadiness(auth);
                return responseJson(response, 200, { ready: readiness && readiness.ready === true, revision: readiness && readiness.revision, cutoffDate: readiness && readiness.cutoffDate, cutoffRevision: readiness && readiness.cutoffRevision, connectionKeys: readiness && readiness.connectionKeys });
            }
            if (path === '/sync-settings' && request && ['GET', 'POST'].includes(text(request.method).toUpperCase())) {
                const auth = await opts.authenticate(request);
                if (!opts.syncSettings) throw new Error('Sync settings are not configured.');
                const body = request.method === 'GET' ? {} : await readRequestBody(request, { maxBodyBytes: limit });
                const result = request.method === 'GET' ? await opts.syncSettings.read(auth) : await opts.syncSettings.update(auth, body.cutoffDate, body.expectedRevision);
                return responseJson(response, 200, result);
            }
            if (type && (!request || request.method !== 'POST')) return responseJson(response, 404, { error: 'Route not found.' });
            if (!type) return opts.reviewHandler(adaptParsedRequest(request, limit), response);
            const auth = await opts.authenticate(request);
            if (opts.linkEnabled !== true) throw new Error('Provider Link operations are disabled by server configuration.');
            const body = request && request.method === 'GET' ? {} : await readRequestBody(request, { maxBodyBytes: limit });
            const result = type === 'create' ? await lifecycle.createLinkToken(auth, body) : type === 'exchange' ? await lifecycle.exchange(auth, body) : type === 'update' ? await lifecycle.update(auth, body) : type === 'disconnect' ? await lifecycle.disconnect(auth, body) : await lifecycle.status(auth, body);
            return responseJson(response, 200, result);
        } catch (error) {
            const message = safeLinkError(error);
            const status = message === 'CORS origin is not allowed.' ? 403 : /authorization|user|household|Bearer|membership|existing app user/i.test(message) ? 401 : /required|configured|invalid|reconciliation|existing Item|bindings|mapping|cleanup|sync|cutoff|settings|future/i.test(message) ? 409 : 500;
            return responseJson(response, status, { error: message });
        }
    };
}

function createProductionAuthenticator(options) {
    const opts = options || {};
    const admin = opts.admin;
    if (!admin || typeof admin.auth !== 'function') throw new Error('A production Firebase Admin authorization client is required.');
    const allowlistValues = (opts.allowedUsers || []).map(text).filter(Boolean);
    const allowedEmails = new Set(allowlistValues.filter(value => /@/.test(value)).map(value => value.toLowerCase()));
    const allowedUids = new Set(allowlistValues.filter(value => !/@/.test(value)));
    const resolver = typeof opts.existingAppUserResolver === 'function' ? opts.existingAppUserResolver : null;
    const expectedHouseholdSource = String(opts.householdId ?? '');
    const expectedHousehold = expectedHouseholdSource.trim();
    if (!allowedEmails.size && !allowedUids.size && !resolver) throw new Error('Production app-user authorization is not configured.');
    if (!expectedHousehold && !resolver) throw new Error('Authenticated household membership is not configured.');
    return async request => {
        const header = request && request.headers && (request.headers.authorization || request.headers.Authorization);
        const match = /^Bearer\s+(.+)$/i.exec(text(header));
        if (!match) throw new Error('Bearer authentication is required.');
        let decoded;
        try { decoded = await admin.auth().verifyIdToken(match[1], true); } catch (_) { throw new Error('Authenticated user is not an existing app user.'); }
        const sourceUid = String(decoded && decoded.uid || '');
        const rawUid = sourceUid.trim();
        const uid = rawUid;
        const sourceEmail = String(decoded && decoded.email || '');
        const rawEmail = sourceEmail.trim();
        const email = rawEmail.toLowerCase();
        if (!uid || sourceUid !== uid || !validUid(uid) || !email || sourceEmail !== email || !validEmail(email) || decoded.email_verified !== true) throw new Error('Authenticated user is not an existing app user.');
        let resolved = null;
        if (resolver) {
            try { resolved = await resolver(decoded); } catch (_) { resolved = null; }
            if (!resolved || resolved.allowed !== true) throw new Error('Authenticated user is not an existing app user.');
        } else if (!allowedEmails.has(email) && !allowedUids.has(uid)) {
            throw new Error('Authenticated user is not an existing app user.');
        }
        const householdId = text(resolved && resolved.householdId || expectedHousehold);
        if (expectedHouseholdSource !== expectedHousehold || !validHouseholdId(householdId)) throw new Error('Authenticated household membership is not configured.');
        if (expectedHousehold && householdId !== expectedHousehold) throw new Error('User is not a member of this household.');
        return { uid, email, householdId, tokenVerified: true, existingAppUser: true, authTime: decoded.auth_time };
    };
}

function createFirestoreExistingAppUserResolver(options) {
    const opts = options || {};
    if (!opts.db || typeof opts.db.collection !== 'function') throw new Error('Authenticated household membership is not configured.');
    const collection = text(opts.collection || 'protectedAppUsers');
    const expectedHouseholdSource = String(opts.householdId ?? '');
    const expectedHousehold = expectedHouseholdSource.trim();
    const configCollection = text(opts.configCollection || 'protectedAppConfig');
    const configDocument = text(opts.configDocument || 'transactionService');
    // The deployed resolver has one authority: an operator-seeded UID document
    // at the fixed protectedAppUsers/{uid} path. A legacy allowlist may narrow
    // synthetic/test callers by UID, but an email roster never bypasses the
    // membership document.
    const configuredUids = new Set((opts.allowedUsers || []).filter(value => !/@/.test(text(value))).map(text).filter(Boolean));
    const hasUidNarrowing = configuredUids.size > 0;
    return async decoded => {
        const sourceUid = String(decoded && decoded.uid || '');
        const rawUid = sourceUid.trim();
        const uid = rawUid;
        const sourceEmail = String(decoded && decoded.email || '');
        const rawEmail = sourceEmail.trim();
        const email = rawEmail.toLowerCase();
        if (!decoded || !uid || sourceUid !== uid || !validUid(uid) || !email || sourceEmail !== email || !validEmail(email) || decoded.email_verified !== true) return { allowed: false };
        if (hasUidNarrowing && !configuredUids.has(uid)) return { allowed: false };
        const snapshot = await opts.db.collection(collection).doc(uid).get();
        const value = snapshot && snapshot.exists ? snapshot.data() || {} : {};
        // Keep the resolver contract identical to the protected Firestore
        // membership document: UID is exact-case and the stored email is
        // compared in normalized lowercase form. A missing UID must never
        // fall back to the path UID.
        const storedUidSource = String(value.uid ?? '');
        const storedUid = storedUidSource.trim();
        const storedEmailSource = String(value.email ?? '');
        const storedEmail = storedEmailSource.trim();
        if (value.allowed !== true || storedUidSource !== storedUid || storedUid !== uid || storedEmailSource !== storedEmail || !storedEmail || storedEmail !== storedEmail.toLowerCase() || storedEmail !== email) return { allowed: false };
        const householdSource = String(value.householdId ?? '');
        const householdId = householdSource.trim();
        // The sealed membership document is checked against the fixed
        // protected household configuration. A new Auth custom claim is not
        // required merely to bind an already approved app user.
        const configSnapshot = await opts.db.collection(configCollection).doc(configDocument).get();
        const config = configSnapshot && configSnapshot.exists ? configSnapshot.data() || {} : {};
        const configuredHouseholdSource = String(config.householdId ?? '');
        const configuredHousehold = configuredHouseholdSource.trim();
        if (config.allowed !== true || configuredHouseholdSource !== configuredHousehold || householdSource !== householdId || expectedHouseholdSource !== expectedHousehold || !validHouseholdId(configuredHousehold) || !validHouseholdId(householdId) || householdId !== configuredHousehold || expectedHousehold && (!validHouseholdId(expectedHousehold) || householdId !== expectedHousehold)) return { allowed: false };
        return { allowed: true, householdId };
    };
}

function createProductionService(options) {
    const opts = options || {};
    const householdSource = String(opts.householdId ?? '');
    const householdId = householdSource.trim();
    const allowedUsers = Array.isArray(opts.allowedUsers) ? opts.allowedUsers.slice() : [];
    const allowedUserIds = allowedUsers.filter(value => !/@/.test(text(value)));
    const allowedUserEmails = allowedUsers.filter(value => /@/.test(text(value)));
    if (householdSource !== householdId || !validHouseholdId(householdId) || (!allowedUsers.length && typeof opts.existingAppUserResolver !== 'function')) throw new Error('Production app-user authorization is not configured.');
    if (!opts.db) throw new Error('Production provider configuration is incomplete.');
    const authenticate = opts.authenticate || createProductionAuthenticator(opts);
    const connections = opts.connections || new FirestoreProviderConnectionRepository({
        db: opts.db,
        collection: opts.connectionsCollection,
        allowedConnectionKeys: opts.allowedConnectionKeys,
        clock: opts.clock
    });
    const tokenStore = opts.tokenStore || new SecretManagerTokenStore({
        client: opts.secretManagerClient,
        projectId: opts.projectId,
        secretNames: opts.secretNames,
        secretPrefix: opts.secretPrefix,
        cacheTtlMs: opts.secretCacheTtlMs,
        clock: opts.clock
    });
    const lifecycle = opts.lifecycle || new PlaidLinkLifecycle({
        client: opts.plaidClient,
        connections,
        tokenStore,
        accountAliases: opts.accountAliases,
        accountAliasesByConnection: opts.accountAliasesByConnection,
        accountPolicies: opts.accountPolicies,
        ignoredAccountIds: opts.ignoredAccountIds,
        expectedInstitutions: opts.expectedInstitutions,
        requireExpectedInstitutions: opts.requireExpectedInstitutions === true,
        cleanupPlan: opts.cleanupPlan,
        clientName: opts.clientName,
        redirectUri: opts.redirectUri,
        clock: opts.clock
    });
    const dynamicProvider = opts.provider || (opts.plaidSyncClient ? {
        async fetchDelta(input) {
            const connection = await connections.getAuthorized(input.connectionKey, input.user);
            const adapter = new backendApi.PlaidTransactionsSyncAdapter({
                client: opts.plaidSyncClient,
                accountMap: connection.accountMap,
                ignoredAccountIds: opts.ignoredAccountIds && opts.ignoredAccountIds[input.connectionKey],
                maxPages: opts.maxPages,
                maxRetries: opts.maxRetries,
                maxMutationRestarts: opts.maxMutationRestarts,
                backoffMs: opts.backoffMs,
                clock: opts.clock,
                resolveRemoved: opts.resolveRemoved,
                classify: opts.classify
            });
            return adapter.fetchDelta({ ...input, accessToken: await tokenStore.resolveAccessToken(input.connectionKey, connection.secretVersion) });
        }
    } : undefined);
    const composed = createBudgetService({
        db: opts.db,
        householdId,
        allowedUsers: allowedUserEmails,
        allowedUserIds,
        allowExistingAppUserClaim: typeof opts.existingAppUserResolver === 'function',
        authenticate,
        allowedOrigins: [PRODUCTION_ORIGIN],
        reviewCollection: opts.reviewCollection,
        acceptedCollection: opts.acceptedCollection,
        acceptedDocumentId: opts.acceptedDocumentId || 'data',
        syncEnabled: opts.syncEnabled === true,
        syncReadiness: opts.syncReadiness,
        accountAliases: opts.accountAliases,
        connectionEnabled: opts.connectionEnabled || (async (key, auth) => {
            const active = new Set((opts.activeConnectionKeys || []).map(text).filter(Boolean));
            if (!active.has(text(key))) return false;
            const record = await connections.getAuthorized(key, auth);
            return record.enabled === true;
        }),
        connectionDisabled: opts.connectionDisabled,
        connectionOwner: async key => connections.getOwner(key, householdId),
        connectionResolver: async (key, auth) => { const connection = await connections.getAuthorized(key, auth); return { accessToken: await tokenStore.resolveAccessToken(key, connection.secretVersion), accountMap: connection.accountMap }; },
        provider: dynamicProvider,
        syncConnectionKeys: Array.isArray(opts.allowedConnectionKeys) && opts.allowedConnectionKeys.length ? opts.allowedConnectionKeys : ['chase', 'capital-one'],
        syncConfigCollection: opts.configCollection || 'protectedAppConfig',
        syncConfigDocument: opts.configDocument || 'transactionService',
        syncConnectionsCollection: 'protectedConnections',
        maxDurationMs: opts.syncDeadlineMs,
        clock: opts.clock,
        errorDiagnostic: opts.errorDiagnostic
    });
    const handler = createProductionHttpHandler({ reviewHandler: composed.handler, authenticate, lifecycle, linkEnabled: opts.linkEnabled === true, syncReadiness: opts.syncReadiness, syncSettings: composed.syncSettings, allowedOrigin: PRODUCTION_ORIGIN, maxBodyBytes: opts.maxBodyBytes });
    return Object.freeze({ ...composed, authenticate, connections, tokenStore, lifecycle, handler, allowedOrigin: PRODUCTION_ORIGIN });
}

module.exports = {
    PRODUCTION_ORIGIN,
    MAX_EXCHANGE_LEDGER_ENTRIES,
    SecretManagerTokenStore,
    FirestoreEncryptedTokenStore,
    FirestoreProviderConnectionRepository,
    PlaidLinkLifecycle,
    createProtectedDisconnectPlan,
    createProtectedSyncReadiness,
    mappingMetadataDigest,
    createProductionAuthenticator,
    createFirestoreExistingAppUserResolver,
    createProductionHttpHandler,
    createProductionService,
    readRequestBody,
    adaptParsedRequest,
    normalizeAccountBindings
};

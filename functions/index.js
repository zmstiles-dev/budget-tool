/*
 * Firebase Functions 2nd-gen entry point for the production transaction
 * service. Runtime configuration is intentionally explicit: no environment
 * enumeration, service-account key loading, or provider secret logging.
 */
'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
const config = require('./lib/transaction-config.js');
const production = require('./lib/production-service.js');

const TARGET_PROJECT_ID = 'budget-tool-sync';
const RUNTIME_SERVICE_ACCOUNT = 'budget-transactions-runtime@budget-tool-sync.iam.gserviceaccount.com';
const PINNED_MEMBERSHIP_COLLECTION = 'protectedAppUsers';
const PINNED_CONFIG_COLLECTION = 'protectedAppConfig';
const PINNED_CONFIG_DOCUMENT = 'transactionService';
const HOUSEHOLD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const registeredApps = typeof admin.getApps === 'function' ? admin.getApps() : admin.apps || [];
if (!registeredApps.length) admin.initializeApp();

function firebaseApp() {
    return typeof admin.getApp === 'function' ? admin.getApp() : admin.app();
}

function firebaseFirestore() {
    return typeof admin.firestore === 'function' ? admin.firestore() : getFirestore();
}

function firebaseAuth() {
    return typeof admin.auth === 'function' ? admin.auth() : getAuth();
}

const secretClient = new SecretManagerServiceClient();
let runtimePromise;

function configuredList(name) {
    return String(process.env[name] || '').split(',').map(value => value.trim()).filter(Boolean);
}

function secretName(name) {
    const value = String(process.env[name] || '').trim();
    return value;
}

async function resolveSecret(name) {
    if (!/^projects\/[^/]+\/secrets\/[A-Za-z0-9_-]+$/.test(name)) throw new Error('Production provider configuration is incomplete.');
    try {
        const [response] = await secretClient.accessSecretVersion({ name: `${name}/versions/latest` });
        const value = response && response.payload && response.payload.data;
        const secret = Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '');
        if (!secret || secret.length > 4096) throw new Error('empty secret');
        return secret;
    } catch (_) {
        throw new Error('Secret resolution failed.');
    }
}

function lazyPlaidClient(clientId, clientSecretName, dependencies) {
    const deps = dependencies || {};
    const resolveClientSecret = typeof deps.resolveSecret === 'function' ? deps.resolveSecret : resolveSecret;
    const PlaidClient = deps.PlaidApi || PlaidApi;
    let clientPromise;
    const client = async () => {
        if (!clientPromise) clientPromise = resolveClientSecret(clientSecretName).then(clientSecret => new PlaidClient(new Configuration({
            basePath: PlaidEnvironments.production,
            baseOptions: { timeout: 10000, headers: { 'PLAID-CLIENT-ID': clientId, 'PLAID-SECRET': clientSecret } }
        })));
        return clientPromise;
    };
    const call = method => (...args) => client().then(value => value[method](...args));
    const transactionsSync = async (request, control) => {
        const input = request || {};
        const accessToken = String(input.access_token || '').trim();
        if (!accessToken) throw new Error('Production provider configuration is incomplete.');
        const payload = {
            access_token: accessToken,
            cursor: String(input.cursor || ''),
            count: 500
        };
        const options = { timeout: 10000 };
        const deadlineAt = control && Number.isSafeInteger(control.deadlineAt) ? control.deadlineAt : null;
        if (deadlineAt !== null) {
            const remaining = deadlineAt - Date.now();
            if (remaining <= 0) throw new Error('Plaid sync exceeded its bounded execution window.');
            options.timeout = Math.max(1, Math.min(10000, remaining));
        }
        if (control && control.signal) options.signal = control.signal;
        const value = await client();
        // Keep adapter timing controls in Axios options. They must never be
        // serialized into Plaid's transactions/sync request body.
        return value.transactionsSync(payload, options);
    };
    return {
        linkTokenCreate: call('linkTokenCreate'),
        itemPublicTokenExchange: call('itemPublicTokenExchange'),
        accountsGet: call('accountsGet'),
        itemGet: call('itemGet'),
        transactionsSync
    };
}

function connectionConfig(options) {
    const requireProvider = options && options.requireProvider === true;
    const keys = configuredList('BUDGET_CONNECTION_KEYS');
    const secretNames = {};
    const expectedInstitutions = {};
    for (const key of keys) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(key)) throw new Error('Production provider configuration is incomplete.');
        const value = secretName(`BUDGET_SECRET_NAME_${key.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`);
        if (requireProvider && !value) throw new Error('Production provider configuration is incomplete.');
        if (value) secretNames[key] = value;
        const institution = secretName(`BUDGET_EXPECTED_INSTITUTION_${key.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`);
        if (institution) expectedInstitutions[key] = institution;
    }
    const activeKeys = configuredList('BUDGET_ACTIVE_CONNECTION_KEYS');
    if (activeKeys.some(key => !keys.includes(key))) throw new Error('Production provider configuration is incomplete.');
    return { keys, secretNames, expectedInstitutions, activeKeys };
}

async function createRuntime() {
    const projectId = String(process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || firebaseApp().options.projectId || '').trim();
    const householdSource = String(process.env.BUDGET_HOUSEHOLD_ID || '');
    const householdId = householdSource.trim();
    const configuredRoster = configuredList('BUDGET_ALLOWED_APP_USERS');
    const configuredMembershipCollection = String(process.env.BUDGET_MEMBERSHIP_COLLECTION || '').trim();
    const configuredProtectedConfig = String(process.env.BUDGET_PROTECTED_CONFIG_DOCUMENT || '').trim();
    const linkEnabled = String(process.env.BUDGET_LINK_ENABLED || '').trim().toLowerCase() === 'true';
    const syncEnabled = String(process.env.BUDGET_SYNC_ENABLED || '').trim().toLowerCase() === 'true';
    const redirectUri = String(process.env.PLAID_REDIRECT_URI || '').trim();
    const clientId = String(process.env.PLAID_CLIENT_ID || '').trim();
    const clientSecretName = secretName('PLAID_CLIENT_SECRET_NAME');
    const connection = connectionConfig({ requireProvider: linkEnabled || syncEnabled });
    if (projectId !== TARGET_PROJECT_ID || householdSource !== householdId || !HOUSEHOLD_ID_PATTERN.test(householdId)) throw new Error('Production provider configuration is incomplete.');
    if (configuredRoster.length) throw new Error('Production app-user roster overrides are not supported; use protectedAppUsers/{uid} membership documents.');
    if (configuredMembershipCollection && configuredMembershipCollection !== PINNED_MEMBERSHIP_COLLECTION) throw new Error('Production membership path is fixed.');
    if (configuredProtectedConfig && configuredProtectedConfig !== `${PINNED_CONFIG_COLLECTION}/${PINNED_CONFIG_DOCUMENT}`) throw new Error('Production protected configuration path is fixed.');
    if ((linkEnabled || syncEnabled) && (!connection.keys.length || !clientId || !clientSecretName || Object.keys(connection.expectedInstitutions).length !== connection.keys.length)) throw new Error('Production provider configuration is incomplete.');
    if (linkEnabled && (!redirectUri || !/^https:\/\/zmstiles-dev\.github\.io(?:\/[^#]*)?$/.test(redirectUri))) throw new Error('Production provider configuration is incomplete.');
    const providerKeys = connection.keys.length ? connection.keys : ['disabled'];
    const plaid = linkEnabled || syncEnabled
        ? lazyPlaidClient(clientId, clientSecretName)
        : { async linkTokenCreate() { throw new Error('Production provider configuration is incomplete.'); }, async itemPublicTokenExchange() { throw new Error('Production provider configuration is incomplete.'); }, async accountsGet() { throw new Error('Production provider configuration is incomplete.'); } };
    const tokenStore = new production.SecretManagerTokenStore({ client: secretClient, projectId, secretNames: connection.secretNames });
    const plaidSyncClient = linkEnabled || syncEnabled ? { sync: (request, control) => plaid.transactionsSync(request, control).then(result => result && result.data) } : undefined;
    return production.createProductionService({
        db: firebaseFirestore(),
        admin: { auth: firebaseAuth, app: firebaseApp },
        projectId,
        householdId,
        allowedUsers: [],
        existingAppUserResolver: production.createFirestoreExistingAppUserResolver({
            db: firebaseFirestore(),
            collection: PINNED_MEMBERSHIP_COLLECTION,
            householdId,
            configCollection: PINNED_CONFIG_COLLECTION,
            configDocument: PINNED_CONFIG_DOCUMENT
        }),
        allowedConnectionKeys: providerKeys,
        secretManagerClient: secretClient,
        secretNames: connection.secretNames,
        tokenStore,
        plaidClient: plaid,
        plaidSyncClient,
        accountAliases: config.accountDisplayNames,
        accountAliasesByConnection: {
            chase: ['Checking Account', 'CFF', 'CFU', 'CSP'],
            'capital-one': ['Ven X']
        },
        accountPolicies: {
            chase: { aliases: {
                'Checking Account': { types: ['depository'], subtypes: ['checking'], currency: 'USD' },
                CFF: { types: ['credit'], subtypes: ['credit card', 'creditcard'], currency: 'USD' },
                CFU: { types: ['credit'], subtypes: ['credit card', 'creditcard'], currency: 'USD' },
                CSP: { types: ['credit'], subtypes: ['credit card', 'creditcard'], currency: 'USD' }
            } },
            'capital-one': { aliases: { 'Ven X': { types: ['credit'], subtypes: ['credit card', 'creditcard'], currency: 'USD' } } }
        },
        expectedInstitutions: connection.expectedInstitutions,
        requireExpectedInstitutions: true,
        redirectUri,
        activeConnectionKeys: connection.activeKeys,
        linkEnabled,
        syncEnabled,
        maxPages: 20,
        maxRetries: 1,
        maxMutationRestarts: 2,
        backoffMs: 100,
        syncDeadlineMs: 45 * 1000,
        maxBodyBytes: 2 * 1024 * 1024
    });
}

async function runtime() {
    if (!runtimePromise) runtimePromise = createRuntime();
    return runtimePromise;
}

exports.budgetTransactions = onRequest({
    region: 'us-central1',
    serviceAccount: RUNTIME_SERVICE_ACCOUNT,
    minInstances: 0,
    maxInstances: 1,
    timeoutSeconds: 60,
    memory: '256MiB',
    concurrency: 4
}, async (request, response) => {
    try {
        const service = await runtime();
        return service.handler(request, response);
    } catch (_) {
        response.statusCode = 503;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ error: 'Production provider configuration is incomplete.' }));
    }
});

exports.createRuntime = createRuntime;
exports.resolveSecret = resolveSecret;
exports.lazyPlaidClient = lazyPlaidClient;

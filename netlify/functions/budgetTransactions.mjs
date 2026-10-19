import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const FUNCTION_DIR = path.dirname(fileURLToPath(import.meta.url));
const TARGET_PROJECT_ID = 'budget-tool-sync';
const TARGET_RUNTIME_SERVICE_ACCOUNT = 'budget-transactions-runtime@budget-tool-sync.iam.gserviceaccount.com';
const PRODUCTION_ORIGIN = 'https://zmstiles-dev.github.io';
const PINNED_MEMBERSHIP_COLLECTION = 'protectedAppUsers';
const PINNED_CONFIG_COLLECTION = 'protectedAppConfig';
const PINNED_CONFIG_DOCUMENT = 'transactionService';
const TOKEN_VAULT_COLLECTION = 'protectedProviderTokens';
const FUNCTION_ROUTE_PREFIX = '/.netlify/functions/budgetTransactions';
const HOUSEHOLD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const NETLIFY_SITE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const DIAGNOSTIC_STAGES = Object.freeze({
    TRUSTED_CONTEXT: 'trusted-context',
    REQUEST_HOST: 'request-host',
    RUNTIME_CONFIG: 'runtime-config',
    FIREBASE_SDK_IMPORTS: 'firebase-sdk-imports',
    FIREBASE_APP_LOOKUP: 'firebase-app-lookup',
    FIREBASE_APP_VALIDATION: 'firebase-app-validation',
    FIREBASE_CERTIFICATE: 'firebase-certificate',
    FIREBASE_APP_INITIALIZATION: 'firebase-app-initialization',
    FIREBASE_AUTH: 'firebase-auth',
    FIREBASE_FIRESTORE: 'firebase-firestore',
    FIREBASE_INITIALIZATION: 'firebase-initialization',
    RUNTIME_BUILD: 'runtime-build',
    ADAPTER: 'adapter'
});
const DIAGNOSTIC_STAGE_VALUES = new Set(Object.values(DIAGNOSTIC_STAGES));
const DIAGNOSTIC_ERROR_CODES = new Set([
    'MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ERR_REQUIRE_ESM',
    'app/invalid-argument', 'app/invalid-credential', 'app/no-app',
    'auth/invalid-argument', 'auth/invalid-credential',
    'firestore/failed-precondition', 'firestore/invalid-argument', 'firestore/unavailable'
]);
const KNOWN_PATHS = new Set([
    '/', '/review',
    '/pending', '/stage', '/sync', '/sync-readiness', '/edit', '/split', '/reject', '/defer', '/cancel', '/approve', '/restore', '/accepted-state', '/reset',
    '/link-token', '/link/create', '/plaid/link-token', '/plaid/link/create',
    '/link-exchange', '/link/exchange', '/plaid/exchange', '/plaid/link/exchange',
    '/link-update', '/link/update', '/plaid/update', '/plaid/link/update', '/link-disconnect', '/link/disconnect', '/plaid/disconnect', '/plaid/link/disconnect',
    '/link-status', '/link/status', '/plaid/status', '/plaid/link/status'
]);
const ROUTE_METHODS = new Map([
    ['/', new Set(['GET', 'POST'])], ['/review', new Set(['GET', 'POST'])], ['/pending', new Set(['GET'])],
    ['/stage', new Set(['POST'])], ['/sync', new Set(['POST'])], ['/sync-readiness', new Set(['GET'])], ['/edit', new Set(['POST'])], ['/split', new Set(['POST'])],
    ['/reject', new Set(['POST'])], ['/defer', new Set(['POST'])], ['/cancel', new Set(['POST'])], ['/approve', new Set(['POST'])],
    ['/restore', new Set(['POST'])], ['/accepted-state', new Set(['POST'])], ['/reset', new Set(['POST'])],
    ['/link-token', new Set(['POST'])], ['/link/create', new Set(['POST'])], ['/plaid/link-token', new Set(['POST'])], ['/plaid/link/create', new Set(['POST'])],
    ['/link-exchange', new Set(['POST'])], ['/link/exchange', new Set(['POST'])], ['/plaid/exchange', new Set(['POST'])], ['/plaid/link/exchange', new Set(['POST'])],
    ['/link-update', new Set(['POST'])], ['/link/update', new Set(['POST'])], ['/plaid/update', new Set(['POST'])], ['/plaid/link/update', new Set(['POST'])], ['/link-disconnect', new Set(['POST'])], ['/link/disconnect', new Set(['POST'])], ['/plaid/disconnect', new Set(['POST'])], ['/plaid/link/disconnect', new Set(['POST'])],
    ['/link-status', new Set(['GET', 'POST'])], ['/link/status', new Set(['GET', 'POST'])], ['/plaid/status', new Set(['GET', 'POST'])], ['/plaid/link/status', new Set(['GET', 'POST'])]
]);

function runtimeRequire(name) {
    if (!['production-service.js', 'transaction-config.js'].includes(name)) fail('Production runtime module is not configured.');
    return require(path.join(FUNCTION_DIR, '_runtime', name));
}

function dependencyRequire(name, dependencies) {
    if (dependencies && typeof dependencies[name] === 'function') return dependencies[name]();
    return require(name);
}

async function dependencyImport(name, dependencies) {
    if (dependencies && typeof dependencies[name] === 'function') return dependencies[name]();
    // Keep these imports literal so the trusted prebuilt Netlify bundle can
    // inline the Admin auth bridge.  A variable import would force the
    // production runtime to load firebase-admin/auth through CommonJS;
    // firebase-admin 14's jwks-rsa dependency then requires ESM jose.
    if (name === 'firebase-admin/app') return import('firebase-admin/app');
    if (name === 'firebase-admin/auth') return import('firebase-admin/auth');
    if (name === 'firebase-admin/firestore') return import('firebase-admin/firestore');
    return import(name);
}

function text(value) {
    return String(value ?? '').trim();
}

function list(value) {
    return String(value || '').split(',').map(text).filter(Boolean);
}

function boolean(value) {
    return text(value).toLowerCase() === 'true';
}

function fail(message) {
    throw new Error(message);
}

function diagnosticStage(value) {
    return DIAGNOSTIC_STAGE_VALUES.has(value) ? value : DIAGNOSTIC_STAGES.ADAPTER;
}

function diagnosticErrorCode(error) {
    let code;
    try {
        code = error && error.code;
    } catch (_) {
        return 'unknown';
    }
    if (typeof code !== 'string') return 'unknown';
    return DIAGNOSTIC_ERROR_CODES.has(code) ? code : 'unknown';
}

function diagnosticErrorMessage(error) {
    let message;
    try {
        message = error && error.message;
    } catch (_) {
        return '';
    }
    return typeof message === 'string' ? message : '';
}

function emptyFirebaseDiagnosticState() {
    return {
        projectIdPresent: false,
        projectIdMatches: false,
        clientPresent: false,
        clientMatches: false,
        keyPresent: false,
        keyPem: false,
        sdkApp: false,
        sdkAuth: false,
        sdkFirestore: false,
        appLookup: false,
        appValidated: false,
        credentialParsed: false,
        appInitialized: false,
        authInitialized: false,
        firestoreInitialized: false
    };
}

function firebaseDiagnosticState(config) {
    const state = emptyFirebaseDiagnosticState();
    state.projectIdPresent = Boolean(text(config && config.firebaseProjectId));
    state.projectIdMatches = text(config && config.firebaseProjectId) === TARGET_PROJECT_ID;
    state.clientPresent = Boolean(text(config && config.firebaseClientEmail));
    state.clientMatches = text(config && config.firebaseClientEmail) === TARGET_RUNTIME_SERVICE_ACCOUNT;
    const key = String(config && config.firebasePrivateKey || '');
    state.keyPresent = Boolean(key);
    state.keyPem = /-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(key);
    return state;
}

function emitHandlerDiagnostic(stage, request, context, error, state) {
    const record = {
        event: 'budgetTransactions.handler_failure',
        stage: diagnosticStage(stage),
        errorCode: diagnosticErrorCode(error),
        clientResponse: 'generic',
        redacted: true,
        message: '[REDACTED]',
        stack: '[REDACTED]',
        hasRequest: Boolean(request),
        hasContext: Boolean(context),
        firebase: { ...emptyFirebaseDiagnosticState(), ...(state || {}) }
    };
    try {
        console.error(JSON.stringify(record));
    } catch (_) {
        // Diagnostics must never change the fail-closed response.
    }
}

function assertTrustedProductionContext(context, environment) {
    const env = environment || process.env;
    const siteId = text(env.BUDGET_NETLIFY_SITE_ID);
    const siteHost = text(env.BUDGET_NETLIFY_SITE_HOST).toLowerCase();
    if (!siteId || !NETLIFY_SITE_ID_PATTERN.test(siteId) || !siteHost || siteHost.includes('/') || siteHost.includes(':')) fail('Trusted Netlify production context is required.');
    const deploy = context && context.deploy;
    const site = context && context.site;
    if (!deploy || deploy.context !== 'production' || deploy.published !== true || !site || text(site.id) !== siteId) fail('Trusted Netlify production context is required.');
    let hostname;
    try { hostname = new URL(text(site.url)).hostname.toLowerCase(); } catch (_) { fail('Trusted Netlify production context is required.'); }
    if (hostname !== siteHost) fail('Trusted Netlify production context is required.');
    return Object.freeze({ siteId, siteHost });
}

function assertRequestHost(request, trustedContext) {
    let hostname;
    try { hostname = new URL(String(request && request.url || '')).hostname.toLowerCase(); } catch (_) { fail('Trusted Netlify production context is required.'); }
    if (!hostname || hostname !== trustedContext.siteHost) fail('Trusted Netlify production context is required.');
}

function parseKeyring(environment) {
    const currentKeyId = text(environment.BUDGET_TOKEN_CURRENT_KEY_ID);
    const raw = text(environment.BUDGET_TOKEN_KEYRING_JSON);
    if (!currentKeyId || !KEY_ID_PATTERN.test(currentKeyId) || !raw) fail('Token vault configuration is incomplete.');
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { fail('Token vault configuration is incomplete.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('Token vault configuration is incomplete.');
    const keyring = Object.create(null);
    const entries = Object.entries(parsed);
    if (!entries.length || entries.length > 4) fail('Token vault configuration is incomplete.');
    for (const [keyId, encoded] of entries) {
        if (!KEY_ID_PATTERN.test(keyId) || typeof encoded !== 'string') fail('Token vault configuration is incomplete.');
        let key;
        try { key = Buffer.from(encoded, 'base64url'); } catch (_) { fail('Token vault configuration is incomplete.'); }
        if (key.length !== 32) fail('Token vault configuration is incomplete.');
        keyring[keyId] = key;
    }
    if (!Object.prototype.hasOwnProperty.call(keyring, currentKeyId) || !Buffer.isBuffer(keyring[currentKeyId]) || keyring[currentKeyId].length !== 32) fail('Token vault configuration is incomplete.');
    return { keyring, currentKeyId };
}

function parseRuntimeConfig(environment, trustedContext) {
    const env = environment || process.env;
    const expectedProjectId = TARGET_PROJECT_ID;
    const projectId = text(env.BUDGET_FIREBASE_PROJECT_ID);
    const householdSource = String(env.BUDGET_HOUSEHOLD_ID || '');
    const householdId = householdSource.trim();
    const linkEnabled = boolean(env.BUDGET_LINK_ENABLED);
    const syncEnabled = boolean(env.BUDGET_SYNC_ENABLED);
    if (projectId !== expectedProjectId || householdSource !== householdId || !HOUSEHOLD_ID_PATTERN.test(householdId)) fail('Production provider configuration is incomplete.');
    if (!trustedContext || trustedContext.siteId !== text(env.BUDGET_NETLIFY_SITE_ID)) fail('Trusted Netlify production context is required.');
    const connectionKeys = list(env.BUDGET_CONNECTION_KEYS);
    const activeKeys = list(env.BUDGET_ACTIVE_CONNECTION_KEYS);
    if (activeKeys.some(key => !connectionKeys.includes(key))) fail('Production provider configuration is incomplete.');
    const expectedInstitutions = {};
    const secretNames = {};
    for (const key of connectionKeys) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(key)) fail('Production provider configuration is incomplete.');
        const envKey = key.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
        const institution = text(env[`BUDGET_EXPECTED_INSTITUTION_${envKey}`]);
        if (institution) expectedInstitutions[key] = institution;
        secretNames[key] = `projects/${expectedProjectId}/secrets/${key}`;
    }
    if ((linkEnabled || syncEnabled) && (!connectionKeys.length || Object.keys(expectedInstitutions).length !== connectionKeys.length)) fail('Production provider configuration is incomplete.');
    const redirectUri = linkEnabled ? text(env.PLAID_REDIRECT_URI) : '';
    if (linkEnabled && (!redirectUri || !/^https:\/\/zmstiles-dev\.github\.io(?:\/[^#]*)?$/.test(redirectUri))) fail('Production provider configuration is incomplete.');
    const firebaseProjectId = text(env.BUDGET_FIREBASE_PROJECT_ID);
    const firebaseClientEmail = text(env.BUDGET_FIREBASE_CLIENT_EMAIL);
    const firebasePrivateKey = String(env.BUDGET_FIREBASE_PRIVATE_KEY || '').replaceAll('\\n', '\n');
    if (!firebaseProjectId || !firebaseClientEmail || firebaseClientEmail !== TARGET_RUNTIME_SERVICE_ACCOUNT || !firebasePrivateKey) fail('Firebase runtime credentials are not configured.');
    const provider = (linkEnabled || syncEnabled) ? Object.freeze({
        readClientId: () => text(env.BUDGET_PLAID_CLIENT_ID),
        readClientSecret: () => text(env.BUDGET_PLAID_CLIENT_SECRET),
        readVault: () => parseKeyring(env)
    }) : null;
    if (linkEnabled || syncEnabled) {
        return Object.freeze({ projectId, householdId, connectionKeys, activeKeys, expectedInstitutions, secretNames, redirectUri, linkEnabled, syncEnabled, firebaseProjectId, firebaseClientEmail, firebasePrivateKey, provider });
    }
    return Object.freeze({ projectId, householdId, connectionKeys, activeKeys, expectedInstitutions, secretNames, redirectUri, linkEnabled, syncEnabled, firebaseProjectId, firebaseClientEmail, firebasePrivateKey, provider: null });
}

async function initializeFirebase(config, dependencies, diagnostics = {}) {
    const state = firebaseDiagnosticState(config);
    const reportState = () => {
        if (typeof diagnostics.onDiagnosticState === 'function') diagnostics.onDiagnosticState(Object.freeze({ ...state }));
    };
    const reportStage = value => {
        if (typeof diagnostics.onDiagnosticStage === 'function') diagnostics.onDiagnosticStage(value);
        reportState();
    };
    reportStage(DIAGNOSTIC_STAGES.FIREBASE_SDK_IMPORTS);
    let appModule;
    let authModule;
    let firestoreModule;
    appModule = await dependencyImport('firebase-admin/app', dependencies);
    state.sdkApp = true;
    reportState();
    authModule = await dependencyImport('firebase-admin/auth', dependencies);
    state.sdkAuth = true;
    reportState();
    firestoreModule = await dependencyImport('firebase-admin/firestore', dependencies);
    state.sdkFirestore = true;
    reportState();
    const appName = 'budgetTransactions';
    reportStage(DIAGNOSTIC_STAGES.FIREBASE_APP_LOOKUP);
    const apps = typeof appModule.getApps === 'function' ? appModule.getApps() : [];
    state.appLookup = true;
    reportState();
    const existing = apps.find(candidate => candidate && candidate.name === appName);
    reportStage(DIAGNOSTIC_STAGES.FIREBASE_APP_VALIDATION);
    let app;
    if (existing) {
        const existingProject = text(existing.options && existing.options.projectId);
        const existingEmail = text(existing.options && existing.options.credential && existing.options.credential.clientEmail);
        if (existingProject !== TARGET_PROJECT_ID || existingEmail && existingEmail !== TARGET_RUNTIME_SERVICE_ACCOUNT) fail('Firebase runtime credentials are not configured.');
        state.appValidated = true;
        reportState();
        state.credentialParsed = true;
        reportState();
        app = existing;
    } else {
        state.appValidated = true;
        reportState();
        reportStage(DIAGNOSTIC_STAGES.FIREBASE_CERTIFICATE);
        const credential = appModule.cert({ projectId: config.firebaseProjectId, clientEmail: config.firebaseClientEmail, privateKey: config.firebasePrivateKey });
        state.credentialParsed = true;
        reportState();
        reportStage(DIAGNOSTIC_STAGES.FIREBASE_APP_INITIALIZATION);
        app = appModule.initializeApp({ projectId: config.firebaseProjectId, credential }, appName);
    }
    state.appInitialized = true;
    reportState();
    reportStage(DIAGNOSTIC_STAGES.FIREBASE_AUTH);
    const auth = authModule.getAuth(app);
    state.authInitialized = true;
    reportState();
    reportStage(DIAGNOSTIC_STAGES.FIREBASE_FIRESTORE);
    const db = firestoreModule.getFirestore(app);
    state.firestoreInitialized = true;
    reportState();
    return { app, auth, db };
}

function lazyPlaidClient(clientId, clientSecret, dependencies) {
    let client = null;
    const getClient = () => {
        if (client) return client;
        const resolvedClientId = text(typeof clientId === 'function' ? clientId() : clientId);
        const resolvedClientSecret = text(typeof clientSecret === 'function' ? clientSecret() : clientSecret);
        if (!resolvedClientId || !resolvedClientSecret) fail('Production provider configuration is incomplete.');
        const plaid = dependencyRequire('plaid', dependencies);
        const configuration = new plaid.Configuration({
            basePath: plaid.PlaidEnvironments.production,
            baseOptions: { timeout: 10000, headers: { 'PLAID-CLIENT-ID': resolvedClientId, 'PLAID-SECRET': resolvedClientSecret } }
        });
        client = new plaid.PlaidApi(configuration);
        return client;
    };
    const call = method => (...args) => getClient()[method](...args);
    const transactionsSync = async (request, control) => {
        const input = request || {};
        const payload = { access_token: text(input.access_token), cursor: text(input.cursor), count: 500 };
        if (!payload.access_token) fail('Production provider configuration is incomplete.');
        const options = { timeout: 10000 };
        const deadlineAt = control && Number.isSafeInteger(control.deadlineAt) ? control.deadlineAt : null;
        if (deadlineAt !== null) {
            const remaining = deadlineAt - Date.now();
            if (remaining <= 0) fail('Plaid sync exceeded its bounded execution window.');
            options.timeout = Math.max(1, Math.min(10000, remaining));
        }
        if (control && control.signal) options.signal = control.signal;
        const response = await getClient().transactionsSync(payload, options);
        return response && response.data;
    };
    return { linkTokenCreate: call('linkTokenCreate'), itemPublicTokenExchange: call('itemPublicTokenExchange'), accountsGet: call('accountsGet'), itemGet: call('itemGet'), itemRemove: call('itemRemove'), transactionsSync };
}

function disabledTokenStore() {
    return {
        async setAccessToken() { fail('Provider operations are disabled by server configuration.'); },
        async resolveAccessToken() { fail('Provider operations are disabled by server configuration.'); }
    };
}

function lazyTokenStore(production, config, firebase) {
    let store = null;
    const getStore = () => {
        if (store) return store;
        const vault = config.provider.readVault();
        store = new production.FirestoreEncryptedTokenStore({ db: firebase.db, projectId: config.projectId, householdId: config.householdId, collection: TOKEN_VAULT_COLLECTION, keyring: vault.keyring, currentKeyId: vault.currentKeyId });
        return store;
    };
    return {
        async prepareForExchange(...args) { return getStore().prepareForExchange(...args); },
        async setAccessToken(...args) { return getStore().setAccessToken(...args); },
        async resolveAccessToken(...args) { return getStore().resolveAccessToken(...args); },
        async findAccessTokenReference(...args) { return getStore().findAccessTokenReference(...args); },
        async rewrapAccessToken(...args) { return getStore().rewrapAccessToken(...args); }
    };
}

export async function createRuntime(options = {}) {
    const env = options.environment || process.env;
    const trustedContext = assertTrustedProductionContext(options.context, env);
    const reportStage = typeof options.onDiagnosticStage === 'function' ? value => options.onDiagnosticStage(diagnosticStage(value)) : () => {};
    reportStage(DIAGNOSTIC_STAGES.RUNTIME_CONFIG);
    const config = parseRuntimeConfig(env, trustedContext);
    const dependencies = options.dependencies;
    let firebase;
    if (options.firebase) {
        reportStage(DIAGNOSTIC_STAGES.FIREBASE_INITIALIZATION);
        firebase = options.firebase;
    } else {
        firebase = await initializeFirebase(config, dependencies, {
            onDiagnosticStage: reportStage,
            onDiagnosticState: options.onDiagnosticState
        });
    }
    reportStage(DIAGNOSTIC_STAGES.RUNTIME_BUILD);
    const production = options.production || runtimeRequire('production-service.js');
    const transactionConfig = options.transactionConfig || runtimeRequire('transaction-config.js');
    const providerEnabled = config.linkEnabled || config.syncEnabled;
    const tokenStore = providerEnabled
        ? (options.tokenStore || lazyTokenStore(production, config, firebase))
        : disabledTokenStore();
    const plaid = providerEnabled ? (options.plaidClient || lazyPlaidClient(config.provider.readClientId, config.provider.readClientSecret, dependencies)) : {
        async linkTokenCreate() { fail('Provider operations are disabled by server configuration.'); },
        async itemPublicTokenExchange() { fail('Provider operations are disabled by server configuration.'); },
        async accountsGet() { fail('Provider operations are disabled by server configuration.'); },
        async itemGet() { fail('Provider operations are disabled by server configuration.'); },
        async itemRemove() { fail('Provider operations are disabled by server configuration.'); }
    };
    const accountAliases = transactionConfig.accountDisplayNames;
    return production.createProductionService({
        db: firebase.db,
        admin: { auth: () => firebase.auth, app: () => firebase.app },
        projectId: config.projectId,
        householdId: config.householdId,
        allowedUsers: [],
        existingAppUserResolver: production.createFirestoreExistingAppUserResolver({ db: firebase.db, collection: PINNED_MEMBERSHIP_COLLECTION, householdId: config.householdId, configCollection: PINNED_CONFIG_COLLECTION, configDocument: PINNED_CONFIG_DOCUMENT }),
        allowedConnectionKeys: config.connectionKeys.length ? config.connectionKeys : ['disabled'],
        tokenStore,
        plaidClient: plaid,
        plaidSyncClient: providerEnabled ? { sync: (request, control) => plaid.transactionsSync(request, control) } : undefined,
        accountAliases,
        accountAliasesByConnection: { chase: ['Checking Account', 'CFF', 'CFU', 'CSP'], 'capital-one': ['Ven X'] },
        accountPolicies: {
            chase: { aliases: {
                'Checking Account': { types: ['depository'], subtypes: ['checking'], currency: 'USD' },
                CFF: { types: ['credit'], subtypes: ['credit card', 'creditcard'], currency: 'USD' },
                CFU: { types: ['credit'], subtypes: ['credit card', 'creditcard'], currency: 'USD' },
                CSP: { types: ['credit'], subtypes: ['credit card', 'creditcard'], currency: 'USD' }
            } },
            'capital-one': { aliases: { 'Ven X': { types: ['credit'], subtypes: ['credit card', 'creditcard'], currency: 'USD' } } }
        },
        expectedInstitutions: config.expectedInstitutions,
        requireExpectedInstitutions: true,
        cleanupPlan: production.createProtectedDisconnectPlan({
            db: firebase.db,
            householdId: config.householdId,
            configCollection: PINNED_CONFIG_COLLECTION,
            configDocument: PINNED_CONFIG_DOCUMENT,
            connectionsCollection: 'protectedConnections'
        }),
        redirectUri: config.redirectUri,
        activeConnectionKeys: config.activeKeys,
        linkEnabled: config.linkEnabled,
        syncEnabled: config.syncEnabled,
        syncReadiness: production.createProtectedSyncReadiness({
            db: firebase.db,
            householdId: config.householdId,
            expectedInstitutions: config.expectedInstitutions,
            requiredConnectionKeys: ['chase', 'capital-one'],
            mappingPolicies: {
                chase: { expectedCount: 4, aliases: {
                    'Checking Account': { type: 'depository', subtype: 'checking', currency: 'USD' },
                    CFF: { type: 'credit', subtype: 'credit card', currency: 'USD' },
                    CFU: { type: 'credit', subtype: 'credit card', currency: 'USD' },
                    CSP: { type: 'credit', subtype: 'credit card', currency: 'USD' }
                } },
                'capital-one': { expectedCount: 1, aliases: { 'Ven X': { type: 'credit', subtype: 'credit card', currency: 'USD' } } }
            },
            cutoverDate: transactionConfig.FIRST_SYNC_CUTOVER_DATE,
            configCollection: PINNED_CONFIG_COLLECTION,
            configDocument: PINNED_CONFIG_DOCUMENT,
            connectionsCollection: 'protectedConnections'
        }),
        maxPages: 20,
        maxRetries: 1,
        maxMutationRestarts: 2,
        backoffMs: 100,
        syncDeadlineMs: 45 * 1000,
        maxBodyBytes: 2 * 1024 * 1024
    });
}

async function readWebBody(request, maxBytes, maxReadMs = 5000) {
    if (!request || request.method === 'GET' || request.method === 'HEAD' || !request.body) return Buffer.alloc(0);
    const contentLength = request.headers && request.headers.get ? request.headers.get('content-length') : null;
    if (contentLength !== null && contentLength !== '' && !/^\d+$/.test(contentLength)) throw new Error('Request body length is invalid.');
    const length = contentLength === null || contentLength === '' ? NaN : Number(contentLength);
    if (Number.isFinite(length) && length > maxBytes) throw new Error('Request body is too large.');
    const reader = request.body.getReader();
    const chunks = [];
    let size = 0;
    const timeoutMs = Number.isSafeInteger(maxReadMs) && maxReadMs > 0 ? maxReadMs : 5000;
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Request body read timed out.')), timeoutMs); });
    try {
        while (true) {
            const next = await Promise.race([reader.read(), timeout]);
            if (next.done) break;
            const chunk = Buffer.from(next.value);
            size += chunk.length;
            if (size > maxBytes) {
                try { Promise.resolve(reader.cancel()).catch(() => {}); } catch (_) { /* best effort */ }
                throw new Error('Request body is too large.');
            }
            chunks.push(chunk);
        }
    } catch (error) {
        if (diagnosticErrorMessage(error) === 'Request body read timed out.') {
            try { Promise.resolve(reader.cancel()).catch(() => {}); } catch (_) { /* best effort; the bounded error is already selected */ }
        }
        throw error;
    } finally {
        clearTimeout(timer);
        try { reader.releaseLock(); } catch (_) { /* a cancelled pending read owns the lock */ }
    }
    return Buffer.concat(chunks);
}

function requestPath(request, routePrefix) {
    const url = new URL(request.url);
    if (KNOWN_PATHS.has(url.pathname)) return url.pathname;
    if (url.pathname === routePrefix) return '/';
    if (url.pathname.startsWith(`${routePrefix}/`)) return url.pathname.slice(routePrefix.length) || '/';
    return null;
}

function edgeJson(status, body, extraHeaders = {}) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders } });
}

function preflightResponse(request, routePrefix) {
    const pathname = requestPath(request, routePrefix);
    if (pathname === null || !KNOWN_PATHS.has(pathname)) return edgeJson(404, { error: 'Route is not configured.' });
    const method = String(request.method || '').toUpperCase();
    const allowedMethods = ROUTE_METHODS.get(pathname) || new Set();
    if (method !== 'OPTIONS' && !allowedMethods.has(method)) return edgeJson(405, { error: 'Method is not configured.' }, { Allow: `${[...allowedMethods].join(',')}${allowedMethods.size ? ',' : ''}OPTIONS` });
    if (method !== 'OPTIONS') return null;
    const requestedOrigin = text(request.headers && request.headers.get && request.headers.get('origin'));
    if (requestedOrigin && requestedOrigin !== PRODUCTION_ORIGIN) return edgeJson(403, { error: 'CORS origin is not allowed.' }, { Vary: 'Origin' });
    return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin': requestedOrigin ? PRODUCTION_ORIGIN : PRODUCTION_ORIGIN,
        'Vary': 'Origin',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Cache-Control': 'no-store'
    } });
}

async function invokeNodeHandler(nodeHandler, request, options = {}) {
    const maxBodyBytes = Number.isSafeInteger(options.maxBodyBytes) ? options.maxBodyBytes : 2 * 1024 * 1024;
    const maxBodyReadMs = Number.isSafeInteger(options.maxBodyReadMs) ? options.maxBodyReadMs : 5000;
    const routePrefix = options.routePrefix || FUNCTION_ROUTE_PREFIX;
    const early = preflightResponse(request, routePrefix);
    if (early) return early;
    const body = await readWebBody(request, maxBodyBytes, maxBodyReadMs);
    const url = new URL(request.url);
    const pathname = requestPath(request, routePrefix);
    const nodeRequest = { method: request.method, url: `${pathname}${url.search}`, headers: Object.fromEntries(request.headers.entries()), body };
    const state = { statusCode: 200, headers: {}, body: '' };
    const nodeResponse = {
        get statusCode() { return state.statusCode; },
        set statusCode(value) { state.statusCode = Number(value); },
        setHeader(name, value) { state.headers[name] = String(value); },
        end(value) { state.body = value || ''; }
    };
    await nodeHandler(nodeRequest, nodeResponse);
    const responseBody = [204, 205, 304].includes(state.statusCode) ? null : state.body;
    return new Response(responseBody, { status: state.statusCode, headers: state.headers });
}

export function createNetlifyHandler(options = {}) {
    const factory = typeof options.createRuntime === 'function' ? options.createRuntime : createRuntime;
    const maxBodyBytes = Number.isSafeInteger(options.maxBodyBytes) ? options.maxBodyBytes : 2 * 1024 * 1024;
    const maxBodyReadMs = Number.isSafeInteger(options.maxBodyReadMs) ? options.maxBodyReadMs : 5000;
    let runtimePromise = null;
    let lastRuntimeStage = DIAGNOSTIC_STAGES.RUNTIME_CONFIG;
    let runtimeFailureStage = null;
    let runtimeDiagnosticState = emptyFirebaseDiagnosticState();
    let runtimeFailureDiagnosticState = null;
    return async function netlifyHandler(request, context) {
        let stage = DIAGNOSTIC_STAGES.TRUSTED_CONTEXT;
        let waitingForRuntime = false;
        try {
            const trustedContext = assertTrustedProductionContext(context, options.environment || process.env);
            stage = DIAGNOSTIC_STAGES.REQUEST_HOST;
            assertRequestHost(request, trustedContext);
            stage = DIAGNOSTIC_STAGES.ADAPTER;
            const early = preflightResponse(request, options.routePrefix || FUNCTION_ROUTE_PREFIX);
            if (early) return early;
            if (!runtimePromise) {
                lastRuntimeStage = DIAGNOSTIC_STAGES.RUNTIME_CONFIG;
                stage = DIAGNOSTIC_STAGES.RUNTIME_CONFIG;
                waitingForRuntime = true;
                runtimePromise = Promise.resolve(factory({
                    context,
                    environment: options.environment || process.env,
                    dependencies: options.dependencies,
                    firebase: options.firebase,
                    production: options.production,
                    transactionConfig: options.transactionConfig,
                    plaidClient: options.plaidClient,
                    onDiagnosticStage: value => {
                        lastRuntimeStage = diagnosticStage(value);
                        stage = lastRuntimeStage;
                    },
                    onDiagnosticState: value => {
                        runtimeDiagnosticState = { ...emptyFirebaseDiagnosticState(), ...(value || {}) };
                    }
                })).catch(error => {
                    runtimeFailureStage = diagnosticStage(lastRuntimeStage);
                    runtimeFailureDiagnosticState = { ...runtimeDiagnosticState };
                    throw error;
                });
            } else {
                stage = lastRuntimeStage;
                waitingForRuntime = true;
            }
            const runtime = await runtimePromise;
            waitingForRuntime = false;
            stage = DIAGNOSTIC_STAGES.ADAPTER;
            return await invokeNodeHandler(runtime.handler, request, { maxBodyBytes, maxBodyReadMs, routePrefix: options.routePrefix || FUNCTION_ROUTE_PREFIX });
        } catch (error) {
            let diagnosticState = waitingForRuntime ? runtimeDiagnosticState : emptyFirebaseDiagnosticState();
            if (waitingForRuntime && runtimeFailureStage) {
                stage = runtimeFailureStage;
                diagnosticState = runtimeFailureDiagnosticState || runtimeDiagnosticState;
            }
            emitHandlerDiagnostic(stage, request, context, error, diagnosticState);
            const message = diagnosticErrorMessage(error);
            const status = message === 'Request body is too large.' ? 413 : message === 'Request body length is invalid.' ? 400 : message === 'Request body read timed out.' ? 408 : 503;
            const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Vary': 'Origin' };
            const requestedOrigin = text(request && request.headers && request.headers.get && request.headers.get('origin'));
            if (requestedOrigin === PRODUCTION_ORIGIN) {
                headers['Access-Control-Allow-Origin'] = PRODUCTION_ORIGIN;
                headers['Access-Control-Allow-Credentials'] = 'true';
            }
            return new Response(JSON.stringify({ error: status === 413 || status === 400 || status === 408 ? message : 'Production service unavailable.' }), { status, headers });
        }
    };
}

// Export only the Web API default.  Netlify's static analysis treats a named
// `handler` export as the legacy event/callback API, even when a default Web
// handler is also present.  Keeping this entry v2 is required for Request /
// Response invocation and the v2 streaming bootstrap emitted by ZISI.
const handler = createNetlifyHandler();
export default handler;
export { assertTrustedProductionContext, assertRequestHost, parseRuntimeConfig, initializeFirebase, invokeNodeHandler, lazyPlaidClient, FUNCTION_ROUTE_PREFIX };

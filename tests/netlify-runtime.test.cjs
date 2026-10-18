'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const projectRoot = path.resolve(__dirname, '..');

function clone(value) {
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

class Snapshot {
    constructor(value) {
        this.exists = value !== undefined;
        this._value = clone(value);
    }
    data() { return clone(this._value); }
}

class DocRef {
    constructor(db, pathName) { this.db = db; this.path = pathName; }
    collection(name) { return new CollectionRef(this.db, `${this.path}/${name}`); }
    async get() { return new Snapshot(this.db.values.get(this.path)); }
    async set(value) { this.db.values.set(this.path, clone(value)); }
}

class CollectionRef {
    constructor(db, pathName) { this.db = db; this.path = pathName; }
    doc(id) { return new DocRef(this.db, `${this.path}/${id}`); }
}

class Transaction {
    constructor(db) { this.db = db; this.writes = []; }
    async get(ref) { return ref.get(); }
    set(ref, value) { this.writes.push([ref.path, clone(value)]); }
    commit() { for (const [key, value] of this.writes) this.db.values.set(key, value); }
}

class FakeFirestore {
    constructor() {
        this.values = new Map();
        this.queue = Promise.resolve();
    }
    collection(name) { return new CollectionRef(this, name); }
    runTransaction(callback) {
        const run = this.queue.then(async () => {
            const transaction = new Transaction(this);
            const result = await callback(transaction);
            transaction.commit();
            return result;
        });
        this.queue = run.catch(() => undefined);
        return run;
    }
    value(pathName) { return clone(this.values.get(pathName)); }
    setValue(pathName, value) { this.values.set(pathName, clone(value)); }
}

function productionEnv(overrides = {}) {
    return {
        BUDGET_NETLIFY_SITE_ID: 'site-synthetic',
        BUDGET_NETLIFY_SITE_HOST: 'synthetic.example',
        BUDGET_FIREBASE_PROJECT_ID: 'budget-tool-sync',
        BUDGET_FIREBASE_CLIENT_EMAIL: 'budget-transactions-runtime@budget-tool-sync.iam.gserviceaccount.com',
        BUDGET_FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nsynthetic\\n-----END PRIVATE KEY-----',
        BUDGET_HOUSEHOLD_ID: 'stiles-budget',
        BUDGET_CONNECTION_KEYS: 'chase,capital-one',
        BUDGET_ACTIVE_CONNECTION_KEYS: '',
        BUDGET_LINK_ENABLED: 'false',
        BUDGET_SYNC_ENABLED: 'false',
        ...overrides
    };
}

function trustedContext(overrides = {}) {
    return {
        deploy: { context: 'production', published: true },
        site: { id: 'site-synthetic', url: 'https://synthetic.example' },
        ...overrides
    };
}

function assertRejectsMessage(promise, pattern) {
    return assert.rejects(promise, error => pattern.test(String(error && error.message)));
}

(async () => {
    const production = require(path.join(projectRoot, 'production-service.js'));
    const runtimePath = path.join(projectRoot, 'netlify', 'functions', 'budgetTransactions.mjs');
    const runtime = await import(pathToFileURL(runtimePath).href);

    const db = new FakeFirestore();
    const oldKey = Buffer.alloc(32, 7).toString('base64url');
    const newKey = Buffer.alloc(32, 8).toString('base64url');
    let clockMs = Date.parse('2026-10-18T00:00:00.000Z');
    const oldStore = new production.FirestoreEncryptedTokenStore({
        db,
        projectId: 'budget-tool-sync',
        householdId: 'stiles-budget',
        keyring: { old: Buffer.alloc(32, 7) },
        currentKeyId: 'old',
        cacheTtlMs: 100,
        clock: () => new Date(clockMs).toISOString()
    });
    const first = await oldStore.setAccessToken('chase', 'access-token-v1');
    assert.equal(first.secretName, 'projects/budget-tool-sync/secrets/chase');
    assert.equal(first.versionName, 'projects/budget-tool-sync/secrets/chase/versions/1');
    assert.equal(await oldStore.resolveAccessToken('chase', first.versionName), 'access-token-v1');
    clockMs += 101;
    assert.equal(await oldStore.resolveAccessToken('chase', first.versionName), 'access-token-v1');
    const stored = db.value('protectedProviderTokens/chase/versions/1');
    assert.equal(Object.prototype.hasOwnProperty.call(stored, 'accessToken'), false);
    assert.equal(stored.aad, 'budget-tool-sync|stiles-budget|chase|1|old|');

    const rotatedStore = new production.FirestoreEncryptedTokenStore({
        db,
        projectId: 'budget-tool-sync',
        householdId: 'stiles-budget',
        keyring: { old: Buffer.alloc(32, 7), new: Buffer.alloc(32, 8) },
        currentKeyId: 'new',
        clock: () => '2026-10-18T00:00:01.000Z'
    });
    const second = await rotatedStore.setAccessToken('chase', 'access-token-v2');
    assert.equal(second.versionName, 'projects/budget-tool-sync/secrets/chase/versions/2');
    assert.equal(await rotatedStore.resolveAccessToken('chase', first.versionName), 'access-token-v1');
    assert.equal(await rotatedStore.resolveAccessToken('chase', second.versionName), 'access-token-v2');
    const rewrapped = await rotatedStore.rewrapAccessToken('chase', first.versionName);
    assert.equal(rewrapped.versionName, first.versionName);
    assert.equal(rewrapped.keyId, 'new');
    assert.equal(await rotatedStore.resolveAccessToken('chase', first.versionName), 'access-token-v1');
    const newOnlyAfterRewrap = new production.FirestoreEncryptedTokenStore({
        db,
        projectId: 'budget-tool-sync',
        householdId: 'stiles-budget',
        keyring: { new: Buffer.alloc(32, 8) },
        currentKeyId: 'new'
    });
    assert.equal(await newOnlyAfterRewrap.resolveAccessToken('chase', first.versionName), 'access-token-v1');
    const tampered = db.value('protectedProviderTokens/chase/versions/2');
    const bytes = Buffer.from(tampered.ciphertext, 'base64url');
    bytes[0] ^= 1;
    tampered.ciphertext = bytes.toString('base64url');
    db.setValue('protectedProviderTokens/chase/versions/2', tampered);
    rotatedStore.invalidate('chase');
    await assertRejectsMessage(rotatedStore.resolveAccessToken('chase', second.versionName), /Secret resolution failed/);
    await assertRejectsMessage(rotatedStore.resolveAccessToken('capital-one', first.versionName), /Secret resolution failed/);
    const newOnlyStore = new production.FirestoreEncryptedTokenStore({
        db,
        projectId: 'budget-tool-sync',
        householdId: 'stiles-budget',
        keyring: { new: Buffer.alloc(32, 8) },
        currentKeyId: 'new'
    });
    await assertRejectsMessage(newOnlyStore.resolveAccessToken('chase', second.versionName), /Secret resolution failed/);

    const recoveryDb = new FakeFirestore();
    const recoveryStore = new production.FirestoreEncryptedTokenStore({
        db: recoveryDb,
        projectId: 'budget-tool-sync',
        householdId: 'stiles-budget',
        keyring: { old: Buffer.alloc(32, 7) },
        currentKeyId: 'old'
    });
    const recoveryWrite = await recoveryStore.setAccessToken('chase', 'recoverable-token', { exchangeId: 'exchange-1', ownerUid: 'uid-one', householdId: 'stiles-budget', itemId: 'item-one' });
    const recoveryReload = new production.FirestoreEncryptedTokenStore({
        db: recoveryDb,
        projectId: 'budget-tool-sync',
        householdId: 'stiles-budget',
        keyring: { old: Buffer.alloc(32, 7) },
        currentKeyId: 'old'
    });
    const recoveryRef = await recoveryReload.findAccessTokenReference('chase', { exchangeId: 'exchange-1', ownerUid: 'uid-one', householdId: 'stiles-budget' });
    assert.equal(recoveryRef.versionName, recoveryWrite.versionName);
    assert.equal(recoveryRef.itemId, 'item-one');
    assert.equal(await recoveryReload.resolveAccessToken('chase', recoveryRef.versionName), 'recoverable-token');
    assert.equal(await recoveryReload.findAccessTokenReference('chase', { exchangeId: 'exchange-1', ownerUid: 'uid-two', householdId: 'stiles-budget' }), null);
    const rotatedRecovery = new production.FirestoreEncryptedTokenStore({
        db: recoveryDb,
        projectId: 'budget-tool-sync',
        householdId: 'stiles-budget',
        keyring: { old: Buffer.alloc(32, 7), new: Buffer.alloc(32, 8) },
        currentKeyId: 'new'
    });
    await rotatedRecovery.rewrapAccessToken('chase', recoveryWrite.versionName);
    const rotatedReference = await rotatedRecovery.findAccessTokenReference('chase', { exchangeId: 'exchange-1', ownerUid: 'uid-one', householdId: 'stiles-budget' });
    assert.equal(rotatedReference.keyId, 'new', 'rewrap must update durable exchange reference metadata');
    const newOnlyRecovery = new production.FirestoreEncryptedTokenStore({ db: recoveryDb, projectId: 'budget-tool-sync', householdId: 'stiles-budget', keyring: { new: Buffer.alloc(32, 8) }, currentKeyId: 'new' });
    assert.equal((await newOnlyRecovery.findAccessTokenReference('chase', { exchangeId: 'exchange-1', ownerUid: 'uid-one', householdId: 'stiles-budget' })).keyId, 'new');
    assert.equal(await newOnlyRecovery.resolveAccessToken('chase', recoveryWrite.versionName), 'recoverable-token');

    const corruptDb = new FakeFirestore();
    corruptDb.setValue('protectedProviderTokens/chase', { schemaVersion: 1, slot: 'chase', householdId: 'stiles-budget', latestVersion: '1' });
    const corruptStore = new production.FirestoreEncryptedTokenStore({ db: corruptDb, projectId: 'budget-tool-sync', householdId: 'stiles-budget', keyring: { old: Buffer.alloc(32, 7) }, currentKeyId: 'old' });
    await assertRejectsMessage(corruptStore.setAccessToken('chase', 'must-not-overwrite'), /Secret storage failed/);
    corruptDb.setValue('protectedProviderTokens/chase', { schemaVersion: 1, slot: 'chase', householdId: 'stiles-budget', latestVersion: 0 });
    corruptDb.setValue('protectedProviderTokens/chase/versions/1', { schemaVersion: 1, slot: 'chase', version: 1, keyId: 'old', algorithm: 'aes-256-gcm', iv: 'AQ', ciphertext: 'AQ', tag: 'AQ', aad: 'bad' });
    await assertRejectsMessage(corruptStore.setAccessToken('chase', 'must-not-overwrite-existing'), /Secret storage failed/);

    const concurrentStore = new production.FirestoreEncryptedTokenStore({
        db: new FakeFirestore(),
        projectId: 'budget-tool-sync',
        householdId: 'stiles-budget',
        keyring: { old: Buffer.alloc(32, 7) },
        currentKeyId: 'old'
    });
    const concurrent = await Promise.all([
        concurrentStore.setAccessToken('capital-one', 'one'),
        concurrentStore.setAccessToken('capital-one', 'two')
    ]);
    assert.deepEqual(concurrent.map(value => value.versionName).sort(), [
        'projects/budget-tool-sync/secrets/capital-one/versions/1',
        'projects/budget-tool-sync/secrets/capital-one/versions/2'
    ]);

    const base = productionEnv();
    assert.deepEqual(runtime.parseRuntimeConfig(base, runtime.assertTrustedProductionContext(trustedContext(), base)).linkEnabled, false);
    await assertRejectsMessage(Promise.resolve().then(() => runtime.parseRuntimeConfig({ ...base, BUDGET_FIREBASE_CLIENT_EMAIL: 'other-runtime@budget-tool-sync.iam.gserviceaccount.com' }, runtime.assertTrustedProductionContext(trustedContext(), base))), /Firebase runtime credentials/);
    const wrongAppDependencies = {
        'firebase-admin/app': () => ({ getApps: () => [{ name: 'budgetTransactions', options: { projectId: 'wrong-project', credential: { clientEmail: 'budget-transactions-runtime@budget-tool-sync.iam.gserviceaccount.com' } } }] }),
        'firebase-admin/auth': () => ({ getAuth() {} }),
        'firebase-admin/firestore': () => ({ getFirestore() {} })
    };
    await assertRejectsMessage(Promise.resolve().then(() => runtime.initializeFirebase({ firebaseProjectId: 'budget-tool-sync', firebaseClientEmail: 'budget-transactions-runtime@budget-tool-sync.iam.gserviceaccount.com', firebasePrivateKey: 'synthetic' }, wrongAppDependencies)), /Firebase runtime credentials/);
    const providerOverrides = { BUDGET_LINK_ENABLED: 'true', BUDGET_EXPECTED_INSTITUTION_CHASE: 'ins-synthetic-chase', BUDGET_EXPECTED_INSTITUTION_CAPITAL_ONE: 'ins-synthetic-capital', PLAID_REDIRECT_URI: 'https://zmstiles-dev.github.io/oauth/callback' };
    const providerConfig = runtime.parseRuntimeConfig({ ...base, ...providerOverrides }, runtime.assertTrustedProductionContext(trustedContext(), base));
    assert.equal(typeof providerConfig.provider.readClientSecret, 'function');
    const providerSecretEnvironment = new Proxy({ ...base, ...providerOverrides }, { get(target, property) { if (property === 'BUDGET_PLAID_CLIENT_SECRET' || property === 'BUDGET_TOKEN_KEYRING_JSON') throw new Error('provider secret read before operation'); return target[property]; } });
    const deferredProviderConfig = runtime.parseRuntimeConfig(providerSecretEnvironment, runtime.assertTrustedProductionContext(trustedContext(), base));
    assert.equal(typeof deferredProviderConfig.provider.readVault, 'function');
    const reviewOnlyEnvironment = new Proxy(base, { get(target, property) { if (String(property).includes('PLAID') || String(property).includes('TOKEN_KEY')) throw new Error('provider secret read during review runtime initialization'); return target[property]; } });
    const reviewRuntime = await runtime.createRuntime({
        environment: reviewOnlyEnvironment,
        context: trustedContext(),
        firebase: { app: {}, auth: {}, db: new FakeFirestore() },
        production: {
            createFirestoreExistingAppUserResolver: () => async () => ({ allowed: true, householdId: 'stiles-budget' }),
            createProductionService: options => ({ handler: async () => {}, options })
        },
        transactionConfig: { accountDisplayNames: ['Checking Account'] }
    });
    assert.equal(typeof reviewRuntime.handler, 'function');
    await assertRejectsMessage(Promise.resolve().then(() => runtime.assertTrustedProductionContext({ deploy: { context: 'branch-deploy', published: true }, site: trustedContext().site }, base)), /Trusted Netlify/);
    await assertRejectsMessage(Promise.resolve().then(() => runtime.assertTrustedProductionContext({ deploy: { context: 'production', published: false }, site: trustedContext().site }, base)), /Trusted Netlify/);
    await assertRejectsMessage(Promise.resolve().then(() => runtime.assertTrustedProductionContext(trustedContext({ site: { id: 'other-site', url: 'https://synthetic.example' } }), base)), /Trusted Netlify/);

    let credentialRead = false;
    const guardedEnvironment = new Proxy({ BUDGET_NETLIFY_SITE_ID: 'site-synthetic', BUDGET_NETLIFY_SITE_HOST: 'synthetic.example' }, {
        get(target, property) {
            if (property === 'BUDGET_FIREBASE_CLIENT_EMAIL' || property === 'BUDGET_TOKEN_KEYRING_JSON') {
                credentialRead = true;
                throw new Error('credential must not be read');
            }
            return target[property];
        }
    });
    await assertRejectsMessage(runtime.createRuntime({ environment: guardedEnvironment, context: { deploy: { context: 'deploy-preview', published: true }, site: trustedContext().site }, production: { createProductionService() {} } }), /Trusted Netlify/);
    assert.equal(credentialRead, false);

    const captured = [];
    const plaid = runtime.lazyPlaidClient('synthetic-client', 'synthetic-secret', {
        plaid: () => ({
            PlaidEnvironments: { production: 'https://production.plaid.com' },
            Configuration: class { constructor(value) { this.value = value; } },
            PlaidApi: class {
                constructor(configuration) { this.configuration = configuration; }
                async transactionsSync(payload, options) { captured.push({ payload, options }); return { data: { added: [], modified: [], removed: [], has_more: false, next_cursor: 'ignored' } }; }
            }
        })
    });
    await plaid.transactionsSync({ access_token: 'server-token', cursor: 'cursor-0', deadlineAt: Date.now() + 5000, signal: { aborted: false } }, { deadlineAt: Date.now() + 5000, signal: { aborted: false } });
    assert.deepEqual(Object.keys(captured[0].payload).sort(), ['access_token', 'count', 'cursor']);
    assert.equal(captured[0].payload.count, 500);
    assert.ok(captured[0].options.timeout > 0 && captured[0].options.timeout <= 10000);
    assert.equal(Object.prototype.hasOwnProperty.call(captured[0].payload, 'deadlineAt'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(captured[0].payload, 'signal'), false);

    const adapterHandler = runtime.createNetlifyHandler({
        maxBodyBytes: 128,
        environment: base,
        createRuntime: async () => ({
            handler: async (request, response) => {
                assert.equal(request.headers.origin, 'https://zmstiles-dev.github.io');
                if (request.method === 'OPTIONS') {
                    response.statusCode = 204;
                    response.end('');
                    return;
                }
                assert.match(request.url, /^\/review(?:\?mode=synthetic)?$/);
                response.statusCode = 201;
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify({ body: JSON.parse(request.body.toString('utf8')) }));
            }
        })
    });
    const adapterResponse = await adapterHandler(new Request('https://synthetic.example/review?mode=synthetic', {
        method: 'POST',
        headers: { origin: 'https://zmstiles-dev.github.io', 'content-type': 'application/json' },
        body: JSON.stringify({ ok: true })
    }), trustedContext());
    assert.equal(adapterResponse.status, 201);
    assert.deepEqual(await adapterResponse.json(), { body: { ok: true } });
    const prefixedResponse = await adapterHandler(new Request('https://synthetic.example/.netlify/functions/budgetTransactions/review?mode=synthetic', {
        method: 'POST',
        headers: { origin: 'https://zmstiles-dev.github.io', 'content-type': 'application/json' },
        body: JSON.stringify({ prefixed: true })
    }), trustedContext());
    assert.equal(prefixedResponse.status, 201);
    assert.deepEqual(await prefixedResponse.json(), { body: { prefixed: true } });
    const optionsResponse = await adapterHandler(new Request('https://synthetic.example/.netlify/functions/budgetTransactions/review', {
        method: 'OPTIONS',
        headers: { origin: 'https://zmstiles-dev.github.io' }
    }), trustedContext());
    assert.equal(optionsResponse.status, 204);
    assert.equal(await optionsResponse.text(), '');
    const oversized = await adapterHandler(new Request('https://synthetic.example/review', { method: 'POST', body: 'x'.repeat(129) }), trustedContext());
    assert.equal(oversized.status, 413);
    const unknown = await adapterHandler(new Request('https://synthetic.example/unknown', { method: 'GET' }), trustedContext());
    assert.equal(unknown.status, 404);
    const wrongMethod = await adapterHandler(new Request('https://synthetic.example/review', { method: 'PUT' }), trustedContext());
    assert.equal(wrongMethod.status, 405);
    const wrongHost = await adapterHandler(new Request('https://other.example/review', { method: 'GET' }), trustedContext());
    assert.equal(wrongHost.status, 503);
    const warmPreview = await adapterHandler(new Request('https://synthetic.example/review', { method: 'GET' }), { deploy: { context: 'deploy-preview', published: true }, site: trustedContext().site });
    assert.equal(warmPreview.status, 503, 'every request must revalidate the production context after warm initialization');
    let coldFactoryCalls = 0;
    const coldRouteHandler = runtime.createNetlifyHandler({
        environment: base,
        createRuntime: async () => { coldFactoryCalls += 1; return { handler: async () => { throw new Error('must not initialize'); } }; }
    });
    assert.equal((await coldRouteHandler(new Request('https://synthetic.example/unknown', { method: 'GET' }), trustedContext())).status, 404);
    assert.equal((await coldRouteHandler(new Request('https://synthetic.example/review', { method: 'PUT' }), trustedContext())).status, 405);
    assert.equal((await coldRouteHandler(new Request('https://synthetic.example/.netlify/functions/budgetTransactions/review', { method: 'OPTIONS', headers: { origin: 'https://zmstiles-dev.github.io' } }), trustedContext())).status, 204);
    assert.equal(coldFactoryCalls, 0, 'invalid routes and cold OPTIONS must not initialize Firebase/runtime state');
    const stalledBody = new ReadableStream({ start() {} });
    const stalledHandler = runtime.createNetlifyHandler({
        maxBodyReadMs: 20,
        environment: base,
        createRuntime: async () => ({ handler: async () => {} })
    });
    const stalledResponse = await stalledHandler(new Request('https://synthetic.example/review', { method: 'POST', headers: { origin: 'https://zmstiles-dev.github.io' }, body: stalledBody, duplex: 'half' }), trustedContext());
    assert.equal(stalledResponse.status, 408, 'stalled readable request bodies must fail within the adapter deadline');

    execFileSync(process.execPath, ['scripts/prepare-netlify.cjs'], { cwd: projectRoot, stdio: 'pipe' });
    const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'netlify', 'functions', '_runtime', 'manifest.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.files).sort(), [
        'package.json', 'production-service.js', 'transaction-backend.js', 'transaction-config.js', 'transaction-review.js', 'transaction-service.js'
    ]);
    assert.equal(manifest.transformations['transaction-backend.js'], 'Removed the standalone legacy email fallback; production authorization uses protected UID membership.');
    assert.doesNotMatch(fs.readFileSync(path.join(projectRoot, 'netlify', 'functions', '_runtime', 'transaction-backend.js'), 'utf8'), /@gmail\.com/);
    assert.equal(fs.existsSync(path.join(projectRoot, 'netlify', 'functions', '_runtime', 'budget-data.json')), false);
    assert.deepEqual(fs.readdirSync(path.join(projectRoot, 'netlify', 'public')), ['.gitkeep']);
    const netlifyPackage = JSON.parse(fs.readFileSync(path.join(projectRoot, 'netlify', 'package.json'), 'utf8'));
    assert.equal(netlifyPackage.engines.node, '24');
    assert.equal(netlifyPackage.dependencies['firebase-admin'], '14.5.0');
    assert.equal(netlifyPackage.dependencies['plaid'], '38.1.0');
    const lockText = fs.readFileSync(path.join(projectRoot, 'netlify', 'package-lock.json'), 'utf8');
    assert.doesNotMatch(lockText, /firebase-functions|@google-cloud\/secret-manager/);
    // A caller may have an unrelated NODE_PATH (for example the verification
    // browser/runtime dependency tree). Bundling must resolve only the pinned
    // Netlify package and its isolated production staging closure.
    const ambientParent = path.resolve('D:/Documents/Codex/.assistant-storage/temp');
    const ambientRoot = path.join(ambientParent, `budget-tool-netlify-ambient-node-path-${process.pid}`);
    const ambientPackage = path.join(ambientRoot, 'node_modules', '@firebase', 'app-compat');
    fs.mkdirSync(ambientPackage, { recursive: true });
    fs.writeFileSync(path.join(ambientPackage, 'README.md'), 'synthetic ambient package sentinel\n');
    try {
        execFileSync(process.execPath, ['scripts/bundle-netlify.cjs'], {
            cwd: projectRoot,
            stdio: 'pipe',
            env: { ...process.env, NODE_PATH: path.join(ambientRoot, 'node_modules') }
        });
    } finally {
        const ambientParentReal = fs.realpathSync(ambientParent);
        const ambientTarget = path.resolve(ambientRoot);
        if (!ambientTarget.startsWith(`${ambientParentReal}${path.sep}`)) throw new Error('unsafe ambient NODE_PATH cleanup path');
        fs.rmSync(ambientTarget, { recursive: true, force: true });
    }
    const artifactManifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'netlify', '.artifact', 'manifest.json'), 'utf8'));
    assert.equal(artifactManifest.source, 'local-trusted-prebuilt-netlify-artifact');
    assert.equal(artifactManifest.dependencies.firebaseAdmin, '14.5.0');
    assert.equal(artifactManifest.dependencies.plaid, '38.1.0');
    assert.equal(artifactManifest.archive.version, '16.3.1');
    assert.deepEqual(artifactManifest.function, {
        runtimeAPIVersion: 2,
        runtimeVersion: 'nodejs24.x',
        invocationMode: 'stream',
        entryFilename: '___netlify-entry-point.mjs',
        bootstrapVersion: '2.24.0'
    });
    assert.ok(Array.isArray(artifactManifest.archive.entries));
    assert.ok(artifactManifest.archive.entries.includes('budgetTransactions.mjs'));
    assert.ok(artifactManifest.archive.entries.includes('___netlify-entry-point.mjs'));
    assert.ok(artifactManifest.archive.entries.includes('___netlify-bootstrap.mjs'));
    assert.ok(artifactManifest.archive.entries.includes('___netlify-metadata.json'));
    assert.ok(artifactManifest.archive.entries.includes('_runtime/production-service.js'));
    assert.ok(artifactManifest.archive.entries.includes('node_modules/firebase-admin/package.json'));
    assert.ok(artifactManifest.archive.entries.includes('node_modules/plaid/package.json'));
    assert.ok(artifactManifest.archive.entries.includes('node_modules/axios/package.json'), 'the dynamic Plaid SDK closure must include axios');
    assert.equal(artifactManifest.archive.entries.some(entry => entry.startsWith('netlify/')), false);
    assert.equal(fs.existsSync(path.join(projectRoot, 'netlify', '.artifact', 'budget-data.json')), false);
    for (const file of [artifactManifest.bundle.file, ...Object.keys(artifactManifest.runtimeFiles).filter(name => name !== 'manifest.json').map(name => `functions/_runtime/${name}`)]) {
        const text = fs.readFileSync(path.join(projectRoot, 'netlify', '.artifact', file), 'utf8');
        assert.doesNotMatch(text, /@gmail\.com/);
        assert.doesNotMatch(text, /budget-data\.json/);
    }
    const bundled = await import(pathToFileURL(path.join(projectRoot, 'netlify', '.artifact', 'functions', 'budgetTransactions.mjs')).href);
    assert.equal(typeof bundled.default, 'function');
    assert.equal('handler' in bundled, false, 'the Netlify entry must not expose the legacy named handler export');
    assert.equal(artifactManifest.archive.bundler, '@netlify/zip-it-and-ship-it');
    const archivePath = path.join(projectRoot, 'netlify', '.artifact', artifactManifest.archive.file);
    assert.equal(fs.existsSync(archivePath), true);
    const proofParent = path.resolve('D:/Documents/Codex/.assistant-storage/temp');
    const proofRoot = path.join(proofParent, `budget-tool-netlify-archive-${process.pid}`);
    fs.mkdirSync(proofParent, { recursive: true });
    fs.mkdirSync(proofRoot, { recursive: true });
    try {
        execFileSync('tar', ['-xf', archivePath, '-C', proofRoot], { stdio: 'pipe' });
        const isolatedSource = path.join(proofRoot, 'budgetTransactions.mjs');
        assert.equal(fs.existsSync(isolatedSource), true);
        const isolated = await import(pathToFileURL(isolatedSource).href);
        assert.equal(typeof isolated.default, 'function');
        assert.equal('handler' in isolated, false, 'the isolated source must not expose the legacy named handler export');
        const isolatedMetadata = JSON.parse(fs.readFileSync(path.join(proofRoot, '___netlify-metadata.json'), 'utf8'));
        assert.equal(isolatedMetadata.version, 1);
        assert.equal(isolatedMetadata.bootstrap_version, '2.24.0');
        const isolatedV2Entry = path.join(proofRoot, '___netlify-entry-point.mjs');
        assert.equal(fs.existsSync(isolatedV2Entry), true);
        // Node does not provide Netlify's Lambda streaming global. A minimal
        // platform shim lets this test import the real generated v2 bootstrap
        // and entry point while keeping the archive isolated from checkout
        // dependencies; request invocation remains covered by the source
        // default Web handler above.
        const previousAwsLambda = globalThis.awslambda;
        globalThis.awslambda = { streamifyResponse: implementation => implementation };
        let isolatedV2;
        try {
            isolatedV2 = await import(pathToFileURL(isolatedV2Entry).href);
        } finally {
            if (previousAwsLambda === undefined) delete globalThis.awslambda; else globalThis.awslambda = previousAwsLambda;
        }
        assert.equal(typeof isolatedV2.handler, 'function', 'the uploaded v2 entry must expose the generated Lambda bootstrap handler');
        const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const isolatedEnvironment = {
            BUDGET_NETLIFY_SITE_ID: 'site-synthetic', BUDGET_NETLIFY_SITE_HOST: 'synthetic.example',
            BUDGET_FIREBASE_PROJECT_ID: 'budget-tool-sync', BUDGET_FIREBASE_CLIENT_EMAIL: 'budget-transactions-runtime@budget-tool-sync.iam.gserviceaccount.com',
            BUDGET_FIREBASE_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }), BUDGET_HOUSEHOLD_ID: 'stiles-budget',
            BUDGET_CONNECTION_KEYS: '', BUDGET_ACTIVE_CONNECTION_KEYS: '', BUDGET_LINK_ENABLED: 'false', BUDGET_SYNC_ENABLED: 'false',
            FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:1'
        };
        const previousEnvironment = Object.fromEntries(Object.keys(isolatedEnvironment).map(key => [key, process.env[key]]));
        Object.assign(process.env, isolatedEnvironment);
        try {
            const isolatedReview = await isolated.default(new Request('https://synthetic.example/.netlify/functions/budgetTransactions/review', { method: 'GET', headers: { authorization: 'Bearer malformed', origin: 'https://zmstiles-dev.github.io' } }), trustedContext());
            assert.equal(isolatedReview.status, 401, 'isolated archive must resolve the real Admin14 handler before rejecting malformed authentication');
        } finally {
            for (const [key, value] of Object.entries(previousEnvironment)) {
                if (value === undefined) delete process.env[key]; else process.env[key] = value;
            }
        }
    } finally {
        const parentReal = fs.realpathSync(proofParent);
        const target = path.resolve(proofRoot);
        if (!target.startsWith(`${parentReal}${path.sep}`)) throw new Error('unsafe archive proof cleanup path');
        fs.rmSync(target, { recursive: true, force: true });
    }

    console.log('PASS: Netlify production guard, real Web Request/Response adapter, bounded Plaid payload, encrypted Firestore token vault rotation/tamper/replay, and isolated package inventory.');
})().catch(error => { console.error(error); process.exitCode = 1; });

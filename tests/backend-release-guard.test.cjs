'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const guard = require('../scripts/backend-release-guard.cjs');
const { transport } = require('../scripts/netlify-release-transport.cjs');
const project = path.resolve(__dirname, '..');
const temp = path.join(project, '.local', 'guard-tests'); fs.mkdirSync(temp, { recursive: true });
for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = temp;
const settings = guard.policy(project);
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function crc32(data) { let crc = -1; for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ -1) >>> 0; }
function zip(entries) {
    const locals = [], central = []; let offset = 0;
    for (const [name, value] of entries) {
        const data = Buffer.from(value), label = Buffer.from(name), local = Buffer.alloc(30), dir = Buffer.alloc(46);
        local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(label.length, 26);
        dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt32LE(crc32(data), 16); dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(label.length, 28); dir.writeUInt32LE(offset, 42);
        locals.push(local, label, data); central.push(dir, label); offset += local.length + label.length + data.length;
    }
    const directory = Buffer.concat(central), footer = Buffer.alloc(22); footer.writeUInt32LE(0x06054b50); footer.writeUInt16LE(entries.length, 8); footer.writeUInt16LE(entries.length, 10); footer.writeUInt32LE(directory.length, 12); footer.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, footer]);
}
function fixture() {
    const root = fs.mkdtempSync(path.join(temp, 'case-')); fs.mkdirSync(path.join(root, '.local', 'store'), { recursive: true });
    for (const file of settings.sourceFiles) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.copyFileSync(path.join(project, file), path.join(root, file)); }
    fs.copyFileSync(path.join(project, '.gitattributes'), path.join(root, '.gitattributes'));
    fs.writeFileSync(path.join(root, '.gitignore'), '.local/\nnetlify/.artifact/\n');
    fs.writeFileSync(path.join(root, 'scripts/bundle-netlify.cjs'), "const fs=require('node:fs');fs.mkdirSync('netlify/.artifact',{recursive:true});fs.copyFileSync('.local/input.zip','netlify/.artifact/budgetTransactions.zip');\n");
    git(root, ['init', '--initial-branch=main']); git(root, ['add', '.']); git(root, ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', 'commit', '-m', 'synthetic release source']);
    const commit = git(root, ['rev-parse', 'HEAD']); git(root, ['update-ref', settings.publishedRef, commit]);
    const entries = guard.RUNTIME.map(name => [`_runtime/${name}`, guard.runtimeBytes(root, name)]).concat([
        ['_runtime/package.json', '{"type":"commonjs"}\n'], ['budgetTransactions.mjs', '// synthetic test archive; no handler execution\n'], ['___netlify-entry-point.mjs', '// synthetic entry\n'], ['___netlify-bootstrap.mjs', '// synthetic bootstrap\n'], ['___netlify-metadata.json', JSON.stringify({ version: 1, bootstrap_version: settings.bootstrapVersion })]
    ]);
    const archivePath = path.join(root, '.local/input.zip'); fs.writeFileSync(archivePath, zip(entries));
    const archive = guard.inspectZip(archivePath), storeRoot = path.join(root, '.local/store');
    guard.retain(root, storeRoot, archivePath, archive.sha256, archive.size);
    const baseline = { schemaVersion: 1, kind: 'historical-adoption', verified: true, deployId: 'baseline-deploy-12345', siteId: settings.siteId, siteHost: settings.siteHost, artifact: { sha256: archive.sha256, size: archive.size } };
    fs.mkdirSync(path.join(storeRoot, 'receipts')); guard.seal(path.join(storeRoot, 'receipts', `${baseline.deployId}.json`), baseline);
    const options = { root, storeRoot, commit, archivePath, releaseId: 'synthetic-release-12345', baselineDeployId: baseline.deployId };
    return { ...options, options, entries, archive, baseline, commit, prepare: () => guard.prepare(options) };
}
function fake(f, { ambiguousUpload = false, failConfig = false, holdCreate = false } = {}) {
    const calls = []; let current = f.baseline.deployId, created = 'new-deploy-12345678', uploads = 0, release;
    const fn = { n: settings.functionName, d: f.archive.sha256, s: f.archive.size, r: settings.runtime, im: settings.invocationMode, m: settings.memory, rg: settings.region, bd: { runtimeAPIVersion: settings.runtimeAPIVersion, bootstrapVersion: settings.bootstrapVersion } };
    const api = {
        calls, release: () => release?.(), uploads: () => uploads,
        async getSite() { calls.push('GET site'); return { id: settings.siteId, ssl_url: `https://${settings.siteHost}`, published_deploy: { id: current } }; },
        async getDeploy(id) { calls.push('GET deploy'); return { id, site_id: settings.siteId, context: 'production', state: 'ready', published_at: '2026-11-04T00:00:00Z', available_functions: [{ ...fn, m: failConfig && id === created ? 2048 : fn.m }], function_schedules: [] }; },
        async functions() { calls.push('GET functions'); return { provider: 'aws_lambda', branch: null, functions: [{ ...fn, endpoint: `https://${settings.siteHost}/.netlify/functions/${settings.functionName}`, schedule: null }] }; },
        async files() { calls.push('GET files'); return []; },
        async create(body) { calls.push('POST'); assert.deepEqual(body, { draft: false, functions: { [settings.functionName]: f.archive.sha256 }, functions_config: { [settings.functionName]: { build_data: { runtimeAPIVersion: 2, bootstrapVersion: '2.24.0' } } } }); if (holdCreate) await new Promise(resolve => { release = resolve; }); return { id: created, site_id: settings.siteId, context: 'production', required_functions: [f.archive.sha256] }; },
        async upload(id, bytes) { calls.push('PUT'); uploads++; assert.equal(id, created); assert.equal(guard.hash(bytes), f.archive.sha256); current = created; if (ambiguousUpload) throw new Error('synthetic lost acknowledgement'); return { sha: f.archive.sha256 }; }
    }; return api;
}
test('canonical prepare retains exact archive, source commit, inventory, baseline and rollback', () => {
    const f = fixture(), result = f.prepare(); const checked = guard.verify({ ...f, manifestPath: result.manifestPath, published: true });
    assert.equal(checked.manifest.source.commit, f.commit); assert.equal(checked.manifest.artifact.sha256, f.archive.sha256);
    assert.equal(checked.manifest.rollback.deployId, f.baseline.deployId); assert.equal(fs.existsSync(path.join(f.storeRoot, 'sha256', f.archive.sha256, 'budgetTransactions.zip')), true);
    assert.equal(git(f.root, ['status', '--porcelain']), '');
});
test('dirty/unpinned/unpublished source and unavailable/public retention fail closed', () => {
    const f = fixture(); assert.throws(() => guard.cleanSource(f.root, '0'.repeat(40)), /explicit current/);
    fs.writeFileSync(path.join(f.root, 'untracked.js'), 'dirty'); assert.throws(() => f.prepare(), /dirty/); fs.unlinkSync(path.join(f.root, 'untracked.js'));
    git(f.root, ['update-ref', '-d', settings.publishedRef]); assert.throws(() => guard.cleanSource(f.root, f.commit, { published: true }), /not published/);
    assert.throws(() => guard.openStore(f.root, path.join(f.root, '.local/missing')), /unavailable/);
    fs.mkdirSync(path.join(f.root, 'netlify/public'), { recursive: true }); assert.throws(() => guard.openStore(f.root, path.join(f.root, 'netlify/public')), /public/);
});
test('archive/immutable inventory/manifest seals and missing archive tampering are rejected', () => {
    const f = fixture(), prepared = f.prepare(), opts = { ...f, manifestPath: prepared.manifestPath };
    const inventory = path.join(f.storeRoot, 'sha256', f.archive.sha256, 'inventory.json'); const original = fs.readFileSync(inventory); fs.writeFileSync(inventory, '{}');
    assert.throws(() => guard.verify(opts), /tampered/); assert.throws(() => guard.retain(f.root, f.storeRoot, f.archivePath, f.archive.sha256, f.archive.size), /different content/); fs.writeFileSync(inventory, original);
    const manifest = fs.readFileSync(prepared.manifestPath); fs.appendFileSync(prepared.manifestPath, ' '); assert.throws(() => guard.verify(opts), /seal/); fs.writeFileSync(prepared.manifestPath, manifest);
    const archive = path.join(f.storeRoot, 'sha256', f.archive.sha256, 'budgetTransactions.zip'); fs.renameSync(archive, `${archive}.missing`); assert.throws(() => guard.verify(opts)); fs.renameSync(`${archive}.missing`, archive);
    fs.writeFileSync(archive, 'changed'); assert.throws(() => guard.verify(opts));
});
test('ZIP traversal/private files and source/runtime divergence are rejected', () => {
    const f = fixture(); for (const name of ['../escape', 'budget-data.json', 'transactions.csv', '.env']) {
        const file = path.join(f.root, '.local/hostile.zip'); fs.writeFileSync(file, zip([...f.entries, [name, 'synthetic']])); assert.throws(() => guard.inspectZip(file), /Unsafe|Unexpected/);
    }
    const bad = guard.inspectZip(f.archivePath); bad.contents.set('_runtime/transaction-review.js', Buffer.from('changed')); assert.throws(() => guard.archiveBinding(f.root, bad), /differs/);
});
test('one-use deployment binds one exact upload and a separate verified receipt', async () => {
    const f = fixture(), prepared = f.prepare(), api = fake(f), options = { ...f, manifestPath: prepared.manifestPath, confirmation: f.releaseId, transport: api };
    const preflight = await guard.deploy({ ...options, preflight: true }); assert.equal(preflight.writes, 0); assert.equal(api.uploads(), 0);
    const result = await guard.deploy(options); assert.equal(result.verified, true); assert.equal(result.sourceCommit, f.commit); assert.equal(api.uploads(), 1);
    const summary = guard.publicSummary(f.root, f.storeRoot, result.deployId);
    assert.equal(summary.adoption, 'clean-commit-before-build'); assert.equal(guard.validatePublic(f.root, summary).verified, true);
    assert.equal(summary.sourceCommit, f.commit); assert.equal(summary.artifact.sha256, f.archive.sha256);
    assert.deepEqual(await guard.deploy(options), guard.receipt(f.root, f.storeRoot, result.deployId)); assert.equal(api.uploads(), 1);
});
test('lost upload acknowledgement is terminal; reconciliation is GET-only', async () => {
    const f = fixture(), prepared = f.prepare(), api = fake(f, { ambiguousUpload: true }), options = { ...f, manifestPath: prepared.manifestPath, confirmation: f.releaseId, transport: api };
    await assert.rejects(() => guard.deploy(options), /reconcile/); assert.equal(api.uploads(), 1);
    await assert.rejects(() => guard.deploy(options), /prior release/); assert.equal(api.uploads(), 1);
    const before = api.calls.length; const result = await guard.deploy({ ...options, reconcile: true }); assert.equal(result.verified, true); assert.ok(api.calls.slice(before).every(value => value.startsWith('GET'))); assert.equal(api.uploads(), 1);
});
test('postdeployment configuration failure never writes a successful receipt', async () => {
    const f = fixture(), prepared = f.prepare(), api = fake(f, { failConfig: true });
    await assert.rejects(() => guard.deploy({ ...f, manifestPath: prepared.manifestPath, confirmation: f.releaseId, transport: api }), /reconcile/);
    assert.equal(fs.existsSync(path.join(f.storeRoot, 'receipts/new-deploy-12345678.json')), false); assert.equal(api.uploads(), 1);
});
test('concurrent and interrupted site lock blocks another mutation', async () => {
    const f = fixture(), prepared = f.prepare(), api = fake(f, { holdCreate: true }), options = { ...f, manifestPath: prepared.manifestPath, confirmation: f.releaseId, transport: api };
    const first = guard.deploy(options); while (!api.calls.includes('POST')) await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(() => guard.deploy(options), /lock/); api.release(); await first; assert.equal(api.uploads(), 1);
});
test('historical adoption is explicitly posthoc with runtime equivalence and rollback retention', () => {
    const f = fixture(), original = path.join(f.root, '.local/original'); fs.mkdirSync(original);
    const files = {};
    for (const name of [...guard.RUNTIME, 'netlify/functions/budgetTransactions.mjs', 'netlify/package.json', 'netlify/package-lock.json']) { const target = path.join(original, name); fs.mkdirSync(path.dirname(target), { recursive: true }); const bytes = fs.readFileSync(path.join(f.root, name)); fs.writeFileSync(target, bytes); files[name] = guard.hash(bytes); }
    const historicalManifestPath = path.join(f.root, '.local/original-manifest.json'); fs.writeFileSync(historicalManifestPath, JSON.stringify({ source: { files }, archive: { sha256: f.archive.sha256 } }));
    const fn = { name: settings.functionName, sha256: f.archive.sha256, size: f.archive.size, runtime: settings.runtime, runtimeAPIVersion: 2, bootstrapVersion: settings.bootstrapVersion, invocationMode: 'stream', memory: 1024, region: 'us-east-2', schedule: null };
    const proofPath = path.join(f.root, '.local/proof.json'); fs.writeFileSync(proofPath, JSON.stringify({ schemaVersion: 1, verified: true, siteId: settings.siteId, siteHost: settings.siteHost, deployId: 'imported-deploy-12345', rollback: { deployId: f.baseline.deployId, artifact: { sha256: f.archive.sha256, size: f.archive.size } }, function: fn, published: true }));
    const options = { ...f, historicalSourceRoot: original, historicalManifestPath, proofPath, rollbackArchivePath: f.archivePath };
    const result = guard.adopt(options); assert.equal(result.kind, 'historical-adoption'); assert.match(result.chronology, /not built from this later commit/);
    assert.equal(guard.receipt(f.root, f.storeRoot, result.deployId).verified, true);
    const summary = guard.publicSummary(f.root, f.storeRoot, result.deployId);
    assert.equal(guard.validatePublic(f.root, summary).verified, true);
    assert.equal(guard.validatePublic(f.root, summary).privateArchiveChecked, false);
    assert.equal(summary.adoption, 'imported-and-committed-after-deployment');
    assert.doesNotMatch(JSON.stringify(summary), /\.local|original-proof|original-manifest/);
    const badSummary = structuredClone(summary); badSummary.runtimeFiles['transaction-review.js'] = '0'.repeat(64);
    assert.throws(() => guard.validatePublic(f.root, badSummary), /source hash/);
    assert.throws(() => guard.validatePublic(f.root, { ...summary, privateEvidence: 'must not publish' }), /unexpected fields/);
    fs.appendFileSync(path.join(original, 'transaction-review.js'), 'changed'); assert.throws(() => guard.adopt(options), /Historical source/);
});
test('single-attempt transport preserves rejected creation ID without retry or credential output', async () => {
    let calls = 0; const api = transport(settings, 'synthetic-secret', async () => { calls++; return { ok: false, status: 422, json: async () => ({ id: 'failed-deploy-12345', message: 'synthetic plan error' }) }; });
    await assert.rejects(() => api.create({}), error => error.deployId === 'failed-deploy-12345' && error.httpStatus === 422 && !error.message.includes('synthetic-secret')); assert.equal(calls, 1);
});
test('retained descendant symlink metadata fails closed without following it', () => {
    const f = fixture(), target = path.join(f.storeRoot, 'sha256', f.archive.sha256, 'budgetTransactions.zip'), original = fs.lstatSync;
    // Metadata injection exercises the Windows reparse/symlink refusal without
    // creating a junction or changing any system filesystem configuration.
    try {
        fs.lstatSync = (file, ...args) => path.resolve(file) === target ? { isFile: () => true, isSymbolicLink: () => true } : original(file, ...args);
        assert.throws(() => guard.retained(f.root, f.storeRoot, f.archive), /Unsafe/);
    } finally { fs.lstatSync = original; }
});
test('CLI blocks unsupported archive overrides and verifies locally before auth bootstrap', async () => {
    const f = fixture(), cli = require('../scripts/backend-release.cjs'), module = require('../scripts/netlify-release-transport.cjs'), original = module.fromApprovedCli;
    let authCalls = 0;
    try {
        module.fromApprovedCli = async () => { authCalls++; throw new Error('must not reach authentication'); };
        await assert.rejects(() => cli.main(['apply', '--manifest', 'missing', '--archive', f.archivePath]), /unsupported/);
        await assert.rejects(() => cli.main(['apply', '--manifest', path.join(f.storeRoot, 'releases/missing.json'), '--store', f.storeRoot]));
        await assert.rejects(() => cli.main(['preflight', '--manifest', 'missing', '--store', f.storeRoot]), /canonical retention store/);
        assert.equal(authCalls, 0);
    } finally { module.fromApprovedCli = original; }
});
test('single-attempt transport never retries ambiguous network failures', async () => {
    let calls = 0; const api = transport(settings, 'synthetic-secret', async () => { calls++; throw Object.assign(new Error('synthetic reset'), { code: 'ECONNRESET' }); });
    await assert.rejects(() => api.create({}), /synthetic reset/); assert.equal(calls, 1);
});
test('persistent site claim blocks another release ID after an ambiguous create', async () => {
    const f = fixture(), first = f.prepare(), api = fake(f);
    api.create = async () => { api.calls.push('POST'); throw new Error('synthetic lost create acknowledgement'); };
    await assert.rejects(() => guard.deploy({ ...f, manifestPath: first.manifestPath, confirmation: f.releaseId, transport: api }), /reconcile/);
    const second = guard.prepare({ ...f.options, releaseId: 'another-release-12345' }), other = fake(f);
    await assert.rejects(() => guard.deploy({ ...f, manifestPath: second.manifestPath, confirmation: 'another-release-12345', transport: other }), /Another release.*unresolved/);
    await assert.rejects(() => guard.deploy({ ...f, manifestPath: second.manifestPath, preflight: true, transport: other }), /Another release.*unresolved/);
    assert.deepEqual(other.calls, []); assert.equal(api.calls.filter(value => value === 'POST').length, 1);
    assert.equal(fs.existsSync(path.join(f.storeRoot, 'claims', `${settings.siteId}.json`)), true);
});

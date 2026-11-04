'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const RUNTIME = ['production-service.js', 'transaction-backend.js', 'transaction-service.js', 'transaction-review.js', 'transaction-config.js'];
const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const normalized = value => Buffer.from(Buffer.from(value).toString('utf8').replace(/\r\n/g, '\n'));
function fail(message) { throw new Error(message); }
function git(root, args, binary = false) { return execFileSync('git', args, { cwd: root, encoding: binary ? undefined : 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } }); }
function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function stable(value) { return JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item, 2) + '\n'; }
function inside(parent, target) { const relative = path.relative(parent, target); return relative === '' || relative && !relative.startsWith('..') && !path.isAbsolute(relative); }
function immutable(file, value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : stable(value));
    if (fs.existsSync(file)) { if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink() || fs.realpathSync(file) !== path.resolve(file)) fail('Unsafe immutable evidence path.'); if (!fs.readFileSync(file).equals(bytes)) fail('Retained evidence already exists with different content.'); return; }
    fs.writeFileSync(file, bytes, { flag: 'wx' });
}
function policy(root) { const value = json(path.join(root, 'backend-release.policy.json')); if (value.schemaVersion !== 1 || !ID.test(value.siteId) || !value.sourceFiles?.length) fail('Invalid release policy.'); return value; }
function cleanSource(root, commit, { published = false } = {}) {
    if (!COMMIT.test(commit || '') || git(root, ['rev-parse', 'HEAD']).trim() !== commit) fail('An explicit current source commit is required.');
    if (git(root, ['status', '--porcelain=v1', '--untracked-files=all']).trim()) fail('Release source checkout is dirty.');
    const settings = policy(root);
    if (published) { try { git(root, ['merge-base', '--is-ancestor', commit, settings.publishedRef]); } catch (_) { fail('Source commit is not published on the locally fetched origin/main ref.'); } }
    const files = {};
    for (const name of settings.sourceFiles) {
        if (name.includes('..') || path.isAbsolute(name)) fail('Unsafe source closure path.');
        const file = path.join(root, name), stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) fail('Unsafe source closure file.');
        const blob = git(root, ['show', `${commit}:${name}`], true);
        if (!normalized(fs.readFileSync(file)).equals(normalized(blob))) fail('Source file differs from pinned Git blob.');
        files[name] = { gitBlob: git(root, ['rev-parse', `${commit}:${name}`]).trim(), gitBlobSha256: hash(blob), normalizedSha256: hash(normalized(blob)) };
    }
    return { commit, files, publishedRef: settings.publishedRef, checkoutNormalization: 'UTF-8; CRLF to LF only' };
}
function runtimeBytes(root, name) {
    return canonicalRuntime(fs.readFileSync(path.join(root, name)), name);
}
function canonicalRuntime(bytes, name) {
    let text = normalized(bytes).toString('utf8');
    if (name === 'transaction-backend.js') {
        const roster = /const EXISTING_ALLOWED_USERS = Object\.freeze\(\[[^\]]*\]\);/g;
        if ([...text.matchAll(roster)].length !== 1) fail('Runtime roster transformation is not reviewable.');
        text = text.replace(roster, 'const EXISTING_ALLOWED_USERS = Object.freeze([]);');
    }
    return Buffer.from(text);
}
function inspectZip(file) {
    const bytes = fs.readFileSync(file), entries = {}, contents = new Map();
    let footer = bytes.length - 22;
    while (footer >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(footer) !== 0x06054b50) footer--;
    if (footer < 0 || bytes.readUInt16LE(footer + 4) || bytes.readUInt16LE(footer + 6)) fail('Unsupported ZIP archive.');
    const count = bytes.readUInt16LE(footer + 10); let offset = bytes.readUInt32LE(footer + 16);
    for (let index = 0; index < count; index++) {
        if (bytes.readUInt32LE(offset) !== 0x02014b50) fail('Invalid ZIP directory.');
        const method = bytes.readUInt16LE(offset + 10), compressedSize = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24);
        const nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32), local = bytes.readUInt32LE(offset + 42);
        const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength), mode = bytes.readUInt32LE(offset + 38) >>> 16;
        const rootFiles = new Set(['budgetTransactions.mjs', '___netlify-bootstrap.mjs', '___netlify-entry-point.mjs', '___netlify-metadata.json', '___netlify-telemetry.mjs']);
        if (!name || name.includes('\\') || name.includes(':') || name.includes('\0') || name.split('/').includes('..') || name.startsWith('/') || (mode & 0xf000) === 0xa000 || Object.hasOwn(entries, name)) fail('Unsafe or duplicate ZIP entry.');
        if (!rootFiles.has(name) && !name.startsWith('node_modules/') && !RUNTIME.map(value => `_runtime/${value}`).concat('_runtime/package.json').includes(name)) fail('Unexpected private/public archive entry.');
        if (bytes.readUInt32LE(local) !== 0x04034b50) fail('Invalid ZIP local header.');
        const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
        const compressed = bytes.subarray(start, start + compressedSize);
        const data = method === 8 ? zlib.inflateRawSync(compressed, { maxOutputLength: 32 * 1024 * 1024 }) : method === 0 ? compressed : null;
        if (!data || data.length !== size) fail('Invalid ZIP entry encoding or size.');
        entries[name] = { size, sha256: hash(data) }; if (!name.startsWith('node_modules/')) contents.set(name, data);
        offset += 46 + nameLength + extra + comment;
    }
    for (const required of ['budgetTransactions.mjs', '___netlify-entry-point.mjs', '___netlify-bootstrap.mjs', '___netlify-metadata.json', ...RUNTIME.map(name => `_runtime/${name}`), '_runtime/package.json']) if (!entries[required]) fail('Required ZIP entry missing.');
    return { sha256: hash(bytes), size: bytes.length, entries, contents };
}
function archiveBinding(root, archive) {
    const settings = policy(root), metadata = JSON.parse(archive.contents.get('___netlify-metadata.json'));
    if (metadata.version !== 1 || metadata.bootstrap_version !== settings.bootstrapVersion) fail('Archive bootstrap metadata differs from policy.');
    for (const name of RUNTIME) if (!normalized(archive.contents.get(`_runtime/${name}`)).equals(runtimeBytes(root, name))) fail(`Archive runtime differs from committed source: ${name}`);
    if (!archive.contents.get('_runtime/package.json').equals(Buffer.from('{"type":"commonjs"}\n'))) fail('Archive CommonJS boundary differs.');
    return Object.fromEntries(RUNTIME.map(name => [name, { archiveRawSha256: archive.entries[`_runtime/${name}`].sha256, canonicalRuntimeSha256: hash(runtimeBytes(root, name)) }]));
}
function openStore(root, storeRoot) {
    const settings = policy(root), target = path.resolve(storeRoot || process.env.BUDGET_RELEASE_STORE || settings.defaultStore);
    if (process.platform === 'win32' && path.parse(target).root.toLowerCase() !== 'd:\\') fail('Release retention must use D:; no C: fallback.');
    if (!fs.existsSync(target) || !fs.lstatSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink() || fs.realpathSync(target) !== target) fail('Release retention root is unavailable or unsafe.');
    if (inside(path.join(root, 'netlify'), target) || inside(path.join(root, 'public'), target)) fail('Retention must stay outside public/build output.');
    if (inside(root, target)) { try { git(root, ['check-ignore', '--quiet', path.relative(root, target)]); } catch (_) { fail('In-checkout retention must be ignored by Git.'); } }
    return target;
}
function directory(store, relative) {
    const target = path.resolve(store, relative); if (!inside(store, target)) fail('Unsafe retained evidence path.');
    let cursor = store;
    for (const component of path.relative(store, target).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, component); if (!fs.existsSync(cursor)) fs.mkdirSync(cursor);
        if (!fs.lstatSync(cursor).isDirectory() || fs.lstatSync(cursor).isSymbolicLink() || fs.realpathSync(cursor) !== cursor) fail('Unsafe retained evidence directory.');
    }
    return target;
}
function safeFile(store, file) {
    const target = path.resolve(file);
    if (!inside(store, target) || !fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink() || fs.realpathSync(target) !== target) fail('Unsafe retained evidence file or descendant path.');
    let cursor = path.dirname(target);
    while (cursor !== store) {
        if (!inside(store, cursor) || fs.lstatSync(cursor).isSymbolicLink() || !fs.lstatSync(cursor).isDirectory() || fs.realpathSync(cursor) !== cursor) fail('Unsafe retained evidence ancestor.');
        cursor = path.dirname(cursor);
    }
    return target;
}
function retain(root, storeRoot, archivePath, expectedSha, expectedSize) {
    if (!SHA.test(expectedSha || '') || !Number.isSafeInteger(expectedSize)) fail('Explicit verified archive digest and size are required.');
    const store = openStore(root, storeRoot), archive = inspectZip(archivePath);
    if (archive.sha256 !== expectedSha || archive.size !== expectedSize) fail('Archive identity mismatch.');
    const target = directory(store, `sha256/${archive.sha256}`), destination = path.join(target, 'budgetTransactions.zip');
    if (!fs.existsSync(destination)) fs.copyFileSync(archivePath, destination, fs.constants.COPYFILE_EXCL);
    safeFile(store, destination);
    if (hash(fs.readFileSync(destination)) !== expectedSha) fail('Retained ZIP changed.');
    immutable(path.join(target, 'inventory.json'), { sha256: archive.sha256, size: archive.size, entries: archive.entries });
    return { sha256: archive.sha256, size: archive.size };
}
function retained(root, storeRoot, reference) {
    if (!SHA.test(reference?.sha256 || '') || !Number.isSafeInteger(reference.size)) fail('Invalid retained archive reference.');
    const store = openStore(root, storeRoot), target = path.join(store, 'sha256', reference.sha256);
    safeFile(store, path.join(target, 'budgetTransactions.zip')); safeFile(store, path.join(target, 'inventory.json'));
    const archive = inspectZip(path.join(target, 'budgetTransactions.zip'));
    if (archive.sha256 !== reference.sha256 || archive.size !== reference.size || stable(json(path.join(target, 'inventory.json'))) !== stable({ sha256: archive.sha256, size: archive.size, entries: archive.entries })) fail('Retained archive or inventory tampered.');
    return archive;
}
function seal(file, record) { immutable(file, record); immutable(`${file}.sha256`, hash(fs.readFileSync(file)) + '\n'); }
function unseal(file) { if (hash(fs.readFileSync(file)) !== fs.readFileSync(`${file}.sha256`, 'utf8').trim()) fail('Retained record seal mismatch.'); return json(file); }
function receipt(root, storeRoot, deployId) {
    if (!ID.test(deployId || '')) fail('Invalid deployment receipt ID.');
    const store = openStore(root, storeRoot), file = path.join(store, 'receipts', `${deployId}.json`);
    safeFile(store, file); safeFile(store, `${file}.sha256`); const value = unseal(file);
    if (value.deployId !== deployId || value.verified !== true || !['release', 'historical-adoption'].includes(value.kind)) fail('Unverified deployment receipt.');
    retained(root, store, value.artifact); if (value.rollback) retained(root, store, value.rollback.artifact);
    return { ...value, receiptSha256: hash(fs.readFileSync(file)) };
}
function runtimeProof(settings, value, sha, size) {
    if (!value || value.name !== settings.functionName || value.sha256 !== sha || value.size !== size || value.runtime !== settings.runtime || value.runtimeAPIVersion !== settings.runtimeAPIVersion || value.bootstrapVersion !== settings.bootstrapVersion || value.invocationMode !== settings.invocationMode || value.memory !== settings.memory || value.region !== settings.region || value.schedule !== null) fail('Verified function proof does not match pinned policy/archive.');
}
function adopt({ root, storeRoot, commit, archivePath, rollbackArchivePath, historicalSourceRoot, historicalManifestPath, proofPath }) {
    const source = cleanSource(root, commit), settings = policy(root), store = openStore(root, storeRoot), proof = json(proofPath), historical = json(historicalManifestPath);
    if (proof.schemaVersion !== 1 || proof.verified !== true || proof.siteId !== settings.siteId || proof.siteHost !== settings.siteHost || !ID.test(proof.deployId || '') || !ID.test(proof.rollback?.deployId || '') || proof.deployId === proof.rollback.deployId || proof.published !== true) fail('Invalid existing deployment proof.');
    const artifact = retain(root, store, archivePath, proof.function.sha256, proof.function.size), archive = retained(root, store, artifact);
    runtimeProof(settings, proof.function, artifact.sha256, artifact.size);
    const runtime = archiveBinding(root, archive);
    for (const name of [...RUNTIME, 'netlify/functions/budgetTransactions.mjs', 'netlify/package.json', 'netlify/package-lock.json']) {
        const original = fs.readFileSync(path.join(historicalSourceRoot, name));
        if (hash(original) !== historical.source?.files?.[name] || !normalized(original).equals(normalized(fs.readFileSync(path.join(root, name))))) fail('Historical source proof differs from current normalized source.');
    }
    if (historical.archive?.sha256 !== artifact.sha256) fail('Historical manifest archive digest differs.');
    const rollbackArtifact = retain(root, store, rollbackArchivePath, proof.rollback.artifact.sha256, proof.rollback.artifact.size);
    const record = { schemaVersion: 1, kind: 'historical-adoption', verified: true, deployId: proof.deployId, siteId: settings.siteId, siteHost: settings.siteHost, sourceCommit: commit, source, artifact, runtime,
        chronology: 'Imported and committed after deployment; this ZIP was not built from this later commit.', sourceRelationship: 'Verified CRLF/LF-normalized runtime and function entry equivalence; original raw hashes retained.',
        originalEvidence: { proofSha256: hash(fs.readFileSync(proofPath)), manifestSha256: hash(fs.readFileSync(historicalManifestPath)), rawSourceHashes: historical.source.files }, rollback: { deployId: proof.rollback.deployId, artifact: rollbackArtifact } };
    const folder = directory(store, 'receipts'); seal(path.join(folder, `${record.deployId}.json`), record);
    immutable(path.join(directory(store, `adoption-evidence/${record.deployId}`), 'original-proof.json'), fs.readFileSync(proofPath));
    immutable(path.join(directory(store, `adoption-evidence/${record.deployId}`), 'original-manifest.json'), fs.readFileSync(historicalManifestPath));
    return record;
}
function prepare({ root, storeRoot, commit, releaseId, baselineDeployId, build = true, archivePath }) {
    if (!ID.test(releaseId || '')) fail('Explicit valid release ID required.');
    const source = cleanSource(root, commit), settings = policy(root), store = openStore(root, storeRoot), baseline = receipt(root, store, baselineDeployId);
    if (build) execFileSync(process.execPath, ['scripts/bundle-netlify.cjs'], { cwd: root, stdio: 'inherit', env: { ...process.env } });
    else fail('Production release preparation requires the canonical build.');
    cleanSource(root, commit);
    const file = archivePath || path.join(root, 'netlify/.artifact/budgetTransactions.zip'), archive = inspectZip(file), runtime = archiveBinding(root, archive);
    const artifact = retain(root, store, file, archive.sha256, archive.size), folder = directory(store, `releases/${releaseId}`);
    const manifest = { schemaVersion: 1, kind: 'release', releaseId, source, artifact, runtime, policySha256: hash(fs.readFileSync(path.join(root, 'backend-release.policy.json'))),
        baseline: { deployId: baseline.deployId, artifact: baseline.artifact, receiptSha256: baseline.receiptSha256 }, rollback: { deployId: baseline.deployId, artifact: baseline.artifact }, settings };
    seal(path.join(folder, 'manifest.json'), manifest);
    return { manifest, manifestPath: path.join(folder, 'manifest.json') };
}
function verify({ root, storeRoot, manifestPath, published = false }) {
    const store = openStore(root, storeRoot);
    if (!inside(path.join(store, 'releases'), path.resolve(manifestPath))) fail('Manifest is not in private retained release storage.');
    safeFile(store, manifestPath); safeFile(store, `${manifestPath}.sha256`); const manifest = unseal(manifestPath);
    if (manifest.kind !== 'release' || manifest.schemaVersion !== 1 || !ID.test(manifest.releaseId || '')) fail('Only a retained prepared release manifest can be deployed.');
    const source = cleanSource(root, manifest.source?.commit, { published });
    if (stable(source) !== stable(manifest.source) || hash(fs.readFileSync(path.join(root, 'backend-release.policy.json'))) !== manifest.policySha256 || stable(policy(root)) !== stable(manifest.settings)) fail('Source or policy pin changed.');
    const archive = retained(root, store, manifest.artifact);
    if (stable(archiveBinding(root, archive)) !== stable(manifest.runtime)) fail('Runtime proof changed.');
    const baseline = receipt(root, store, manifest.baseline?.deployId);
    if (baseline.receiptSha256 !== manifest.baseline.receiptSha256 || stable(baseline.artifact) !== stable(manifest.baseline.artifact) || manifest.rollback?.deployId !== baseline.deployId || stable(manifest.rollback.artifact) !== stable(baseline.artifact)) fail('Baseline or rollback binding changed.');
    const manifestSha256 = hash(fs.readFileSync(manifestPath)), claim = siteClaim(store, manifest.settings.siteId);
    if (published && claim && claim.manifestSha256 !== manifestSha256) fail('Another release for this site is unresolved; GET-only reconciliation is required.');
    return { manifest, store, manifestSha256, archivePath: path.join(store, 'sha256', manifest.artifact.sha256, 'budgetTransactions.zip') };
}
function siteClaim(store, siteId) {
    const file = path.join(store, 'claims', `${siteId}.json`);
    if (!fs.existsSync(file)) return null;
    safeFile(store, file); const value = json(file);
    if (value.schemaVersion !== 1 || value.siteId !== siteId || !ID.test(value.releaseId || '') || !SHA.test(value.manifestSha256 || '')) fail('Invalid persistent site release claim.');
    return value;
}
function locked(store, siteId, callback) {
    const file = path.join(directory(store, 'locks'), `${siteId}.lock`); let fd;
    try { fd = fs.openSync(file, 'wx'); } catch (_) { fail('Concurrent or interrupted release lock exists; reconcile before proceeding.'); }
    fs.writeFileSync(fd, stable({ pid: process.pid, at: new Date().toISOString() }));
    return Promise.resolve().then(callback).finally(() => { fs.closeSync(fd); fs.unlinkSync(file); });
}
function journal(file, manifestSha256) {
    if (!fs.existsSync(file)) return [];
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink() || fs.realpathSync(file) !== path.resolve(file)) fail('Unsafe release journal path.');
    const events = json(file); let previous = '';
    for (const [index, event] of events.entries()) { const { eventSha256, ...body } = event; if (event.sequence !== index || event.previous !== previous || event.manifestSha256 !== manifestSha256 || hash(stable(body)) !== eventSha256) fail('Release journal tampered.'); previous = eventSha256; }
    return events;
}
function append(file, events, manifestSha256, phase, details = {}) {
    const body = { sequence: events.length, previous: events.at(-1)?.eventSha256 || '', manifestSha256, phase, ...details };
    const next = [...events, { ...body, eventSha256: hash(stable(body)) }], temp = `${file}.tmp`;
    fs.writeFileSync(temp, stable(next), { flag: 'wx' }); fs.renameSync(temp, file); return next;
}
async function observed(transport, settings, deployId, artifact) {
    const site = await transport.getSite(), deploy = await transport.getDeploy(deployId), response = await transport.functions();
    const groups = Array.isArray(response) ? response : [response], records = groups[0]?.functions;
    if (site.id !== settings.siteId || site.ssl_url !== `https://${settings.siteHost}` || site.published_deploy?.id !== deployId || deploy.id !== deployId || deploy.site_id !== settings.siteId || deploy.context !== 'production' || !['ready', 'published'].includes(deploy.state) || !deploy.published_at || deploy.error_message || !Array.isArray(deploy.available_functions) || deploy.available_functions.length !== 1 || !Array.isArray(deploy.function_schedules) || deploy.function_schedules.length || groups.length !== 1 || groups[0]?.provider !== 'aws_lambda' || groups[0]?.branch !== null || !Array.isArray(records) || records.length !== 1) fail('Fresh production deployment identity is unverified.');
    const convert = value => ({ name: value?.n, sha256: value?.d, size: value?.s, runtime: value?.r, runtimeAPIVersion: value?.bd?.runtimeAPIVersion, bootstrapVersion: value?.bd?.bootstrapVersion, invocationMode: value?.im, memory: value?.m, region: value?.rg, schedule: null });
    runtimeProof(settings, convert(deploy.available_functions[0]), artifact.sha256, artifact.size); runtimeProof(settings, { ...convert(records[0]), schedule: records[0].schedule }, artifact.sha256, artifact.size);
    if (records[0].endpoint !== `https://${settings.siteHost}/.netlify/functions/${settings.functionName}`) fail('Published function endpoint differs.');
    const files = await transport.files(); if (!Array.isArray(files) || files.length) fail('Production static file inventory must remain empty.');
    return { deployId, function: convert(records[0]), published: true };
}
async function deploy(options) {
    const proof = verify({ ...options, published: true }), { manifest: m, store, manifestSha256, archivePath } = proof;
    if (!options.transport) fail('Approved transport required after local guard verification.');
    return locked(store, m.settings.siteId, async () => {
        const file = path.join(path.dirname(options.manifestPath), 'journal.json'); let events = journal(file, manifestSha256);
        const claimFile = path.join(directory(store, 'claims'), `${m.settings.siteId}.json`), claim = siteClaim(store, m.settings.siteId);
        if (claim && claim.manifestSha256 !== manifestSha256) fail('Another release for this site is unresolved; GET-only reconciliation is required.');
        if (events.at(-1)?.phase === 'success') {
            if (claim) { await observed(options.transport, m.settings, events.at(-1).deployId, m.artifact); fs.unlinkSync(claimFile); }
            return receipt(options.root, store, events.at(-1).deployId);
        }
        if (options.reconcile) {
            const id = events.at(-1)?.deployId; if (!ID.test(id || '') || !['ambiguous', 'uploaded', 'upload-started'].includes(events.at(-1)?.phase)) fail('No bound deployment can be reconciled.');
            await observed(options.transport, m.settings, id, m.artifact);
            return finish(id);
        }
        if (events.length || claim) fail('A prior release attempt exists; no automatic mutation retry.');
        await observed(options.transport, m.settings, m.baseline.deployId, m.baseline.artifact);
        verify({ ...options, published: true });
        if (options.preflight) return { ready: true, manifestSha256, writes: 0 };
        if (options.confirmation !== m.releaseId) fail('Exact release ID confirmation required.');
        immutable(claimFile, { schemaVersion: 1, siteId: m.settings.siteId, releaseId: m.releaseId, manifestSha256 });
        events = append(file, events, manifestSha256, 'create-started'); let id;
        try {
            const created = await options.transport.create({ draft: false, functions: { [m.settings.functionName]: m.artifact.sha256 }, functions_config: { [m.settings.functionName]: { build_data: { runtimeAPIVersion: m.settings.runtimeAPIVersion, bootstrapVersion: m.settings.bootstrapVersion } } } });
            if (ID.test(created?.id || '')) id = created.id;
            if (!id || created.site_id !== m.settings.siteId || created.context !== 'production' || created.draft === true || created.required_functions?.length !== 1 || created.required_functions[0] !== m.artifact.sha256) fail('Deployment creation response is unverified.');
            events = append(file, events, manifestSha256, 'created', { deployId: id });
            verify({ ...options, published: true }); const body = fs.readFileSync(archivePath); if (hash(body) !== m.artifact.sha256) fail('Exact retained upload bytes changed.');
            events = append(file, events, manifestSha256, 'upload-started', { deployId: id, uploadSha256: hash(body) });
            const uploaded = await options.transport.upload(id, body, m.settings);
            if (uploaded?.sha !== m.artifact.sha256) fail('Upload acknowledgement digest differs.');
            events = append(file, events, manifestSha256, 'uploaded', { deployId: id });
            await observed(options.transport, m.settings, id, m.artifact);
            return finish(id);
        } catch (error) {
            if (events.at(-1)?.phase === 'success') throw error; // Verified success with a leftover claim requires GET-only cleanup.
            id = id || (ID.test(error?.deployId || '') ? error.deployId : undefined);
            append(file, events, manifestSha256, 'ambiguous', { ...(id ? { deployId: id } : {}), ...(Number.isInteger(error.httpStatus) ? { httpStatus: error.httpStatus } : {}), requiresReadOnlyReconciliation: true });
            fail('Release did not produce complete proof. Stop mutations and reconcile with GET only.');
        }
        function finish(deployId) {
            const value = { schemaVersion: 1, kind: 'release', verified: true, releaseId: m.releaseId, deployId, siteId: m.settings.siteId, siteHost: m.settings.siteHost, sourceCommit: m.source.commit, source: m.source, runtime: m.runtime, artifact: m.artifact, manifestSha256, rollback: m.rollback };
            seal(path.join(directory(store, 'receipts'), `${deployId}.json`), value);
            events = append(file, events, manifestSha256, 'success', { deployId });
            if (fs.existsSync(claimFile)) fs.unlinkSync(claimFile);
            return value;
        }
    });
}
function publicSummary(root, storeRoot, deployId) {
    const value = receipt(root, storeRoot, deployId), settings = policy(root);
    const summary = { schemaVersion: 1, kind: 'verified-backend-association', siteId: settings.siteId, siteHost: settings.siteHost, deployId: value.deployId,
        sourceCommit: value.sourceCommit, adoption: value.kind === 'historical-adoption' ? 'imported-and-committed-after-deployment' : 'clean-commit-before-build',
        artifact: value.artifact, rollback: value.rollback, privateReceiptSha256: value.receiptSha256,
        normalization: 'UTF-8 CRLF to LF; standalone legacy roster replaced with empty array in transaction-backend.js',
        runtimeFiles: Object.fromEntries(RUNTIME.map(name => [name, value.runtime?.[name]?.canonicalRuntimeSha256])),
        functionEntryNormalizedSha256: value.source?.files?.['netlify/functions/budgetTransactions.mjs']?.normalizedSha256 };
    validatePublic(root, summary); return summary;
}
function validatePublic(root, value) {
    const settings = policy(root);
    const keys = ['schemaVersion', 'kind', 'siteId', 'siteHost', 'deployId', 'sourceCommit', 'adoption', 'artifact', 'rollback', 'privateReceiptSha256', 'normalization', 'runtimeFiles', 'functionEntryNormalizedSha256'];
    if (!value || stable(Object.keys(value).sort()) !== stable(keys.sort()) || stable(Object.keys(value.artifact || {}).sort()) !== stable(['sha256', 'size']) || stable(Object.keys(value.rollback || {}).sort()) !== stable(['artifact', 'deployId']) || stable(Object.keys(value.rollback?.artifact || {}).sort()) !== stable(['sha256', 'size']) || stable(Object.keys(value.runtimeFiles || {}).sort()) !== stable(RUNTIME.slice().sort()) || value.normalization !== 'UTF-8 CRLF to LF; standalone legacy roster replaced with empty array in transaction-backend.js') fail('Public backend association contains unexpected fields.');
    if (value?.schemaVersion !== 1 || value.kind !== 'verified-backend-association' || value.siteId !== settings.siteId || value.siteHost !== settings.siteHost || !ID.test(value.deployId || '') || !ID.test(value.rollback?.deployId || '') || value.deployId === value.rollback.deployId || !COMMIT.test(value.sourceCommit || '') || !SHA.test(value.artifact?.sha256 || '') || !SHA.test(value.rollback?.artifact?.sha256 || '') || !SHA.test(value.privateReceiptSha256 || '') || !Number.isSafeInteger(value.artifact.size) || value.artifact.size <= 0 || !Number.isSafeInteger(value.rollback.artifact.size) || value.rollback.artifact.size <= 0 || !['imported-and-committed-after-deployment', 'clean-commit-before-build'].includes(value.adoption)) fail('Invalid public backend association.');
    try { git(root, ['merge-base', '--is-ancestor', value.sourceCommit, 'HEAD']); } catch (_) { fail('Public association source commit is missing or not in repository history.'); }
    for (const name of RUNTIME) {
        const blob = git(root, ['show', `${value.sourceCommit}:${name}`], true);
        if (hash(canonicalRuntime(blob, name)) !== value.runtimeFiles?.[name]) fail('Public association runtime source hash differs from committed source.');
    }
    if (hash(normalized(git(root, ['show', `${value.sourceCommit}:netlify/functions/budgetTransactions.mjs`], true))) !== value.functionEntryNormalizedSha256) fail('Public association function entry source differs.');
    return { verified: true, sourceCommit: value.sourceCommit, deployId: value.deployId, artifact: value.artifact, privateArchiveChecked: false, liveApiChecked: false };
}
module.exports = { RUNTIME, hash, normalized, stable, git, policy, cleanSource, runtimeBytes, inspectZip, archiveBinding, openStore, retain, retained, receipt, adopt, prepare, verify, deploy, observed, seal, unseal, journal, publicSummary, validatePublic };

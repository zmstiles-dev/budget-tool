/* Assemble the trusted, prebuilt Netlify artifact without reading credentials. */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');

const root = path.resolve(__dirname, '..');
const netlifyDir = path.join(root, 'netlify');
const functionsDir = path.join(netlifyDir, 'functions');
const runtimeSource = path.join(functionsDir, '_runtime');
const artifact = path.join(netlifyDir, '.artifact');
const artifactFunctions = path.join(artifact, 'functions');
const artifactRuntime = path.join(artifactFunctions, '_runtime');
const artifactPublic = path.join(artifact, 'public');
const rootReal = fs.realpathSync(root);

function safeRealPath(target, label, mustExist = false) {
    const absolute = path.resolve(target);
    const lexicalRelative = path.relative(rootReal, absolute);
    if (!lexicalRelative || lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative)) throw new Error(`Unsafe ${label} path.`);
    if (!fs.existsSync(absolute)) {
        if (mustExist) throw new Error(`Missing ${label}.`);
        return absolute;
    }
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Unsafe ${label} path.`);
    const real = fs.realpathSync(absolute);
    const realRelative = path.relative(rootReal, real);
    if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error(`Unsafe ${label} path.`);
    return real;
}

function ensureDirectory(target, label) {
    const absolute = safeRealPath(target, label);
    if (!fs.existsSync(absolute)) fs.mkdirSync(absolute, { recursive: true });
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe ${label} path.`);
    const real = fs.realpathSync(absolute);
    if (real !== absolute) throw new Error(`Unsafe ${label} path.`);
    return absolute;
}

function assertEntries(directory, expected, label, requireAll = true) {
    const expectedSet = new Set(expected);
    const entries = fs.readdirSync(directory);
    for (const entry of entries) {
        if (!expectedSet.has(entry)) throw new Error(`Unexpected ${label} entry: ${entry}`);
        const stat = fs.lstatSync(path.join(directory, entry));
        if (stat.isSymbolicLink()) throw new Error(`Unsafe ${label} entry: ${entry}`);
        if (entry !== '.gitkeep' && !stat.isFile() && !stat.isDirectory()) throw new Error(`Unsafe ${label} entry: ${entry}`);
    }
    if (requireAll) for (const entry of expectedSet) if (!fs.existsSync(path.join(directory, entry))) throw new Error(`Missing ${label} entry: ${entry}`);
}

function hashFile(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const NODE_RESOLUTION_ENVIRONMENT_KEYS = ['NODE_PATH', 'NODE_OPTIONS', 'NPM_CONFIG_NODE_PATH', 'npm_config_node_path'];

function cleanNodeEnvironment() {
    const environment = { ...process.env };
    NODE_RESOLUTION_ENVIRONMENT_KEYS.forEach(key => delete environment[key]);
    return environment;
}

function isolateNodeResolution() {
    const previous = Object.fromEntries(NODE_RESOLUTION_ENVIRONMENT_KEYS.map(key => [key, process.env[key]]));
    NODE_RESOLUTION_ENVIRONMENT_KEYS.forEach(key => delete process.env[key]);
    if (typeof Module._initPaths === 'function') Module._initPaths();
    return () => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        if (typeof Module._initPaths === 'function') Module._initPaths();
    };
}

function copySafeTree(source, destination) {
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) throw new Error(`Unsafe staging source: ${source}`);
    if (stat.isDirectory()) {
        fs.mkdirSync(destination, { recursive: true });
        for (const entry of fs.readdirSync(source)) copySafeTree(path.join(source, entry), path.join(destination, entry));
        return;
    }
    if (!stat.isFile()) throw new Error(`Unsafe staging source: ${source}`);
    fs.copyFileSync(source, destination);
}

function removeStagingTree(stageRoot, stageParent) {
    if (!stageRoot || !fs.existsSync(stageRoot)) return;
    const parent = fs.realpathSync(stageParent);
    const resolved = path.resolve(stageRoot);
    if (!resolved.startsWith(`${parent}${path.sep}`)) throw new Error('Unsafe Netlify staging cleanup path.');
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe Netlify staging cleanup path.');
    fs.rmSync(resolved, { recursive: true, force: true });
}

function zipInventory(file) {
    const data = fs.readFileSync(file);
    const entries = [];
    const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
    let offset = 0;
    while ((offset = data.indexOf(signature, offset)) >= 0) {
        if (offset + 46 > data.length) throw new Error('Netlify archive central directory is truncated.');
        const nameLength = data.readUInt16LE(offset + 28);
        const extraLength = data.readUInt16LE(offset + 30);
        const commentLength = data.readUInt16LE(offset + 32);
        const start = offset + 46;
        const end = start + nameLength;
        if (end > data.length) throw new Error('Netlify archive central directory is invalid.');
        entries.push(data.toString('utf8', start, end));
        offset = end + extraLength + commentLength;
    }
    if (!entries.length) throw new Error('Netlify archive contains no files.');
    return [...new Set(entries)].sort();
}

function assertArchiveInventory(entries, runtimeEntries) {
    const runtimeSet = new Set(runtimeEntries.map(name => `_runtime/${name}`));
    const v2BootstrapEntries = new Set([
        '___netlify-bootstrap.mjs',
        '___netlify-entry-point.mjs',
        '___netlify-metadata.json',
        '___netlify-telemetry.mjs'
    ]);
    if (!entries.includes('budgetTransactions.mjs') || [...v2BootstrapEntries].some(name => !entries.includes(name))) throw new Error('Netlify v2 archive entry is missing.');
    for (const name of entries) {
        if (name === 'budgetTransactions.mjs' || v2BootstrapEntries.has(name) || runtimeSet.has(name) || name.startsWith('node_modules/')) continue;
        throw new Error(`Unexpected Netlify archive entry: ${name}`);
    }
    for (const name of runtimeSet) if (!entries.includes(name)) throw new Error(`Missing Netlify archive runtime entry: ${name}`);
    if (!entries.includes('node_modules/firebase-admin/package.json') || !entries.includes('node_modules/plaid/package.json')) throw new Error('Netlify archive SDK dependencies are incomplete.');
    const buildOnlyPrefixes = ['node_modules/@netlify/', 'node_modules/esbuild/', 'node_modules/braces/', 'node_modules/fast-glob/', 'node_modules/micromatch/'];
    for (const name of entries) if (buildOnlyPrefixes.some(prefix => name.startsWith(prefix))) throw new Error(`Build-only dependency leaked into Netlify archive: ${name}`);
}

async function main() {
    execFileSync(process.execPath, ['scripts/prepare-netlify.cjs'], { cwd: root, stdio: 'inherit' });
    safeRealPath(runtimeSource, 'prepared Netlify runtime', true);
    safeRealPath(path.join(netlifyDir, 'public'), 'Netlify public source', true);
    ensureDirectory(artifact, 'Netlify artifact');
    assertEntries(artifact, ['functions', 'public', 'manifest.json', 'budgetTransactions.zip'], 'Netlify artifact', false);
    ensureDirectory(artifactFunctions, 'Netlify artifact functions');
    ensureDirectory(artifactRuntime, 'Netlify artifact runtime');
    ensureDirectory(artifactPublic, 'Netlify artifact public');

    const runtimeManifest = JSON.parse(fs.readFileSync(path.join(runtimeSource, 'manifest.json'), 'utf8'));
    const runtimeEntries = Object.keys(runtimeManifest.files || {});
    assertEntries(runtimeSource, [...runtimeEntries, 'manifest.json'], 'prepared runtime');
    assertEntries(path.join(netlifyDir, 'public'), ['.gitkeep'], 'Netlify public source');
    assertEntries(artifactPublic, ['.gitkeep'], 'artifact public');
    assertEntries(artifactFunctions, ['budgetTransactions.mjs', '_runtime'], 'artifact functions');

    const esbuild = require(path.join(netlifyDir, 'node_modules', 'esbuild'));
    const entry = safeRealPath(path.join(functionsDir, 'budgetTransactions.mjs'), 'Netlify function entry', true);
    const bundle = path.join(artifactFunctions, 'budgetTransactions.mjs');
    const result = esbuild.buildSync({
        entryPoints: [entry],
        outfile: bundle,
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node24',
        packages: 'external',
        sourcemap: false,
        metafile: true,
        logLevel: 'warning'
    });

    for (const entryName of runtimeEntries) {
        const source = safeRealPath(path.join(runtimeSource, entryName), `prepared runtime entry ${entryName}`, true);
        fs.copyFileSync(source, path.join(artifactRuntime, entryName));
    }
    assertEntries(artifactRuntime, runtimeEntries, 'artifact runtime');
    const publicSource = safeRealPath(path.join(netlifyDir, 'public', '.gitkeep'), 'public sentinel', true);
    fs.copyFileSync(publicSource, path.join(artifactPublic, '.gitkeep'));

    // Use Netlify's own production bundler to create the uploadable archive.
    // The source and output inventories above are fixed before invoking it so
    // an unexpected file cannot silently become part of the deployment.
    const zipItPath = path.join(netlifyDir, 'node_modules', '@netlify', 'zip-it-and-ship-it', 'dist', 'main.js');
    const stagingParent = path.resolve('D:/Documents/Codex/.assistant-storage/temp');
    fs.mkdirSync(stagingParent, { recursive: true });
    const staging = path.join(stagingParent, `budget-tool-netlify-staging-${process.pid}`);
    if (fs.existsSync(staging)) throw new Error('Netlify staging path already exists.');
    fs.mkdirSync(staging);
    let zipResults;
    const restoreNodeResolution = isolateNodeResolution();
    try {
        const { zipFunctions } = await import(pathToFileURL(zipItPath).href);
        fs.copyFileSync(entry, path.join(staging, 'budgetTransactions.mjs'));
        fs.mkdirSync(path.join(staging, '_runtime'));
        for (const entryName of runtimeEntries) copySafeTree(path.join(runtimeSource, entryName), path.join(staging, '_runtime', entryName));
        fs.copyFileSync(path.join(netlifyDir, 'package.json'), path.join(staging, 'package.json'));
        fs.copyFileSync(path.join(netlifyDir, 'package-lock.json'), path.join(staging, 'package-lock.json'));
        const npmCommand = process.platform === 'win32'
            ? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
            : 'npm';
        execFileSync(process.platform === 'win32' ? process.execPath : npmCommand, [
            ...(process.platform === 'win32' ? [npmCommand] : []),
            'ci', '--omit=dev', '--ignore-scripts', '--offline', '--cache', 'D:/Documents/Codex/.assistant-storage/npm-cache'
        ], {
            cwd: staging,
            stdio: 'pipe',
            env: cleanNodeEnvironment()
        });
        zipResults = await zipFunctions(staging, artifact, {
            archiveFormat: 'zip',
            basePath: staging,
            repositoryRoot: staging,
            config: {
                budgetTransactions: {
                    nodeBundler: 'esbuild',
                    nodeVersion: '24',
                    nodeModuleFormat: 'esm',
                    externalNodeModules: ['firebase-admin', 'plaid'],
                    // The provider SDK is loaded behind the provider gate
                    // through the injected dependency seam. ZISI cannot
                    // discover that dynamic require, so retain the complete
                    // production-only node_modules closure from this staging
                    // install. The staging install uses --omit=dev and the
                    // archive guard rejects every build-only package.
                    includedFiles: [...runtimeEntries.map(name => `_runtime/${name}`), 'node_modules/**'],
                    includedFilesBasePath: staging
                }
            }
        });
        if (!Array.isArray(zipResults) || !zipResults.length) throw new Error('Netlify production archive was not created.');
    } finally {
        removeStagingTree(staging, stagingParent);
        restoreNodeResolution();
    }
    const archivePath = path.join(artifact, 'budgetTransactions.zip');
    if (!Array.isArray(zipResults) || !zipResults.length || !fs.existsSync(archivePath)) throw new Error('Netlify production archive was not created.');
    safeRealPath(archivePath, 'Netlify production archive', true);
    const archiveEntries = zipInventory(archivePath);
    assertArchiveInventory(archiveEntries, runtimeEntries);
    assertEntries(artifact, ['functions', 'public', 'manifest.json', 'budgetTransactions.zip'], 'Netlify artifact');
    assertEntries(artifactFunctions, ['budgetTransactions.mjs', '_runtime'], 'artifact functions');
    assertEntries(artifactRuntime, runtimeEntries, 'artifact runtime');
    assertEntries(artifactPublic, ['.gitkeep'], 'artifact public');

    const lock = JSON.parse(fs.readFileSync(path.join(netlifyDir, 'package-lock.json'), 'utf8'));
    const functionResult = zipResults[0];
    const functionBuild = functionResult && functionResult.buildData || {};
    if (functionResult?.runtimeAPIVersion !== 2 || functionBuild.runtimeAPIVersion !== 2) throw new Error('Netlify function did not build as Web API v2.');
    if (functionResult?.runtimeVersion !== 'nodejs24.x') throw new Error(`Unexpected Netlify function runtime: ${functionResult?.runtimeVersion || 'missing'}`);
    if (functionResult?.invocationMode !== 'stream') throw new Error(`Unexpected Netlify invocation mode: ${functionResult?.invocationMode || 'missing'}`);
    if (functionResult?.entryFilename !== '___netlify-entry-point.mjs') throw new Error(`Unexpected Netlify v2 entry point: ${functionResult?.entryFilename || 'missing'}`);
    const manifest = {
        schemaVersion: 2,
        source: 'local-trusted-prebuilt-netlify-artifact',
        runtime: 'node24',
        function: { runtimeAPIVersion: functionResult.runtimeAPIVersion, runtimeVersion: functionResult.runtimeVersion, invocationMode: functionResult.invocationMode, entryFilename: functionResult.entryFilename, bootstrapVersion: functionBuild.bootstrapVersion },
        bundle: { file: 'functions/budgetTransactions.mjs', sha256: hashFile(bundle), esbuildVersion: esbuild.version, inputs: Object.keys(result.metafile && result.metafile.inputs || {}).filter(value => !value.includes('node_modules')) },
        archive: { file: 'budgetTransactions.zip', sha256: hashFile(archivePath), bundler: '@netlify/zip-it-and-ship-it', version: lock.packages && lock.packages['node_modules/@netlify/zip-it-and-ship-it'] && lock.packages['node_modules/@netlify/zip-it-and-ship-it'].version, productionLockSha256: hashFile(path.join(netlifyDir, 'package-lock.json')), entries: archiveEntries },
        runtimeFiles: Object.fromEntries(runtimeEntries.map(name => [name, hashFile(path.join(artifactRuntime, name))])),
        publicFiles: { '.gitkeep': hashFile(path.join(artifactPublic, '.gitkeep')) },
        dependencies: { firebaseAdmin: lock.packages && lock.packages['node_modules/firebase-admin'] && lock.packages['node_modules/firebase-admin'].version, plaid: lock.packages && lock.packages['node_modules/plaid'] && lock.packages['node_modules/plaid'].version },
        excludes: ['budget-data.json', 'Old CSVs', 'Statements', 'exports', '.env', '.codex', 'private roster', 'credentials', 'secrets']
    };
    fs.writeFileSync(path.join(artifact, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Bundled Netlify archive with ${runtimeEntries.length} runtime files and ${manifest.archive.file}.`);
}

main().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });

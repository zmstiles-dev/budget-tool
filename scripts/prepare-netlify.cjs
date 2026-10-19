/* Build the isolated Netlify function runtime from an explicit allowlist. */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const functionsDir = path.join(root, 'netlify', 'functions');
const output = path.join(functionsDir, '_runtime');
const allowlist = [
    'production-service.js',
    'transaction-service.js',
    'transaction-backend.js',
    'transaction-review.js',
    'transaction-config.js'
];

const rootReal = fs.realpathSync(root);
const functionsStat = fs.lstatSync(functionsDir);
if (functionsStat.isSymbolicLink() || !functionsStat.isDirectory()) throw new Error('Unsafe Netlify functions source path.');
const functionsReal = fs.realpathSync(functionsDir);
const functionsRelative = path.relative(rootReal, functionsReal);
if (!functionsRelative || functionsRelative.startsWith('..') || path.isAbsolute(functionsRelative)) throw new Error('Unsafe Netlify functions source path.');
const expectedOutput = path.join(functionsReal, '_runtime');
if (!fs.existsSync(output)) fs.mkdirSync(output);
const outputStat = fs.lstatSync(output);
if (outputStat.isSymbolicLink() || !outputStat.isDirectory()) throw new Error('Unsafe Netlify runtime output path.');
const outputReal = fs.realpathSync(output);
if (outputReal !== expectedOutput || path.relative(rootReal, outputReal).startsWith('..') || path.isAbsolute(path.relative(rootReal, outputReal))) throw new Error('Unsafe Netlify runtime output path.');

const expectedEntries = new Set([...allowlist, 'manifest.json', 'package.json']);
for (const entry of fs.readdirSync(output)) {
    if (!expectedEntries.has(entry)) throw new Error(`Unexpected Netlify runtime output entry: ${entry}`);
    const target = path.join(output, entry);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Unexpected Netlify runtime output entry: ${entry}`);
}

const manifest = { schemaVersion: 1, source: 'explicit-allowlist', files: {}, transformations: {} };
function assertSourceFile(source, label) {
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Unsafe Netlify runtime source: ${label}`);
    const real = fs.realpathSync(source);
    const relative = path.relative(rootReal, real);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Unsafe Netlify runtime source: ${label}`);
    return real;
}
for (const file of allowlist) {
    const source = path.join(root, file);
    const sourceReal = assertSourceFile(source, file);
    let data = fs.readFileSync(sourceReal);
    if (file === 'transaction-backend.js') {
        const sourceText = data.toString('utf8');
        const legacyRoster = /const EXISTING_ALLOWED_USERS = Object\.freeze\(\[[^\]]*\]\);/;
        const matches = sourceText.match(legacyRoster) || [];
        if (matches.length !== 1) throw new Error('Netlify runtime roster transformation is not reviewable.');
        data = Buffer.from(sourceText.replace(legacyRoster, 'const EXISTING_ALLOWED_USERS = Object.freeze([]);'), 'utf8');
        manifest.transformations[file] = 'Removed the standalone legacy email fallback; production authorization uses protected UID membership.';
    }
    fs.writeFileSync(path.join(output, file), data);
    manifest.files[file] = crypto.createHash('sha256').update(data).digest('hex');
}
const runtimePackage = Buffer.from('{"type":"commonjs"}\n', 'utf8');
fs.writeFileSync(path.join(output, 'package.json'), runtimePackage);
manifest.files['package.json'] = crypto.createHash('sha256').update(runtimePackage).digest('hex');
fs.writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Prepared isolated Netlify runtime with ${allowlist.length} allowlisted source files.`);

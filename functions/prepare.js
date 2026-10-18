/* Build the Firebase source tree from an explicit, reviewable allowlist. */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const output = path.resolve(__dirname, 'lib');
const files = [
    'production-service.js',
    'transaction-service.js',
    'transaction-backend.js',
    'transaction-review.js',
    'transaction-config.js'
];

if (path.dirname(output) !== __dirname || path.relative(__dirname, output).startsWith('..')) throw new Error('Unsafe deployment output path.');
const rootReal = fs.realpathSync(root);
const functionsReal = fs.realpathSync(__dirname);
const outputExists = fs.existsSync(output);
if (outputExists) {
    const outputStat = fs.lstatSync(output);
    if (outputStat.isSymbolicLink() || !outputStat.isDirectory()) throw new Error('Unsafe deployment output path.');
} else {
    fs.mkdirSync(output);
}
const outputReal = fs.realpathSync(output);
const relativeOutput = path.relative(functionsReal, outputReal);
const expectedOutput = path.join(functionsReal, 'lib');
if (outputReal !== expectedOutput || !relativeOutput || relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput) || path.relative(rootReal, outputReal).startsWith('..')) throw new Error('Unsafe deployment output path.');
const expectedEntries = new Set([...files, 'manifest.json']);
for (const entry of fs.readdirSync(output)) {
    if (!expectedEntries.has(entry)) throw new Error(`Unexpected deployment output entry: ${entry}`);
    const target = path.join(output, entry);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Unexpected deployment output entry: ${entry}`);
    fs.rmSync(target, { force: true });
}
const manifest = { schemaVersion: 1, files: {} };
for (const file of files) {
    const source = path.join(root, file);
    const target = path.join(output, file);
    if (!fs.statSync(source).isFile()) throw new Error(`Missing deployment source: ${file}`);
    const data = fs.readFileSync(source);
    fs.writeFileSync(target, data);
    manifest.files[file] = crypto.createHash('sha256').update(data).digest('hex');
}
fs.writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Prepared Firebase source package with ${files.length} allowlisted files.`);

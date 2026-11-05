'use strict';
const path = require('node:path');
const fs = require('node:fs');
const guard = require('./backend-release-guard.cjs');
async function main(argv = process.argv.slice(2)) {
    const command = argv.shift(), args = {};
    for (let index = 0; index < argv.length; index += 2) {
        if (!/^--[a-z-]+$/.test(argv[index]) || !argv[index + 1] || argv[index + 1].startsWith('--') || Object.hasOwn(args, argv[index].slice(2))) throw new Error('Use unique --name value arguments.');
        args[argv[index].slice(2)] = argv[index + 1];
    }
    const root = path.resolve(__dirname, '..'), common = { root, storeRoot: args.store };
    const storage = require('./backend-build-paths.cjs').buildPaths(root);
    for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = storage.temp;
    const allowed = {
        retain: ['store', 'archive', 'sha256', 'size'], adopt: ['store', 'commit', 'archive', 'rollback-archive', 'historical-source', 'historical-manifest', 'proof'],
        prepare: ['store', 'commit', 'release', 'baseline'], verify: ['store', 'manifest', 'published'], receipt: ['store', 'deploy'],
        preflight: ['store', 'manifest'], apply: ['store', 'manifest', 'confirm'], reconcile: ['store', 'manifest'], 'export-summary': ['store', 'deploy'], 'verify-public': []
    };
    if (!allowed[command] || Object.keys(args).some(name => !allowed[command].includes(name))) throw new Error('Unknown command or unsupported release argument.');
    if (command === 'retain') return guard.retain(root, args.store, args.archive, args.sha256, Number(args.size));
    if (command === 'adopt') return guard.adopt({ ...common, commit: args.commit, archivePath: args.archive, rollbackArchivePath: args['rollback-archive'], historicalSourceRoot: args['historical-source'], historicalManifestPath: args['historical-manifest'], proofPath: args.proof });
    if (command === 'prepare') return guard.prepare({ ...common, commit: args.commit, releaseId: args.release, baselineDeployId: args.baseline });
    if (command === 'verify') return guard.verify({ ...common, manifestPath: args.manifest, published: args.published === 'true' });
    if (command === 'receipt') return guard.receipt(root, args.store, args.deploy);
    if (command === 'export-summary') {
        const value = guard.publicSummary(root, args.store, args.deploy), summaryPath = path.join(root, 'backend-release.current.json');
        fs.writeFileSync(summaryPath, guard.stable(value)); return { summaryPath, sourceCommit: value.sourceCommit, deployId: value.deployId, artifact: value.artifact };
    }
    if (command === 'verify-public') return guard.validatePublic(root, JSON.parse(fs.readFileSync(path.join(root, 'backend-release.current.json'))));
    if (['preflight', 'apply', 'reconcile'].includes(command)) {
        const canonicalStore = path.resolve(guard.policy(root).defaultStore);
        if (path.resolve(args.store || process.env.BUDGET_RELEASE_STORE || canonicalStore) !== canonicalStore) throw new Error('Real operators must use the canonical retention store and site lock.');
        const options = { ...common, storeRoot: canonicalStore, manifestPath: args.manifest, published: true };
        const checked = guard.verify(options); // Dirty/unpinned/unretained fails before auth access.
        const transport = await require('./netlify-release-transport.cjs').fromApprovedCli(checked.manifest.settings);
        return guard.deploy({ ...options, transport, preflight: command === 'preflight', reconcile: command === 'reconcile', confirmation: args.confirm });
    }
    throw new Error('Unknown backend release command.');
}
if (require.main === module) main().then(value => {
    // No archive bytes, credentials, provider records or raw platform metadata.
    console.log(JSON.stringify({ status: 'ok', manifestPath: value.manifestPath, summaryPath: value.summaryPath, sourceCommit: value.sourceCommit || value.manifest?.source?.commit, deployId: value.deployId, sha256: value.artifact?.sha256 || value.sha256, ready: value.ready, writes: value.writes }));
}).catch(error => { console.error(JSON.stringify({ status: 'blocked', message: error.message })); process.exitCode = 1; });
module.exports = { main };

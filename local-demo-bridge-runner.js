/*
 * User-run local demo launcher.
 *
 * No arguments starts a mock provider bridge. Real Sandbox reads require one
 * explicit mode and happen only after loopback emulator/data preflight. Client
 * ID, secret and access token are read by the existing hidden prompts and are
 * passed to the server adapter in memory only.
 */
'use strict';

const sandbox = require('./plaid-sandbox.js');
const runner = require('./plaid-sandbox-runner.js');
const bridgeApi = require('./local-demo-bridge.js');

function usage() {
    return [
        'Local demo bridge (loopback only)',
        '',
        '  node local-demo-bridge-runner.js                 # synthetic mock provider, no Plaid network',
        '  node local-demo-bridge-runner.js --sync-with-existing-token',
        '                                                      # user-held Sandbox access token',
        '  node local-demo-bridge-runner.js --create-item      # explicit Sandbox Item creation + read',
        '  node local-demo-bridge-runner.js --unattended --create-item',
        '                                                      # fixed Sandbox fixture setup; no prompts; exact process inputs',
        '',
        'All modes require Auth 127.0.0.1:9099, Firestore 127.0.0.1:8088, and project demo-budget-tool.',
        'The local demo refuses existing accepted/pending state unless --reset-local-demo is explicit.'
    ].join('\n');
}

function parseArgs(argv) {
    const args = new Set(argv || process.argv.slice(2));
    if (args.has('--help')) { console.log(usage()); return { help: true }; }
    const realModes = ['--sync-with-existing-token', '--create-item'].filter(flag => args.has(flag));
    if (realModes.length > 1) throw new Error('Choose one explicit Sandbox mode.');
    const unattended = args.has('--unattended');
    for (const value of args) if (!['--sync-with-existing-token', '--create-item', '--unattended', '--reset-local-demo', '--help'].includes(value)) throw new Error('Unsupported local demo option.');
    if (unattended && realModes[0] !== '--create-item') throw new Error('Unattended mode requires --create-item.');
    return { mode: realModes[0] ? 'real' : 'mock', setupMode: realModes[0] || '', unattended, resetLocalDemo: args.has('--reset-local-demo') };
}

async function main(argv) {
    const options = parseArgs(argv);
    if (options.help) return;
    const context = await bridgeApi.prepareLocalDemo({ resetLocalDemo: options.resetLocalDemo, localDepsDir: process.env.BUDGET_TOOL_LOCAL_DEPS });
    let bridge;
    try {
        let config;
        let provider;
        if (options.mode === 'real') {
            // Emulator and fresh-data checks are complete before any hidden
            // provider input is requested. Setup network remains opt-in through
            // --create-item; existing-token mode performs only Transactions Sync.
            if (options.unattended) {
                config = await runner.createUnattendedSandboxSetup();
            } else {
                config = options.setupMode === '--create-item'
                    ? await runner.promptSandboxSetup()
                    : await runner.promptSandboxConfig();
            }
            provider = sandbox.createSandboxProvider({ config });
        }
        bridge = await bridgeApi.createLocalDemoBridge({
            context,
            mode: options.mode,
            provider,
            accessToken: config && config.accessToken,
            connectionKey: config && config.connectionKey,
            localDepsDir: process.env.BUDGET_TOOL_LOCAL_DEPS,
            syncEnabled: true
        });
        console.log('LOCAL DEMO ONLY: no production Firebase, live bank connection, or browser provider credentials are used by the page.');
        console.log(`Open ${bridge.url}`);
        console.log(`Fixture auth is automatic for ${bridge.fixtureEmail}; close with Ctrl+C.`);
        const stop = async () => { await bridge.close(); process.exitCode = 0; };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        await new Promise(() => {});
    } catch (error) {
        if (bridge) await bridge.close();
        else await bridgeApi.closeLocalDemoContext(context);
        throw error;
    }
}

if (require.main === module) {
    main().catch(error => { console.error(sandbox.sanitizeRunnerError(error)); process.exitCode = 1; });
}

module.exports = { parseArgs, main, usage };

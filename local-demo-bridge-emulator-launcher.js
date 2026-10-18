/*
 * Local-only emulator supervisor. Firebase CLI never inherits Sandbox
 * credentials: it receives an explicit non-secret environment allowlist.
 * The bridge child receives provider values only for an explicit run.
 */
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname);
const VERIFY_ROOT = process.env.BUDGET_TOOL_VERIFICATION_ROOT || 'D:\\Documents\\Codex\\.assistant-storage\\budget-tool-verification';
const PROJECT_ID = 'demo-budget-tool';
const AUTH_HOST = '127.0.0.1:9099';
const FIRESTORE_HOST = '127.0.0.1:8088';
const MODES = new Set(['mock', 'sync-with-existing-token', 'create-item', 'verify-mock-e2e', 'verify-synthetic-e2e', 'verify-sandbox-e2e']);
const SAFE_LAUNCHER_STAGES = new Set(['preflight', 'emulator', 'runner', 'cleanup']);
const SAFE_LAUNCHER_CODES = new Set(['LAUNCHER_FAILED', 'EMULATOR_SPAWN_FAILED', 'EMULATOR_NOT_READY', 'RUNNER_FAILED', 'RUNNER_SPAWN_FAILED', 'CLEANUP_FAILED']);

function launcherFailure(stage, code) {
    const error = new Error('Local demo bridge launcher failed.');
    Object.defineProperty(error, '__launcherFailure', { value: { stage, code }, configurable: true });
    return error;
}

function safeLauncherSource(error, stage) {
    const stack = String(error && error.stack || '').replaceAll('\\', '/');
    const matches = [...stack.matchAll(/local-demo-bridge-emulator-launcher\.js:(\d+)/g)].map(match => Number(match[1]));
    // launcherFailure() contributes its own helper frame. Use the callsite
    // for bounded failures and the first frame for ordinary timeout/errors.
    if (matches.length) {
        const line = error && error.__launcherFailure ? matches.at(-1) : matches[0];
        return `local-demo-bridge-emulator-launcher.js:${line}`;
    }
    const current = [...String(new Error().stack || '').replaceAll('\\', '/').matchAll(/local-demo-bridge-emulator-launcher\.js:(\d+)/g)].map(match => Number(match[1]));
    return `local-demo-bridge-emulator-launcher.js:${current.at(-1) || 1}`;
}

function formatLauncherFailure(error) {
    const detail = error && error.__launcherFailure || {};
    const stage = SAFE_LAUNCHER_STAGES.has(detail.stage) ? detail.stage : 'preflight';
    const code = SAFE_LAUNCHER_CODES.has(detail.code) ? detail.code : 'LAUNCHER_FAILED';
    return `LOCAL_DEMO_BRIDGE_FAILURE stage=${stage} code=${code} source=${safeLauncherSource(error, stage)}`;
}
const NON_SECRET_ENV = [
    'Path', 'PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT',
    'NODE_PATH', 'BUDGET_TOOL_LOCAL_DEPS', 'BUDGET_TOOL_PLAYWRIGHT_BROWSERS_PATH',
    'FIREBASE_EMULATORS_PATH', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME',
    'TEMP', 'TMP', 'TMPDIR'
];

function parseArgs(argv) {
    const values = argv || process.argv.slice(2);
    let mode = 'mock';
    let reset = false;
    let unattended = false;
    for (let index = 0; index < values.length; index += 1) {
        const value = values[index];
        if (value === '--mode') { mode = String(values[++index] || '').trim(); continue; }
        if (value === '--verify-mock-e2e') { mode = 'verify-mock-e2e'; continue; }
        if (value === '--verify-synthetic-e2e') { mode = 'verify-synthetic-e2e'; continue; }
        if (value === '--verify-sandbox-e2e') { mode = 'verify-sandbox-e2e'; continue; }
        if (value === '--reset-local-demo') { reset = true; continue; }
        if (value === '--unattended') { unattended = true; continue; }
        throw new Error('Unsupported local emulator launcher option.');
    }
    if (!MODES.has(mode)) throw new Error('Unsupported local emulator launcher mode.');
    if (unattended && mode !== 'create-item') throw new Error('Unattended mode requires create-item.');
    return { mode, reset, unattended };
}

function requireSandboxEnvironment(options, environment) {
    if (process.env.BUDGET_TOOL_LAUNCHER_CHECK === '1') return;
    if (!options || !((options.mode === 'create-item' && options.unattended) || options.mode === 'verify-sandbox-e2e')) return;
    const source = environment || process.env;
    const clientId = typeof source.PLAID_CLIENT_ID === 'string' && source.PLAID_CLIENT_ID.trim();
    const secret = typeof source.PLAID_SANDBOX_SECRET === 'string' && source.PLAID_SANDBOX_SECRET.trim();
    if (!clientId || !secret) throw new Error('Sandbox mode requires PLAID_CLIENT_ID and PLAID_SANDBOX_SECRET process variables.');
}

function copyNonSecretEnvironment(environment) {
    const source = environment || process.env;
    const output = {};
    for (const name of NON_SECRET_ENV) {
        const value = source[name];
        if (typeof value === 'string' && value) output[name] = value;
    }
    output.GCLOUD_PROJECT = PROJECT_ID;
    output.FIREBASE_AUTH_EMULATOR_HOST = AUTH_HOST;
    output.FIRESTORE_EMULATOR_HOST = FIRESTORE_HOST;
    return output;
}

function copyRunnerEnvironment(mode, reset, unattended, environment) {
    const source = environment || process.env;
    const output = copyNonSecretEnvironment(source);
    if ((mode === 'create-item' && unattended) || mode === 'verify-sandbox-e2e') {
        output.PLAID_CLIENT_ID = source.PLAID_CLIENT_ID || '';
        output.PLAID_SANDBOX_SECRET = source.PLAID_SANDBOX_SECRET || '';
    }
    output.BUDGET_TOOL_LOCAL_DEMO_MODE = mode;
    if (reset) output.BUDGET_TOOL_LOCAL_DEMO_RESET = '1';
    return output;
}

function firebasePaths() {
    const firebase = path.join(VERIFY_ROOT, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js');
    if (!fs.existsSync(firebase)) throw new Error('Firebase CLI is missing under the D: verification directory.');
    return { firebase, config: path.join(ROOT, 'firebase.test.json') };
}

function assertPortFree(port) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        socket.once('connect', () => { socket.destroy(); reject(new Error(`Local emulator port ${port} is already in use.`)); });
        socket.once('error', error => {
            socket.destroy();
            if (error && ['ECONNREFUSED', 'EHOSTUNREACH'].includes(error.code)) resolve();
            else reject(new Error(`Local emulator port ${port} could not be checked.`));
        });
    });
}

function waitForPortsFree(ports, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const attempt = async () => {
            try {
                for (const port of ports) await assertPortFree(port);
                resolve();
            } catch (error) {
                if (Date.now() >= deadline) reject(error);
                else setTimeout(attempt, 250);
            }
        };
        attempt();
    });
}

function waitForHttp(url, timeoutMs, child) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const attempt = () => {
            if (child && child.spawnError) { reject(launcherFailure('emulator', 'EMULATOR_SPAWN_FAILED')); return; }
            if (child && child.exitCode !== null) { reject(launcherFailure('emulator', 'EMULATOR_NOT_READY')); return; }
            const request = http.get(url, { timeout: 1000 }, response => { response.resume(); resolve(); });
            request.on('error', () => {
                if (Date.now() >= deadline) reject(launcherFailure('emulator', 'EMULATOR_NOT_READY'));
                else setTimeout(attempt, 250);
            });
            request.on('timeout', () => request.destroy());
        };
        attempt();
    });
}

function stopProcess(child) {
    if (!child || child.exitCode !== null || child.killed) return Promise.resolve();
    if (process.platform === 'win32' && child.pid) {
        // Kill the owned Firebase CLI tree while the parent PID is still
        // present; waiting for SIGINT can let the CLI exit before taskkill can
        // reach its Java emulator descendants.
        return new Promise(resolve => {
            const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
            const done = () => setTimeout(resolve, 250);
            killer.once('exit', done);
            killer.once('error', done);
        });
    }
    return new Promise(resolve => {
        let finished = false;
        const done = () => { if (!finished) { finished = true; resolve(); } };
        let exited = false;
        child.once('exit', () => { exited = true; });
        try { child.kill('SIGINT'); } catch (_) { done(); return; }
        const forceStop = () => {
            if (finished) return;
            if (!exited) {
                try { child.kill(); } catch (_) { /* process may have exited */ }
                setTimeout(done, 1000);
            } else {
                done();
            }
        };
        setTimeout(forceStop, 1000);
    });
}

function writeLauncherCheck(options, emulatorEnv, runnerEnv) {
    const output = process.env.BUDGET_TOOL_LAUNCHER_CAPTURE;
    if (!output) throw new Error('Launcher check output path is missing.');
    fs.writeFileSync(output, JSON.stringify({
        mode: options.mode,
        reset: options.reset,
        emulatorEnvKeys: Object.keys(emulatorEnv).sort(),
        runnerEnvKeys: Object.keys(runnerEnv).sort(),
        runnerArgs: [
            options.mode === 'verify-sandbox-e2e' ? 'tests/approved-sandbox-e2e.cjs' : options.mode === 'verify-synthetic-e2e' ? 'tests/approved-sandbox-synthetic-e2e.cjs' : options.mode === 'verify-mock-e2e' ? 'tests/local-demo-bridge.test.cjs' : '--mode',
            ...(options.mode === 'verify-sandbox-e2e' || options.mode === 'verify-synthetic-e2e' || options.mode === 'verify-mock-e2e' ? [] : [options.mode]),
            ...(options.unattended ? ['--unattended'] : []),
            ...(options.reset ? ['--reset-local-demo'] : [])
        ]
    }), 'utf8');
}

async function main(argv, dependencies) {
    const deps = dependencies || {};
    const options = parseArgs(argv);
    requireSandboxEnvironment(options, process.env);
    const paths = typeof deps.firebasePaths === 'function' ? deps.firebasePaths() : firebasePaths();
    const spawnChild = typeof deps.spawn === 'function' ? deps.spawn : spawn;
    const emulatorEnv = copyNonSecretEnvironment(process.env);
    const runnerEnv = process.env.BUDGET_TOOL_LAUNCHER_CHECK === '1'
        ? { ...emulatorEnv }
        : copyRunnerEnvironment(options.mode, options.reset, options.unattended, process.env);
    if (process.env.BUDGET_TOOL_LAUNCHER_CHECK === '1') { writeLauncherCheck(options, emulatorEnv, runnerEnv); return; }
    await assertPortFree(9099);
    await assertPortFree(8088);
    const emulator = spawnChild(process.execPath, [paths.firebase, 'emulators:start', '--only', 'auth,firestore', '--project', PROJECT_ID, '--config', paths.config], {
        cwd: VERIFY_ROOT, env: emulatorEnv, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true
    });
    emulator.spawnError = false;
    emulator.once('error', () => { emulator.spawnError = true; });
    let bridgeRunner;
    let stopping = false;
    const cleanup = async () => {
        if (stopping) return;
        stopping = true;
        await stopProcess(bridgeRunner);
        await stopProcess(emulator);
    };
    process.once('SIGINT', async () => { await cleanup(); process.exit(130); });
    process.once('SIGTERM', async () => { await cleanup(); process.exit(143); });
    try {
        await waitForHttp(`http://${AUTH_HOST}/`, 60_000, emulator);
        await waitForHttp(`http://${FIRESTORE_HOST}/`, 60_000, emulator);
        const runnerArgs = options.mode === 'verify-sandbox-e2e'
            ? ['tests/approved-sandbox-e2e.cjs']
            : options.mode === 'verify-synthetic-e2e'
                ? ['tests/approved-sandbox-synthetic-e2e.cjs']
            : options.mode === 'verify-mock-e2e'
                ? ['tests/local-demo-bridge.test.cjs']
            : ['local-demo-bridge-runner.js'];
        if (options.mode !== 'mock' && options.mode !== 'verify-mock-e2e' && options.mode !== 'verify-synthetic-e2e' && options.mode !== 'verify-sandbox-e2e') runnerArgs.push(options.mode === 'create-item' ? '--create-item' : '--sync-with-existing-token');
        if (options.unattended) runnerArgs.push('--unattended');
        if (options.reset) runnerArgs.push('--reset-local-demo');
        bridgeRunner = spawnChild(process.execPath, runnerArgs, { cwd: ROOT, env: runnerEnv, stdio: 'inherit', windowsHide: true });
        let runnerSpawnError = null;
        const exitCode = await new Promise(resolve => {
            let settled = false;
            const finish = code => { if (!settled) { settled = true; resolve(Number.isInteger(code) ? code : 1); } };
            bridgeRunner.once('exit', code => finish(code));
            bridgeRunner.once('error', error => { runnerSpawnError = error; finish(1); });
        });
        await cleanup();
        await waitForPortsFree([9099, 8088], 10_000);
        if (runnerSpawnError) throw launcherFailure('runner', 'RUNNER_SPAWN_FAILED');
        if (exitCode !== 0) throw launcherFailure('runner', 'RUNNER_FAILED');
        process.exitCode = exitCode;
    } catch (error) {
        await cleanup();
        await waitForPortsFree([9099, 8088], 10_000).catch(() => {});
        throw error;
    }
}

if (require.main === module) main().catch(error => { console.error(formatLauncherFailure(error)); process.exitCode = 1; });

module.exports = { parseArgs, requireSandboxEnvironment, copyNonSecretEnvironment, copyRunnerEnvironment, safeLauncherSource, formatLauncherFailure, main };

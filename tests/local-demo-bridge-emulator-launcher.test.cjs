'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const launcher = require('../local-demo-bridge-emulator-launcher.js');

;(async () => {
    const secretError = new Error('provider secret must never be printed');
    Object.defineProperty(secretError, '__launcherFailure', { value: { stage: 'runner', code: 'RUNNER_SPAWN_FAILED' } });
    const safe = launcher.formatLauncherFailure(secretError);
    assert.match(safe, /^LOCAL_DEMO_BRIDGE_FAILURE stage=runner code=RUNNER_SPAWN_FAILED source=local-demo-bridge-emulator-launcher\.js:\d+$/);
    assert.doesNotMatch(safe, /provider secret/);

    let spawnCalls = 0;
    await assert.rejects(() => launcher.main(['--verify-synthetic-e2e'], {
        firebasePaths: () => ({ firebase: 'fixture-firebase.js', config: 'fixture-config.json' }),
        // Exercise the real OS child-process error boundary with a fixed,
        // deliberately nonexistent D: executable. The emitted ENOENT text is
        // never included in launcher output.
        spawn: () => {
            spawnCalls += 1;
            return spawn('D:\\Documents\\Codex\\budget-tool-missing-executable-7f4d2f\\firebase.exe', [], { windowsHide: true });
        }
    }), error => {
        assert.equal(spawnCalls, 1);
        assert.equal(launcher.formatLauncherFailure(error), 'LOCAL_DEMO_BRIDGE_FAILURE stage=emulator code=EMULATOR_SPAWN_FAILED source=local-demo-bridge-emulator-launcher.js:147');
        return true;
    });
    console.log('PASS: local emulator launcher safely classifies child spawn failures without exposing error text.');
})().catch(error => { console.error(error); process.exitCode = 1; });

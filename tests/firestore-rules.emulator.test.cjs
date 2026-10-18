const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');

const projectId = 'demo-budget-tool';
const rulesPath = path.resolve(__dirname, '..', 'firestore.rules');
const rules = fs.readFileSync(rulesPath, 'utf8');
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8088';
const [host, portText] = emulatorHost.split(':');
const port = Number(portText);
assert.ok(['127.0.0.1', 'localhost', '::1'].includes(host) || (net.isIP(host) === 6 && host === '::1'), `Refusing non-loopback Firestore emulator host: ${host}`);
assert.ok(Number.isInteger(port) && port > 0 && port < 65536, `Invalid Firestore emulator port: ${portText}`);

async function main() {
    assert.ok(fs.existsSync(rulesPath), `Rules file is missing: ${rulesPath}`);
    assert.equal(projectId, 'demo-budget-tool');
    const testEnv = await initializeTestEnvironment({
        projectId,
        firestore: { host, port, rules }
    });
    try {
        const anonymous = testEnv.unauthenticatedContext();
        const allowed = testEnv.authenticatedContext('allowed-user', {
            email: 'captainicebow@gmail.com', email_verified: true
        });
        const secondAllowed = testEnv.authenticatedContext('second-user', {
            email: 'mgstiles13@gmail.com', email_verified: true
        });
        const unapproved = testEnv.authenticatedContext('unapproved-user', {
            email: 'unapproved@example.test', email_verified: true
        });
        const unverified = testEnv.authenticatedContext('unverified-user', {
            email: 'captainicebow@gmail.com', email_verified: false
        });
        const ref = (context, documentPath) => context.firestore().doc(documentPath);
        const sharedRef = ref(allowed, 'shared/data');

        await assertFails(ref(anonymous, 'shared/data').get());
        await assertFails(ref(unapproved, 'shared/data').get());
        await assertFails(ref(unverified, 'shared/data').get());
        await assertFails(ref(allowed, 'protectedTransactionReview/household-1').set({ pending: [] }));
        await assertFails(ref(allowed, 'protectedAcceptedTransactions/household-1').get());
        for (const protectedPath of ['protectedConnections/chase', 'protectedSyncRuns/run-1']) {
            await assertFails(ref(allowed, protectedPath).get());
            await assertFails(ref(allowed, protectedPath).set({ owner: 'allowed-user' }));
        }

        await assertSucceeds(sharedRef.set({ transactions: [], revision: 1 }));
        await assertSucceeds(ref(secondAllowed, 'shared/data').get());
        await assertFails(ref(unapproved, 'shared/unauthorized').set({ transactions: [], revision: 1 }));
        await assertFails(sharedRef.set({ transactions: [], revision: 3 }));
        await assertFails(sharedRef.set({ transactions: [], revision: -1 }));
        await assertFails(sharedRef.set({ transactions: [], revision: '2' }));
        await assertFails(sharedRef.set({ transactions: [{ date: '2026-10-01', amount: -1 }], revision: 2 }));
        await assertFails(sharedRef.delete());

        await testEnv.withSecurityRulesDisabled(async adminContext => {
            await ref(adminContext, 'shared/data').set({ transactions: [], categories: [] });
        });
        const legacyRef = ref(allowed, 'shared/data');
        await assertSucceeds(legacyRef.set({ transactions: [], categories: [], revision: 1 }));
        await assertFails(legacyRef.set({ transactions: [], categories: [], revision: 1 }));
        await assertSucceeds(legacyRef.set({ transactions: [], categories: [{ name: 'Changed' }], revision: 2 }));
        await assertFails(legacyRef.set({ transactions: [{ date: '2026-10-02', amount: -2 }], categories: [{ name: 'Changed' }], revision: 3 }));

        console.log('PASS: Firestore emulator rules matrix for auth allowlist, protected collections, accepted transaction immutability, and legacy revision baseline.');
    } finally {
        await testEnv.cleanup();
    }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

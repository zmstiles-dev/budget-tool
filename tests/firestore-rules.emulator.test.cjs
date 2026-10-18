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
        const seededUid = testEnv.authenticatedContext('seeded-uid', {
            email: 'uid-member@example.test', email_verified: true
        });
        const wrongSeededEmail = testEnv.authenticatedContext('wrong-seeded-uid', {
            email: 'different@example.test', email_verified: true
        });
        const wrongSeededHousehold = testEnv.authenticatedContext('wrong-household-uid', {
            email: 'uid-member@example.test', email_verified: true
        });
        const otherHouseholdMember = testEnv.authenticatedContext('other-household-member', {
            email: 'other-member@example.test', email_verified: true
        });
        const uppercaseToken = testEnv.authenticatedContext('uppercase-token', {
            email: 'UID-MEMBER@EXAMPLE.TEST', email_verified: true
        });
        const emptyHouseholdMember = testEnv.authenticatedContext('empty-household-member', {
            email: 'empty-household@example.test', email_verified: true
        });
        const uppercaseStoredEmail = testEnv.authenticatedContext('uppercase-stored-email', {
            email: 'uid-member@example.test', email_verified: true
        });
        const ref = (context, documentPath) => context.firestore().doc(documentPath);
        await testEnv.withSecurityRulesDisabled(async adminContext => {
            await ref(adminContext, 'protectedAppConfig/transactionService').set({ allowed: true, householdId: 'household-1' });
            await ref(adminContext, 'protectedAppUsers/allowed-user').set({ allowed: true, uid: 'allowed-user', email: 'captainicebow@gmail.com', householdId: 'household-1' });
            await ref(adminContext, 'protectedAppUsers/second-user').set({ allowed: true, uid: 'second-user', email: 'mgstiles13@gmail.com', householdId: 'household-1' });
            await ref(adminContext, 'protectedAppUsers/seeded-uid').set({ allowed: true, uid: 'seeded-uid', email: 'uid-member@example.test', householdId: 'household-1' });
            await ref(adminContext, 'protectedAppUsers/wrong-seeded-uid').set({ allowed: true, uid: 'wrong-seeded-uid', email: 'uid-member@example.test', householdId: 'household-1' });
            await ref(adminContext, 'protectedAppUsers/wrong-household-uid').set({ allowed: true, uid: 'wrong-household-uid', email: 'uid-member@example.test', householdId: 'household-2' });
            await ref(adminContext, 'protectedAppUsers/other-household-member').set({ allowed: true, uid: 'other-household-member', email: 'other-member@example.test', householdId: 'household-2' });
            await ref(adminContext, 'protectedAppUsers/uppercase-token').set({ allowed: true, uid: 'uppercase-token', email: 'uid-member@example.test', householdId: 'household-1' });
            await ref(adminContext, 'protectedAppUsers/empty-household-member').set({ allowed: true, uid: 'empty-household-member', email: 'empty-household@example.test', householdId: '' });
            await ref(adminContext, 'protectedAppUsers/uppercase-stored-email').set({ allowed: true, uid: 'uppercase-stored-email', email: 'UID-MEMBER@EXAMPLE.TEST', householdId: 'household-1' });
        });
        const sharedRef = ref(allowed, 'shared/data');

        await assertFails(ref(anonymous, 'shared/data').get());
        await assertFails(ref(unapproved, 'shared/data').get());
        await assertFails(ref(unverified, 'shared/data').get());
        await assertSucceeds(ref(allowed, 'shared/data').get());
        await assertSucceeds(ref(secondAllowed, 'shared/data').get());
        await assertSucceeds(ref(seededUid, 'shared/data').get());
        await assertFails(ref(wrongSeededEmail, 'shared/data').get());
        await assertFails(ref(wrongSeededHousehold, 'shared/data').get());
        await assertFails(ref(otherHouseholdMember, 'shared/data').get());
        await assertFails(ref(uppercaseToken, 'shared/data').get());
        await assertFails(ref(emptyHouseholdMember, 'shared/data').get());
        await assertFails(ref(uppercaseStoredEmail, 'shared/data').get());
        await testEnv.withSecurityRulesDisabled(async adminContext => {
            await ref(adminContext, 'protectedAppConfig/transactionService').delete();
        });
        await assertFails(ref(seededUid, 'shared/data').get());
        await testEnv.withSecurityRulesDisabled(async adminContext => {
            await ref(adminContext, 'protectedAppConfig/transactionService').set({ allowed: true, householdId: 'household-1' });
        });
        await testEnv.withSecurityRulesDisabled(async adminContext => {
            await ref(adminContext, 'protectedAppConfig/transactionService').set({ allowed: true, householdId: '   ' });
        });
        await assertFails(ref(seededUid, 'shared/data').get());
        await testEnv.withSecurityRulesDisabled(async adminContext => {
            await ref(adminContext, 'protectedAppConfig/transactionService').set({ allowed: true, householdId: 'household-1' });
        });
        await assertFails(ref(allowed, 'protectedTransactionReview/household-1').set({ pending: [] }));
        await assertFails(ref(allowed, 'protectedAcceptedTransactions/household-1').get());
        for (const protectedPath of ['protectedConnections/chase', 'protectedSyncRuns/run-1']) {
            await assertFails(ref(allowed, protectedPath).get());
            await assertFails(ref(allowed, protectedPath).set({ owner: 'allowed-user' }));
        }

        await assertSucceeds(sharedRef.set({ transactions: [], revision: 1 }));
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

        console.log('PASS: Firestore emulator rules matrix for protected UID membership, normalized email/household parity, protected collections, accepted transaction immutability, and legacy revision baseline.');
    } finally {
        await testEnv.cleanup();
    }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

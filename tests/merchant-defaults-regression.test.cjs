'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const review = require('../transaction-review.js');
const { ProtectedReviewBackend } = require('../transaction-backend.js');
const auth = { uid: 'synthetic-user', email: 'synthetic@example.test', tokenVerified: true, householdId: 'synthetic-household' };
const row = { date: '2026-10-12', description: 'Synthetic row', amount: -5, category: 'Restaurants', account: 'Checking Account', payment_method: 'Checking Account', type: 'expense' };
const state = () => ({ transactions: [row], categories: [{ name: 'Restaurants', type: 'expense' }, { name: 'Travel', type: 'expense' }], budgets: { Restaurants: { '2026-10': 40 } }, merchantDefaults: { 'Token Market': 'Restaurants', 'token market': 'Restaurants', tokenmarket: 'Restaurants', 'Secret Garden': 'Restaurants', 'Password Shop': 'Restaurants', 'Token Coffee': { category: 'Restaurants', type: 'expense' } }, categoryGroups: [], categoryColors: {}, categoryOrder: [] });
test('merchant-name keys remain valid in backup and accepted category/budget saves', async () => {
    const input = state(); const backup = review.createBackup(input);
    assert.deepEqual(backup.merchantDefaults, input.merchantDefaults);
    const backend = new ProtectedReviewBackend({ householdId: auth.householdId, allowedUsers: [auth.email], initialState: input });
    const categoryEdit = state(); categoryEdit.transactions = [{ ...row, category: 'Travel' }];
    assert.equal(backend.saveAcceptedState(auth, categoryEdit, 0).state.transactions[0].category, 'Travel');
    categoryEdit.budgets.Restaurants['2026-11'] = 40;
    assert.equal(backend.saveAcceptedState(auth, categoryEdit, 1).state.budgets.Restaurants['2026-11'], 40);
});
test('credential-shaped dictionary names and nested fields remain rejected', () => {
    for (const key of ['token', 'accessToken', 'accesstoken', 'access token', 'client secret', 'api key', 'private key', 'refresh token', 'provider tokens', 'refreshToken', 'providerTokens', 'apiKey', 'accesskey', 'idToken', 'clientSecret', 'customAccessToken', 'my_access_token', 'custom-access-token', 'secretKey', 'privatekey']) {
        assert.throws(() => review.createBackup({ ...state(), merchantDefaults: { [key]: 'synthetic-secret' } }), /credentials/);
    }
    assert.throws(() => review.createBackup({ ...state(), merchantDefaults: { 'Token Coffee': { category: 'Restaurants', providerSessionToken: 'synthetic-secret' } } }), /credentials/);
    assert.throws(() => review.createBackup(state(), { accessToken: 'synthetic-secret' }), /credentials/);
});
test('unchanged opaque history survives saves while invalid-row edits and duplicates remain rejected', () => {
    const input = state(); input.transactions.push({ ...row, date: 'Unknown', description: 'Synthetic legacy row' });
    const backend = new ProtectedReviewBackend({ householdId: auth.householdId, allowedUsers: [auth.email], initialState: input });
    const edit = structuredClone(input); edit.transactions[0].category = 'Travel';
    assert.deepEqual(backend.saveAcceptedState(auth, edit, 0).state.transactions[1], input.transactions[1]);
    const changedLegacy = structuredClone(edit); changedLegacy.transactions[1].category = 'Travel';
    assert.throws(() => backend.saveAcceptedState(auth, changedLegacy, 1), /invalid or changed/);
    const duplicatedLegacy = structuredClone(edit); duplicatedLegacy.transactions.push(input.transactions[1]);
    assert.throws(() => backend.saveAcceptedState(auth, duplicatedLegacy, 1), /invalid or changed/);
});

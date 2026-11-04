'use strict';
const assert = require('node:assert/strict');
const { providerImportExclusion: exclude, PlaidTransactionsSyncAdapter, ProtectedReviewBackend, DurableProtectedReviewBackend } = require('../transaction-backend.js');
const auth = { uid: 'test-user', email: 'reviewer@example.test', tokenVerified: true, householdId: 'test' };
const base = { transaction_id: 'test-row', account_id: 'checking', date: '2026-10-30', amount: 100, iso_currency_code: 'USD', name: 'Coffee', category: [] };
const finance = (primary, detailed) => ({ personal_finance_category: { primary, detailed } });
const excluded = [
    { name: 'ACH debit', ...finance('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT') },
    { name: 'Credit', amount: -100, ...finance('TRANSFER_IN', 'TRANSFER_IN_CREDIT_CARD_PAYMENT') },
    { name: 'Debit', ...finance('TRANSFER_OUT', 'TRANSFER_OUT_CREDIT_CARD_PAYMENT') },
    { name: 'Payment', category: ['Payment', 'Credit Card'] },
    { name: 'CAPITAL ONE MOBILE PYMT' },
    { name: 'Payment Thank You', amount: -100 },
    { name: 'Payment to credit card' },
    { name: 'ONLINE PAYMENT', account: 'CFF', amount: -100 },
    { name: 'Payment Received', category: ['Transfer', 'Credit'], account: 'CFF', amount: -100 },
    { name: 'Morgan Stanley transfer', amount: 100 },
    { name: 'ACH TRANSFER MORGAN STANLEY', amount: -100 },
    { name: 'Morgan Stanley', ...finance('TRANSFER_OUT', 'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS') },
    { name: 'Morgan Stanley', ...finance('', 'TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS') },
    { name: 'Deposit', merchant_name: 'Morgan Stanley', amount: -100, ...finance('TRANSFER_IN', 'TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS') }
];
const retained = [
    { name: 'Coffee purchase', ...finance('FOOD_AND_DRINK', 'FOOD_AND_DRINK_COFFEE') },
    { name: 'Morgan Stanley' },
    { name: 'ACH MORGAN STANLEY', amount: -100 },
    { name: 'Morgan Stanley advisory fee', ...finance('BANK_FEES', 'BANK_FEES_OTHER_BANK_FEES') },
    { name: 'Morgan Stanley refund', amount: -20 },
    { name: 'Morgan Stanley payroll', amount: -100, ...finance('INCOME', 'INCOME_WAGES') },
    { name: 'Chase online payment store', merchant_name: 'Chase online payment store' },
    { name: 'Capital One mobile pymt', ...finance('GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_SUPERSTORES') },
    { name: 'Online Payment', account: 'Checking Account' },
    { name: 'Online Payment', account: 'CFF', amount: 100 },
    { name: 'Online Payment', account: 'CFF', amount: -100, merchant_name: 'Electric Company' },
    { name: 'Card payment processing fee' },
    { name: 'Credit card payment refund', amount: -100 },
    { name: 'Mortgage payment', ...finance('LOAN_PAYMENTS', 'LOAN_PAYMENTS_MORTGAGE_PAYMENT') },
    { name: 'ACH utility payment', ...finance('RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_ELECTRICITY') },
    { name: 'Rent transfer' },
    { name: 'Merchant payment', amount: -100 },
    { name: 'Card Payment Solutions', merchant_name: 'Card Payment Solutions' },
    { name: 'Credit card payment fee', ...finance('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT') },
    { name: 'Credit card payment refund', amount: -100, ...finance('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT') }
];
for (const row of excluded) assert.ok(exclude({ ...base, ...row }), `exclude: ${row.name}`);
for (const row of retained) assert.equal(exclude({ ...base, ...row }), '', `retain: ${row.name}`);

(async () => {
    let classifications = 0;
    let calls = 0;
    const adapter = new PlaidTransactionsSyncAdapter({
        client: { sync: async () => { calls++; return { added: excluded.map((row, i) => ({ ...base, ...row, account_id: row.account === 'CFF' ? 'card' : 'checking', transaction_id: `excluded-${i}` })), modified: [], removed: [], has_more: false, next_cursor: 'next' }; } },
        accountMap: { checking: 'Checking Account', card: 'CFF' }, classify: () => { classifications++; return ''; }
    });
    const delta = await adapter.fetchDelta({ accessToken: 'synthetic-token', connectionKey: 'test' });
    assert.equal(delta.pages.flatMap(page => page.records).length, 0);
    assert.equal(delta.cursor, 'next');
    assert.equal(calls, 1);
    assert.equal(classifications, 0, 'excluded added observations never invoke optional classification');
    for (const [i, row] of retained.entries()) {
        assert.ok(await adapter.normalizeTransaction({ ...base, ...row, account_id: row.account === 'CFF' ? 'card' : 'checking', transaction_id: `retained-${i}` }, 'added', i, '', 'test'), `adapter retains ${row.name}`);
    }
    const backend = new ProtectedReviewBackend({ householdId: 'test', allowedUsers: [auth.email] });
    const purchase = await adapter.normalizeTransaction({ ...base, name: 'Coffee', ...finance('FOOD_AND_DRINK', 'FOOD_AND_DRINK_COFFEE') }, 'added', 0, '', 'test');
    const old = (await backend.stage(auth, [purchase], { source: 'bank-provider', serverIngest: true })).candidates[0];
    const beforeExcludedModification = classifications;
    const modification = await adapter.normalizeTransaction({ ...base, name: 'Morgan Stanley', ...finance('TRANSFER_OUT', 'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS') }, 'modified', 0, '', 'test');
    assert.equal(classifications, beforeExcludedModification, 'modified exclusions also bypass classification');
    const updated = (await backend.stage(auth, [modification], { source: 'bank-provider', serverIngest: true })).candidates[0];
    assert.equal((await backend.listPending(auth)).length, 0, 'modified exclusion supersedes stale suggestion');
    assert.deepEqual(backend.exportReviewSnapshot().pending, [], 'browser loadReview snapshot suppresses exclusions too');
    assert.equal(backend.pending.size, 1, 'suppressed source retained for audit');
    await assert.rejects(backend.approve(auth, { candidateIds: [updated.id], revisions: [updated.revision], idempotencyKey: 'blocked' }), /excluded/);
    await assert.rejects(backend.approve(auth, { candidateIds: [old.id], revisions: [old.revision], idempotencyKey: 'stale' }), /pending/);
    const pendingPurchase = await adapter.normalizeTransaction({ ...base, transaction_id: 'pending-row', name: 'Unknown observation', pending: true }, 'added', 0, '', 'test');
    await backend.stage(auth, [pendingPurchase], { source: 'bank-provider', serverIngest: true });
    const postedPayment = await adapter.normalizeTransaction({ ...base, transaction_id: 'posted-row', pending_transaction_id: 'pending-row', name: 'Payment Thank You', amount: -100 }, 'added', 0, '', 'test');
    assert.ok(postedPayment, 'posted exclusion must supersede ambiguous pending observation');
    await backend.stage(auth, [postedPayment], { source: 'bank-provider', serverIngest: true });
    assert.deepEqual(backend.exportReviewSnapshot().pending, [], 'posted payment replaces pending suggestion');
    // Simulate a previously queued legacy row whose user-facing name was edited.
    const legacy = { ...purchase, id: 'legacy@1', sourceIdentity: 'legacy', sourceRevision: '1', description: 'Payment Thank You', merchant: 'Payment Thank You' };
    const queued = (await backend.stage(auth, [legacy], { source: 'bank-provider' })).candidates[0];
    queued.sourceOriginal.category = 'Payment,Credit Card';
    queued.description = 'Edited description';
    queued.category = 'Restaurants';
    backend.pending.set(queued.id, queued);
    backend.accepted.set('saved-history', { ...queued, id: 'saved-history', status: 'approved' });
    const saved = JSON.stringify([...backend.accepted]);
    assert.equal((await backend.listPending(auth)).length, 0);
    await assert.rejects(backend.approve(auth, { candidateIds: [queued.id], revisions: [queued.revision], idempotencyKey: 'legacy-blocked' }), /excluded/);
    const relabeled = await backend.edit(auth, queued.id, { source: 'manual-csv', description: 'Relabeled row' }, queued.revision);
    assert.deepEqual(backend.exportReviewSnapshot().pending, [], 'editing the source label cannot bypass original provider evidence');
    await assert.rejects(backend.approve(auth, { candidateIds: [relabeled.id], revisions: [relabeled.revision], idempotencyKey: 'relabeled-blocked' }), /excluded/);
    assert.equal(JSON.stringify([...backend.accepted]), saved, 'saved history is byte-for-byte unchanged');
    let snapshot = backend.exportState();
    const persisted = JSON.stringify(snapshot);
    const repository = {
        read: async () => structuredClone(snapshot),
        transaction: async callback => { const output = await callback(structuredClone(snapshot)); snapshot = output.state; return output.result; }
    };
    const durable = new DurableProtectedReviewBackend({ repository, householdId: 'test', allowedUsers: [auth.email] });
    assert.deepEqual(await durable.listPending(auth), [], 'durable reload also suppresses queued exclusions');
    assert.deepEqual((await durable.exportReview(auth)).pending, [], 'actual browser review endpoint suppresses exclusions');
    await assert.rejects(durable.approve(auth, { candidateIds: [queued.id], revisions: [queued.revision], idempotencyKey: 'durable-blocked' }), /excluded/);
    assert.equal(JSON.stringify(snapshot), persisted, 'list and rejected approval never write durable state');
    console.log(`PASS provider import exclusions: ${excluded.length} exclusions, ${retained.length} legitimate cases, sync/cursor, stale revision and approval safety`);
})().catch(error => { console.error(error); process.exitCode = 1; });

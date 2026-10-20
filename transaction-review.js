/*
 * Local transaction review contract.
 *
 * This module deliberately has no storage, network, Firebase or provider
 * dependencies. It is safe to use in the browser for staging and in Node for
 * synthetic contract tests. A deployed service must provide the same
 * revision-bound approval semantics and durable acknowledgement before it can
 * replace this in-memory implementation.
 */
(function (root) {
    'use strict';

    const VERSION = 1;
    const STATES = Object.freeze({ PENDING: 'pending', DEFERRED: 'deferred', REJECTED: 'rejected', APPROVED: 'approved' });

    function clone(value) {
        if (value === undefined) return value;
        return JSON.parse(JSON.stringify(value));
    }

    const PROVIDER_TRACKING_FIELDS = Object.freeze([
        'providerTransactionId', 'providerAccountId', 'providerConnectionKey',
        'pendingTransactionId', 'providerPending', 'providerClassification',
        'transaction_id', 'pending_transaction_id', 'account_id'
    ]);

    function restoreProviderTrackingFields(current, next) {
        const source = current || {};
        const target = next || {};
        PROVIDER_TRACKING_FIELDS.forEach(field => {
            if (Object.prototype.hasOwnProperty.call(source, field)) target[field] = clone(source[field]);
            else delete target[field];
        });
        return target;
    }

    function text(value) {
        return String(value ?? '').trim();
    }

    const CHECKING_ACCOUNT_ALIAS = 'Checking Account';

    function checkingAccount(record) {
        const source = record || {};
        return text(source.account || source.payment_method) === CHECKING_ACCOUNT_ALIAS;
    }

    function categoryTokens(value) {
        return new Set(text(value).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean));
    }

    // A provider payroll/income category is an explicit classification. A
    // merchant name is deliberately excluded so checking reimbursements and
    // other credits cannot be converted by a name heuristic.
    function hasCheckingIncomeCategory(value) {
        const tokens = categoryTokens(value);
        return tokens.has('PAYROLL') || (tokens.has('INCOME') && !tokens.has('TAX'));
    }

    function normalizeCheckingIncomeAmount(record) {
        const candidate = record || {};
        if (candidate.type === 'income' && checkingAccount(candidate)) candidate.amount = Math.abs(integerCents(candidate.amount) / 100);
        return candidate;
    }

    function sourceOriginalForCorrection(candidate, rawAmount) {
        const original = candidate && candidate.sourceOriginal && typeof candidate.sourceOriginal === 'object'
            ? clone(candidate.sourceOriginal)
            : clone(candidate || {});
        if (rawAmount !== undefined) original.amount = rawAmount;
        ['status', 'revision', 'reviewedRevision', 'overlap', 'overlapDetails', 'rejectedBy', 'rejectedAt',
            'deferredBy', 'deferredAt', 'supersededBy', 'supersededAt', 'approvedBy', 'approvedAt', 'sourceOriginal'].forEach(field => delete original[field]);
        return original;
    }

    // Hydration compatibility for provider payroll rows written before the
    // checking-income sign rule existed. Only an untouched first revision is
    // eligible for inferred classification; a user-edited expense remains an
    // expense. Explicit income rows are normalized at every revision.
    function normalizePendingCandidate(candidate) {
        const source = clone(candidate || {});
        const explicitIncome = source.type === 'income';
        const untouched = Number(source.revision) === 1 && Number(source.reviewedRevision) === 1;
        const originalCategory = source.sourceOriginal && text(source.sourceOriginal.category);
        const originalType = source.sourceOriginal && text(source.sourceOriginal.type);
        const matchesOriginalClassification = !source.sourceOriginal
            || (originalCategory === text(source.category) && (!originalType || originalType === text(source.type)));
        const providerClassification = text(source.providerClassification || source.sourceOriginal && source.sourceOriginal.providerClassification);
        const inferredPayroll = source.source === 'bank-provider' && checkingAccount(source) && source.type !== 'income'
            && untouched && Number(source.amount) < 0 && hasCheckingIncomeCategory(source.category)
            && matchesOriginalClassification
            && !providerClassification
            && !categoryTokens(source.category).has('REIMBURSEMENT');
        if (!checkingAccount(source) || (!explicitIncome && !inferredPayroll)) return source;
        const rawAmount = Number(source.amount);
        const normalized = normalizeCheckingIncomeAmount({ ...source, ...(inferredPayroll ? { type: 'income' } : {}) });
        if (normalized.amount === source.amount && normalized.type === source.type) return source;
        normalized.sourceOriginal = sourceOriginalForCorrection(source, rawAmount);
        normalized.revision = Number.isSafeInteger(source.revision) ? source.revision + 1 : source.revision;
        normalized.reviewedRevision = normalized.revision;
        normalized.fingerprint = stableFingerprint(normalized);
        return normalized;
    }

    function normalizeDescription(value) {
        return text(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    }

    const OVERLAP_DATE_WINDOW_DAYS = 3;
    const OVERLAP_STOP_WORDS = new Set(['a', 'an', 'and', 'at', 'card', 'charge', 'co', 'company', 'inc', 'invoice', 'llc', 'payment', 'purchase', 'store', 'the', 'transaction']);

    function overlapAccount(record) {
        return normalizeDescription(record && (record.account || record.payment_method));
    }

    function overlapTokens(record) {
        const source = [record && record.merchant, record && record.description].map(normalizeDescription).filter(Boolean).join(' ');
        return new Set(source.split(/\s+/).filter(token => token.length >= 3 && !OVERLAP_STOP_WORDS.has(token)));
    }

    function overlapDateDeltaDays(left, right) {
        const first = text(left && left.date);
        const second = text(right && right.date);
        if (!strictDate(first) || !strictDate(second)) return null;
        return Math.abs((Date.parse(`${first}T00:00:00Z`) - Date.parse(`${second}T00:00:00Z`)) / 86400000);
    }

    function possibleOverlapDetails(candidate, item, itemId) {
        if (!candidate || !item || candidate.id && item.id && candidate.id === item.id) return null;
        let candidateAmount;
        let itemAmount;
        try {
            candidateAmount = integerCents(candidate.amount);
            itemAmount = integerCents(item.amount);
        } catch (_) {
            return null;
        }
        const account = overlapAccount(candidate);
        if (!account || account !== overlapAccount(item) || candidateAmount !== itemAmount) return null;
        const dateDeltaDays = overlapDateDeltaDays(candidate, item);
        if (dateDeltaDays === null || dateDeltaDays > OVERLAP_DATE_WINDOW_DAYS) return null;
        const candidateDescription = normalizeDescription(candidate.description);
        const itemDescription = normalizeDescription(item.description);
        const candidateMerchant = normalizeDescription(candidate.merchant);
        const itemMerchant = normalizeDescription(item.merchant);
        const exactDescription = candidateDescription && candidateDescription === itemDescription;
        const exactMerchant = candidateMerchant && candidateMerchant === itemMerchant;
        const leftTokens = overlapTokens(candidate);
        const rightTokens = overlapTokens(item);
        const sharedTokens = [...leftTokens].filter(token => rightTokens.has(token)).sort();
        const combinedTokens = new Set([...leftTokens, ...rightTokens]);
        // A one-token match is only useful when it is a distinctive token and
        // at least one side is short. This avoids warning on unrelated rows
        // that happen to share generic words such as "store" or "payment".
        const distinctiveSharedToken = sharedTokens.some(token => token.length >= 4);
        const shortMerchantMatch = distinctiveSharedToken && (leftTokens.size <= 2 || rightTokens.size <= 2);
        if (!exactDescription && !exactMerchant && sharedTokens.length < 2 && !shortMerchantMatch) return null;
        const confidence = exactDescription || exactMerchant || sharedTokens.length >= 2 ? 'high' : 'medium';
        return {
            id: text(itemId || item.id),
            confidence,
            dateDeltaDays,
            account: text(candidate.account || candidate.payment_method),
            amount: candidateAmount / 100,
            candidate: { date: text(candidate.date), description: text(candidate.description), merchant: text(candidate.merchant) },
            matched: { date: text(item.date), description: text(item.description), merchant: text(item.merchant) },
            sharedWords: sharedTokens,
            wordCoverage: combinedTokens.size ? sharedTokens.length / combinedTokens.size : 1,
            reason: exactDescription ? 'same normalized description' : exactMerchant ? 'same normalized merchant' : 'nearby date and merchant tokens'
        };
    }

    function overlapDetailsFor(candidate, items) {
        return (items || []).map(entry => {
            const item = Array.isArray(entry) ? entry[1] : entry;
            const itemId = Array.isArray(entry) ? entry[0] : item && item.id;
            return possibleOverlapDetails(candidate, item, itemId);
        }).filter(Boolean);
    }

    function integerCents(value) {
        const candidate = String(value ?? '').trim();
        if (!/^-?(?:\d+)(?:\.\d{1,2})?$/.test(candidate)) throw new Error('Amount must be a finite value with at most two decimal places.');
        const negative = candidate.startsWith('-');
        const unsigned = negative ? candidate.slice(1) : candidate;
        const [whole, fraction = ''] = unsigned.split('.');
        const cents = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
        const signed = negative ? -cents : cents;
        if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('Amount is outside the supported safe range.');
        return Number(signed);
    }

    function strictDate(value) {
        const candidate = text(value);
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(candidate);
        if (!match) return false;
        const year = Number(match[1]);
        const month = Number(match[2]);
        const day = Number(match[3]);
        const check = new Date(Date.UTC(year, month - 1, day));
        return check.getUTCFullYear() === year && check.getUTCMonth() + 1 === month && check.getUTCDate() === day;
    }

    function stableFingerprint(record) {
        const amount = integerCents(record.amount);
        return [text(record.account || record.payment_method), text(record.date), amount, normalizeDescription(record.description)].join('|');
    }

    function sourceKey(record, source, index) {
        const explicit = text(record.sourceIdentity || record.sourceId || record.transaction_id || record.transactionId);
        return `${text(source || record.source || 'unknown')}:${explicit || stableFingerprint(record) + ':' + index}`;
    }

    function normalizeCandidate(record, source, index, batchId) {
        const candidate = { ...clone(record) };
        // Provider-only metadata is consumed by the protected backend while
        // constructing sourceOriginal and must never become a review field.
        delete candidate.providerSignedAmount;
        candidate.source = text(source || candidate.source || 'manual-csv') || 'manual-csv';
        candidate.sourceIdentity = sourceKey(candidate, candidate.source, index);
        candidate.sourceRevision = text(candidate.sourceRevision || candidate.revision || '1') || '1';
        candidate.date = text(candidate.date);
        candidate.description = text(candidate.description);
        candidate.account = text(candidate.account || candidate.payment_method);
        candidate.payment_method = text(candidate.payment_method || candidate.account);
        candidate.amount = integerCents(candidate.amount) / 100;
        candidate.category = text(candidate.category) || 'Uncategorized';
        candidate.merchant = text(candidate.merchant || candidate.description);
        candidate.type = candidate.type === 'income' ? 'income' : 'expense';
        normalizeCheckingIncomeAmount(candidate);
        if (!strictDate(candidate.date)) throw new Error('Candidate date must be a real YYYY-MM-DD date.');
        if (!candidate.description) throw new Error('Candidate description is required.');
        if (!candidate.account) throw new Error('Candidate account is required.');
        candidate.fingerprint = stableFingerprint(candidate);
        candidate.batchId = text(batchId || candidate.batchId || 'batch-unknown');
        candidate.id = `${candidate.sourceIdentity}@${candidate.sourceRevision}`;
        return candidate;
    }

    function normalizeEditedCandidate(current, patch) {
        const source = current || {};
        const changes = clone(patch || {});
        const next = { ...source, ...changes };
        const originalAmount = Number(source.sourceOriginal && source.sourceOriginal.amount);
        const currentAmount = Number(source.amount);
        const requestedAmount = Number(next.amount);
        const typeToggle = source.type === 'income' && next.type === 'expense' && checkingAccount(source)
            && Number.isFinite(originalAmount) && originalAmount < 0
            && Number.isFinite(currentAmount) && currentAmount === Math.abs(originalAmount)
            && Number.isFinite(requestedAmount) && requestedAmount === currentAmount;
        if (typeToggle) next.amount = originalAmount;
        return normalizeCandidate(next, next.source, 0, next.batchId);
    }

    const ACCEPTED_HISTORY_DATE_COMPATIBILITY_VERSION = 1;

    function hasAcceptedHistoryDateCompatibility(snapshot) {
        const marker = snapshot && snapshot.metadata && snapshot.metadata.acceptedHistoryDateCompatibility;
        return marker !== undefined && marker !== null && typeof marker === 'object' && !Array.isArray(marker) && marker.version === ACCEPTED_HISTORY_DATE_COMPATIBILITY_VERSION;
    }

    function validateSnapshot(snapshot, options) {
        const opts = options || {};
        const allowOpaqueAcceptedHistoryDates = opts.allowOpaqueAcceptedHistoryDates === true;
        if (!snapshot || typeof snapshot !== 'object' || snapshot.schemaVersion !== VERSION) throw new Error('Unsupported backup schema version.');
        if (!Array.isArray(snapshot.transactions) || !Array.isArray(snapshot.categories)) throw new Error('Backup transactions and categories must be arrays.');
        if (snapshot.metadata !== undefined && (!snapshot.metadata || typeof snapshot.metadata !== 'object' || Array.isArray(snapshot.metadata))) throw new Error('Backup metadata is invalid.');
        if (snapshot.metadata && Object.prototype.hasOwnProperty.call(snapshot.metadata, 'acceptedHistoryDateCompatibility') && !hasAcceptedHistoryDateCompatibility(snapshot)) throw new Error('Backup accepted history compatibility marker is invalid.');
        snapshot.transactions.forEach((transaction, index) => {
            const dateIsValid = transaction && typeof transaction.date === 'string' && (strictDate(transaction.date) || allowOpaqueAcceptedHistoryDates);
            if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction) || !dateIsValid || !text(transaction.description) || !text(transaction.category)) throw new Error(`Backup transaction ${index + 1} is invalid.`);
            try { integerCents(transaction.amount); } catch (_) { throw new Error(`Backup transaction ${index + 1} amount is invalid.`); }
            if (transaction.account !== undefined && typeof transaction.account !== 'string') throw new Error(`Backup transaction ${index + 1} account is invalid.`);
            if (transaction.payment_method !== undefined && typeof transaction.payment_method !== 'string') throw new Error(`Backup transaction ${index + 1} payment method is invalid.`);
        });
        snapshot.categories.forEach((category, index) => {
            if (!category || typeof category !== 'object' || Array.isArray(category) || !text(category.name) || (category.type !== undefined && category.type !== 'income' && category.type !== 'expense')) throw new Error(`Backup category ${index + 1} is invalid.`);
            if (category.color !== undefined && (typeof category.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(category.color))) throw new Error(`Backup category ${index + 1} color is invalid.`);
        });
        for (const field of ['budgets', 'merchantDefaults', 'categoryColors']) {
            if (snapshot[field] !== undefined && (!snapshot[field] || typeof snapshot[field] !== 'object' || Array.isArray(snapshot[field]))) throw new Error(`Backup field ${field} is invalid.`);
        }
        if (!('budgets' in snapshot) || !('merchantDefaults' in snapshot)) throw new Error('Backup is missing required settings.');
        Object.entries(snapshot.budgets).forEach(([category, months]) => {
            if (!text(category) || !months || typeof months !== 'object' || Array.isArray(months)) throw new Error('Backup budgets are invalid.');
            Object.entries(months).forEach(([month, value]) => {
                if (!/^\d{4}-\d{2}$/.test(month) || typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Backup budgets are invalid.');
            });
        });
        Object.entries(snapshot.categoryColors || {}).forEach(([category, color]) => {
            if (!text(category) || typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) throw new Error('Backup category colors are invalid.');
        });
        if (snapshot.categoryGroups !== undefined && !Array.isArray(snapshot.categoryGroups)) throw new Error('Backup categoryGroups is invalid.');
        if (snapshot.categoryOrder !== undefined && !Array.isArray(snapshot.categoryOrder)) throw new Error('Backup categoryOrder is invalid.');
        if ((snapshot.categoryGroups || []).some(value => typeof value !== 'string') || (snapshot.categoryOrder || []).some(value => typeof value !== 'string')) throw new Error('Backup category ordering is invalid.');
        if (snapshot.review) validateReviewSnapshot(snapshot.review);
        const containsCredentialKey = value => {
            if (!value || typeof value !== 'object') return false;
            if (Array.isArray(value)) return value.some(containsCredentialKey);
            return Object.entries(value).some(([key, child]) => /credential|token|secret|password|accesskey/i.test(key) || containsCredentialKey(child));
        };
        for (const field of ['transactions', 'categories', 'budgets', 'merchantDefaults', 'categoryGroups', 'categoryColors', 'categoryOrder', 'metadata', 'review']) {
            if (containsCredentialKey(snapshot[field])) throw new Error('Backups must not contain credentials or provider tokens.');
        }
        if (snapshot.credentials || snapshot.providerTokens || snapshot.accessTokens) throw new Error('Backups must not contain credentials or provider tokens.');
        return true;
    }

    function createBackup(state, metadata, options) {
        const source = state || {};
        const opts = options || {};
        const backup = {
            schemaVersion: VERSION,
            exportedAt: new Date().toISOString(),
            metadata: clone(metadata || {}),
            transactions: clone(source.transactions || []),
            categories: clone(source.categories || []),
            budgets: clone(source.budgets || {}),
            merchantDefaults: clone(source.merchantDefaults || {}),
            categoryGroups: clone(source.categoryGroups || []),
            categoryColors: clone(source.categoryColors || {}),
            categoryOrder: clone(source.categoryOrder || [])
        };
        if (source.review) backup.review = clone(source.review);
        const containsOpaqueDate = backup.transactions.some(transaction => transaction && typeof transaction.date === 'string' && !strictDate(transaction.date));
        if (containsOpaqueDate && opts.acceptedHistory !== true) throw new Error('Backup contains opaque dates and must be exported from accepted history.');
        if (containsOpaqueDate) backup.metadata.acceptedHistoryDateCompatibility = { version: ACCEPTED_HISTORY_DATE_COMPATIBILITY_VERSION };
        validateSnapshot(backup, { allowOpaqueAcceptedHistoryDates: containsOpaqueDate });
        return backup;
    }

    function migrateLegacyBackup(snapshot) {
        const source = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : null;
        if (!source || source.schemaVersion !== undefined) throw new Error('Backup is not a legacy four-field backup.');
        if (Object.keys(source).some(key => /credential|token|secret|password|accesskey/i.test(key))) throw new Error('Legacy backups must not contain credentials or provider tokens.');
        if (!Array.isArray(source.transactions) || !Array.isArray(source.categories) || !source.budgets || typeof source.budgets !== 'object' || Array.isArray(source.budgets) || !source.merchantDefaults || typeof source.merchantDefaults !== 'object' || Array.isArray(source.merchantDefaults)) {
            throw new Error('Legacy backup must contain transactions, categories, budgets and merchantDefaults.');
        }
        const migrated = {
            schemaVersion: VERSION,
            exportedAt: new Date().toISOString(),
            transactions: clone(source.transactions),
            categories: clone(source.categories),
            budgets: clone(source.budgets),
            merchantDefaults: clone(source.merchantDefaults),
            categoryGroups: [],
            categoryColors: {},
            categoryOrder: [],
            metadata: { legacySchemaVersion: 0, migratedFrom: 'legacy-four-field-backup', acceptedHistoryDateCompatibility: { version: ACCEPTED_HISTORY_DATE_COMPATIBILITY_VERSION } }
        };
        validateSnapshot(migrated, { allowOpaqueAcceptedHistoryDates: true });
        return migrated;
    }

    function restoreBackup(snapshot, options) {
        const candidate = snapshot && snapshot.schemaVersion === undefined ? migrateLegacyBackup(snapshot) : snapshot;
        const acceptedHistoryDateCompatibility = hasAcceptedHistoryDateCompatibility(candidate);
        validateSnapshot(candidate, { allowOpaqueAcceptedHistoryDates: acceptedHistoryDateCompatibility });
        if (options && options.requireApproval && options.approved !== true) throw new Error('Restore requires explicit approval.');
        return {
            transactions: clone(candidate.transactions),
            categories: clone(candidate.categories),
            budgets: clone(candidate.budgets),
            merchantDefaults: clone(candidate.merchantDefaults),
            categoryGroups: clone(candidate.categoryGroups || []),
            categoryColors: clone(candidate.categoryColors || {}),
            categoryOrder: clone(candidate.categoryOrder || []),
            ...(candidate.review ? { review: clone(candidate.review) } : {}),
            ...(candidate.metadata && candidate.metadata.legacySchemaVersion !== undefined ? { migration: clone(candidate.metadata) } : {}),
            ...(acceptedHistoryDateCompatibility ? { acceptedHistoryDateCompatibility: true } : {})
        };
    }

    function validateReviewSnapshot(snapshot) {
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('Backup review state is invalid.');
        if (snapshot.schemaVersion !== VERSION) throw new Error('Unsupported review backup schema version.');
        for (const field of ['pending', 'rejected', 'accepted', 'audit', 'receipts', 'batchMeta']) {
            if (snapshot[field] !== undefined && !Array.isArray(snapshot[field])) throw new Error(`Backup review field ${field} is invalid.`);
        }
        const validateCandidate = (candidate, allowedStates, label) => {
            if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error(`Backup review ${label} candidate is invalid.`);
            if (!text(candidate.id) || !text(candidate.sourceIdentity) || !text(candidate.sourceRevision) || candidate.id !== `${candidate.sourceIdentity}@${candidate.sourceRevision}`) throw new Error(`Backup review ${label} candidate identity is invalid.`);
            if (!allowedStates.includes(candidate.status)) throw new Error(`Backup review ${label} candidate status is invalid.`);
            if (!Number.isSafeInteger(candidate.revision) || candidate.revision < 1 || !Number.isSafeInteger(candidate.reviewedRevision) || candidate.reviewedRevision < 1) throw new Error(`Backup review ${label} candidate revision is invalid.`);
            if (!strictDate(candidate.date) || !text(candidate.description) || !text(candidate.account)) throw new Error(`Backup review ${label} candidate fields are invalid.`);
            if (stableFingerprint(candidate) !== candidate.fingerprint) throw new Error(`Backup review ${label} candidate fingerprint is invalid.`);
        };
        (snapshot.pending || []).forEach(candidate => validateCandidate(candidate, [STATES.PENDING, STATES.DEFERRED], 'pending'));
        (snapshot.rejected || []).forEach(candidate => validateCandidate(candidate, [STATES.REJECTED, 'superseded'], 'rejected'));
        (snapshot.accepted || []).forEach(candidate => validateCandidate(candidate, [STATES.APPROVED], 'accepted'));
        const acceptedById = new Map((snapshot.accepted || []).map(candidate => [candidate.id, candidate]));
        (snapshot.receipts || []).forEach(record => {
            if (!record || !text(record.idempotencyKey) || !Array.isArray(record.accepted) || !Array.isArray(record.receipts) || record.receipts.length !== 1) throw new Error('Backup review receipt is invalid.');
            const receipt = record.receipts[0];
            if (!receipt || receipt.idempotencyKey !== record.idempotencyKey || !Array.isArray(receipt.candidateIds) || !Array.isArray(receipt.revisions) || receipt.candidateIds.length !== receipt.revisions.length || !text(receipt.actor)) throw new Error('Backup review receipt binding is invalid.');
            const acceptedIds = record.accepted.map(candidate => candidate.id).sort().join(',');
            const receiptIds = receipt.candidateIds.slice().sort().join(',');
            if (acceptedIds !== receiptIds || record.accepted.some(candidate => candidate.status !== STATES.APPROVED || receipt.revisions[receipt.candidateIds.indexOf(candidate.id)] !== candidate.revision)) throw new Error('Backup review receipt candidates are not bound to the receipt.');
            record.accepted.forEach(candidate => {
                validateCandidate(candidate, [STATES.APPROVED], 'receipt');
                const stored = acceptedById.get(candidate.id);
                if (!stored || stored.revision !== candidate.revision || stored.sourceRevision !== candidate.sourceRevision) throw new Error('Backup review receipt is not bound to accepted state.');
            });
        });
        (snapshot.batchMeta || []).forEach(entry => {
            if (!Array.isArray(entry) || entry.length !== 2 || !text(entry[0]) || !entry[1] || typeof entry[1] !== 'object' || Array.isArray(entry[1])) throw new Error('Backup review batch metadata is invalid.');
        });
        return true;
    }

    class ReviewStore {
        constructor(options) {
            this.options = options || {};
            this.pending = new Map();
            this.rejected = new Map();
            this.accepted = new Map();
            this.audit = [];
            this.receipts = new Map();
            this.overlaps = new Map();
            this.batchMeta = new Map();
            this.inFlight = new Set();
            this.candidateLocks = new Map();
        }

        assertUnlocked(id) {
            if (this.candidateLocks.has(id)) throw new Error(`Candidate ${id} is locked by an approval in progress.`);
        }

        stage(records, options) {
            const opts = options || {};
            const source = opts.source || 'manual-csv';
            const batchId = opts.batchId || `${source}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const staged = [];
            const seenInBatch = new Set();
            records.forEach((record, index) => {
                const candidate = normalizeCandidate(record, source, index, batchId);
                if (seenInBatch.has(candidate.id)) return;
                seenInBatch.add(candidate.id);
                for (const [priorId, priorCandidate] of this.pending.entries()) {
                    if (priorCandidate.sourceIdentity === candidate.sourceIdentity && priorCandidate.sourceRevision !== candidate.sourceRevision) {
                        this.assertUnlocked(priorId);
                        this.pending.delete(priorId);
                        this.rejected.set(priorId, { ...priorCandidate, status: 'superseded', supersededBy: candidate.id, supersededAt: new Date().toISOString() });
                        this.audit.push({ action: 'supersede', id: priorId, supersededBy: candidate.id, at: new Date().toISOString() });
                    }
                }
                if (this.accepted.has(candidate.id)) return;
                const prior = this.pending.get(candidate.id);
                if (prior && prior.sourceRevision === candidate.sourceRevision) return;
                const rejected = this.rejected.get(candidate.id);
                if (rejected && rejected.sourceRevision === candidate.sourceRevision && opts.reconsider !== true) return;
                candidate.status = STATES.PENDING;
                candidate.revision = (prior ? prior.revision : 0) + 1;
                candidate.reviewedRevision = candidate.revision;
                this.pending.set(candidate.id, candidate);
                staged.push(clone(candidate));
            });
            this.recomputeOverlaps();
            staged.forEach(candidate => {
                const refreshed = this.pending.get(candidate.id);
                if (refreshed) Object.assign(candidate, clone(refreshed));
            });
            this.batchMeta.set(batchId, { ...clone(opts.batchMeta || {}), ids: staged.map(item => item.id) });
            this.audit.push({ action: 'stage', batchId, source, count: staged.length, at: new Date().toISOString() });
            return staged;
        }

        findOverlap(candidate) {
            return overlapDetailsFor(candidate, [...this.pending.values(), ...this.accepted.values()]).map(detail => detail.id);
        }

        findOverlapDetails(candidate) {
            return overlapDetailsFor(candidate, [...this.pending.entries(), ...this.accepted.entries()]);
        }

        recomputeOverlaps() {
            this.overlaps.clear();
            for (const [id, candidate] of this.pending.entries()) {
                const details = this.findOverlapDetails(candidate);
                candidate.overlap = details.map(detail => detail.id);
                candidate.overlapDetails = details;
                if (candidate.overlap.length) this.overlaps.set(id, candidate.overlap.slice());
            }
        }

        list(options) {
            const opts = options || {};
            return [...this.pending.values()].filter(item => !opts.batchId || item.batchId === opts.batchId).map(clone);
        }

        get(id) { return clone(this.pending.get(id) || this.accepted.get(id) || this.rejected.get(id)); }

        edit(id, patch, expectedRevision) {
            this.assertUnlocked(id);
            const current = this.pending.get(id);
            if (!current) throw new Error('Candidate is no longer pending.');
            if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new Error('Candidate changed since it was loaded.');
            const next = { ...current, ...clone(patch) };
            const normalized = normalizeEditedCandidate(current, patch);
            restoreProviderTrackingFields(current, normalized);
            if (Object.prototype.hasOwnProperty.call(current, 'sourceOriginal')) normalized.sourceOriginal = clone(current.sourceOriginal);
            else delete normalized.sourceOriginal;
            normalized.sourceIdentity = current.sourceIdentity;
            normalized.id = current.id;
            normalized.sourceRevision = current.sourceRevision;
            normalized.revision = current.revision + 1;
            normalized.reviewedRevision = normalized.revision;
            normalized.status = STATES.PENDING;
            this.pending.set(id, normalized);
            this.recomputeOverlaps();
            this.audit.push({ action: 'edit', id, revision: normalized.revision, at: new Date().toISOString() });
            return clone(this.pending.get(id));
        }

        split(id, parts) {
            this.assertUnlocked(id);
            const current = this.pending.get(id);
            if (!current) throw new Error('Candidate is no longer pending.');
            if (!Array.isArray(parts) || parts.length < 2) throw new Error('A split requires at least two parts.');
            const sourceCents = integerCents(current.amount);
            const sign = sourceCents < 0 ? -1 : 1;
            const partCents = parts.map(part => {
                const cents = integerCents(part && part.amount);
                if (cents <= 0 || !text(part && part.category)) throw new Error('Split parts require positive amounts and categories.');
                return cents;
            });
            if (partCents.reduce((sum, cents) => sum + cents, 0) !== Math.abs(sourceCents)) throw new Error('Split parts must conserve the signed transaction amount.');
            this.pending.delete(id);
            const created = partCents.map((cents, index) => {
                const part = parts[index];
                const candidate = normalizeCandidate({ ...current, amount: sign * cents / 100, category: text(part.category), description: text(part.description) || `${current.description} (split ${index + 1})`, sourceIdentity: `${current.sourceIdentity}/split/${index + 1}`, sourceRevision: `${current.sourceRevision}.${index + 1}`, parentSourceIdentity: current.sourceIdentity, parentSourceRevision: current.sourceRevision }, current.source, index, current.batchId);
                candidate.parentSourceIdentity = current.sourceIdentity;
                candidate.parentSourceRevision = current.sourceRevision;
                candidate.status = STATES.PENDING;
                candidate.revision = 1;
                candidate.reviewedRevision = 1;
                this.pending.set(candidate.id, candidate);
                return candidate;
            });
            this.recomputeOverlaps();
            created.forEach(candidate => Object.assign(candidate, clone(this.pending.get(candidate.id))));
            for (const [batchId, metadata] of this.batchMeta.entries()) {
                if (metadata && Array.isArray(metadata.ids) && metadata.ids.includes(id)) this.batchMeta.set(batchId, { ...metadata, ids: metadata.ids.flatMap(value => value === id ? created.map(item => item.id) : [value]) });
            }
            this.audit.push({ action: 'split', id, parts: created.map(item => item.id), at: new Date().toISOString() });
            return created.map(clone);
        }

        reject(id, actor) {
            this.assertUnlocked(id);
            const current = this.pending.get(id);
            if (!current) throw new Error('Candidate is no longer pending.');
            const rejected = { ...current, status: STATES.REJECTED, rejectedBy: text(actor) || 'local-reviewer', rejectedAt: new Date().toISOString() };
            this.pending.delete(id);
            this.rejected.set(id, rejected);
            this.audit.push({ action: 'reject', id, actor: rejected.rejectedBy, revision: current.revision, at: rejected.rejectedAt });
            return clone(rejected);
        }

        defer(id, actor) {
            this.assertUnlocked(id);
            const current = this.pending.get(id);
            if (!current) throw new Error('Candidate is no longer pending.');
            current.status = STATES.DEFERRED;
            current.deferredBy = text(actor) || 'local-reviewer';
            current.deferredAt = new Date().toISOString();
            this.pending.set(id, current);
            this.audit.push({ action: 'defer', id, actor: current.deferredBy, revision: current.revision, at: current.deferredAt });
            return clone(current);
        }

        cancel() {
            if (this.candidateLocks.size) throw new Error('An approval is in progress; try again after it finishes.');
            const count = this.pending.size;
            this.pending.clear();
            this.audit.push({ action: 'cancel', count, at: new Date().toISOString() });
            return count;
        }

        clear() {
            this.pending.clear();
            this.rejected.clear();
            this.accepted.clear();
            this.receipts.clear();
            this.overlaps.clear();
            this.batchMeta.clear();
            this.inFlight.clear();
            this.candidateLocks.clear();
            this.audit = [];
        }

        async approveSelected(ids, options) {
            const opts = options || {};
            if (opts.online !== true) throw new Error('Approval requires an online durable service.');
            if (opts.authenticated !== true) throw new Error('Approval requires fresh authentication.');
            if (typeof opts.acknowledge !== 'function') throw new Error('Approval requires durable acknowledgement.');
            const actor = text(opts.actor);
            if (!actor) throw new Error('Approval actor is required.');
            if (typeof opts.authorize !== 'function') throw new Error('Approval requires server authorization.');
            const requestedIds = [...new Set((ids || []).map(id => text(id)).filter(Boolean))];
            const suppliedKey = text(opts.idempotencyKey);
            const existing = suppliedKey ? this.receipts.get(suppliedKey) : null;
            if (existing) {
                const existingIds = existing.receipts[0].candidateIds.slice().sort().join(',');
                if (existingIds !== requestedIds.slice().sort().join(',')) throw new Error('Idempotency key is already bound to a different candidate selection.');
                const currentRevisions = requestedIds.map(id => {
                    const current = this.pending.get(id) || this.accepted.get(id) || this.rejected.get(id);
                    return current && current.revision;
                });
                if (currentRevisions.every(Number.isSafeInteger) && currentRevisions.some((value, index) => value !== existing.receipts[0].revisions[index])) throw new Error('Idempotency key is bound to a different candidate revision.');
                const authorization = await opts.authorize({ actor, candidateIds: existing.receipts[0].candidateIds.slice(), revisions: existing.receipts[0].revisions.slice(), idempotencyKey: suppliedKey });
                const authorizedActor = typeof authorization === 'string' ? authorization : authorization && authorization.actor;
                if (authorizedActor !== actor) throw new Error('Approval authorization did not bind to the authenticated actor.');
                return clone(existing);
            }
            const selected = requestedIds.map(id => this.pending.get(id)).filter(Boolean);
            if (!selected.length) {
                if (!suppliedKey) {
                    for (const value of this.receipts.values()) {
                        const receipt = value.receipts[0];
                        if (receipt.candidateIds.slice().sort().join(',') === requestedIds.slice().sort().join(',')) {
                            const authorization = await opts.authorize({ actor, candidateIds: receipt.candidateIds.slice(), revisions: receipt.revisions.slice(), idempotencyKey: receipt.idempotencyKey });
                            const authorizedActor = typeof authorization === 'string' ? authorization : authorization && authorization.actor;
                            if (authorizedActor !== actor) throw new Error('Approval authorization did not bind to the authenticated actor.');
                            return clone(value);
                        }
                    }
                }
                return { accepted: [], receipts: [] };
            }
            this.recomputeOverlaps();
            const selectedIds = new Set(selected.map(item => item.id));
            for (const candidate of selected) {
                if (candidate.status === STATES.REJECTED) throw new Error('Rejected candidates cannot be approved.');
                if (candidate.providerPending === true || candidate.pending === true) throw new Error(`Provider pending observation ${candidate.id} must post before approval.`);
                if (candidate.reviewedRevision !== candidate.revision) throw new Error(`Candidate ${candidate.id} changed after review.`);
                if (candidate.overlap && candidate.overlap.some(id => this.accepted.has(id) || selectedIds.has(id)) && opts.allowOverlap !== true) throw new Error(`Possible duplicate requires review: ${candidate.id}`);
            }
            const key = suppliedKey || selected.map(item => `${item.id}:${item.revision}`).sort().join(',');
            if (this.receipts.has(key)) return clone(this.receipts.get(key));
            if (this.inFlight.has(key)) throw new Error('Approval is already in progress.');
            for (const candidate of selected) {
                if (this.candidateLocks.has(candidate.id)) throw new Error(`Candidate ${candidate.id} is locked by an approval in progress.`);
            }
            const receipt = { idempotencyKey: key, actor, approvedAt: new Date().toISOString(), candidateIds: selected.map(item => item.id), revisions: selected.map(item => item.revision) };
            const payload = selected.map(item => ({ ...clone(item), status: STATES.APPROVED, approvedBy: actor, approvedAt: receipt.approvedAt }));
            this.inFlight.add(key);
            selected.forEach(candidate => this.candidateLocks.set(candidate.id, key));
            try {
                const authorization = await opts.authorize({ actor, candidateIds: receipt.candidateIds.slice(), revisions: receipt.revisions.slice(), idempotencyKey: key });
                const authorizedActor = typeof authorization === 'string' ? authorization : authorization && authorization.actor;
                if (authorizedActor !== actor) throw new Error('Approval authorization did not bind to the authenticated actor.');
                const ack = await opts.acknowledge(clone(payload), clone(receipt), { candidateIds: receipt.candidateIds.slice(), revisions: receipt.revisions.slice(), idempotencyKey: key, allowOverlap: opts.allowOverlap === true });
                if (ack !== true) throw new Error('Durable approval acknowledgement failed.');
                selected.forEach(candidate => {
                    const current = this.pending.get(candidate.id);
                    if (current !== candidate || current.revision !== candidate.revision) throw new Error(`Candidate ${candidate.id} changed during approval.`);
                });
                const acceptedPayload = payload.map(item => {
                    const accepted = { ...item };
                    delete accepted.overlap;
                    delete accepted.overlapDetails;
                    return accepted;
                });
                acceptedPayload.forEach(item => {
                    this.pending.delete(item.id);
                    if (item.amendment === 'modified' || item.amendment === 'removed') {
                        for (const [acceptedId, accepted] of this.accepted.entries()) {
                            if (accepted.sourceIdentity === item.sourceIdentity || accepted.parentSourceIdentity === item.sourceIdentity) this.accepted.delete(acceptedId);
                        }
                    }
                    // Keep an approved amendment tombstone in the review
                    // receipt map so reloads can validate its durable receipt;
                    // the canonical accepted state omits removed rows.
                    this.accepted.set(item.id, item);
                });
                this.receipts.set(key, { accepted: clone(acceptedPayload), receipts: [clone(receipt)] });
                this.audit.push({ action: 'approve', actor, candidateIds: receipt.candidateIds, revisions: receipt.revisions, at: receipt.approvedAt });
                return { accepted: clone(acceptedPayload), receipts: [clone(receipt)] };
            } finally {
                this.inFlight.delete(key);
                selected.forEach(candidate => {
                    if (this.candidateLocks.get(candidate.id) === key) this.candidateLocks.delete(candidate.id);
                });
            }
        }

        exportReview() {
            return {
                schemaVersion: VERSION,
                pending: this.list(),
                rejected: [...this.rejected.values()].map(clone),
                accepted: [...this.accepted.values()].map(clone),
                audit: clone(this.audit),
                receipts: [...this.receipts.entries()].map(([idempotencyKey, value]) => ({ idempotencyKey, ...clone(value) })),
                batchMeta: [...this.batchMeta.entries()].map(([batchId, value]) => [batchId, clone(value)])
            };
        }

        restoreReview(snapshot) {
            validateReviewSnapshot(snapshot);
            const pending = new Map((snapshot.pending || []).map(candidate => {
                const normalized = normalizePendingCandidate(candidate);
                return [normalized.id, normalized];
            }));
            const rejected = new Map((snapshot.rejected || []).map(candidate => [candidate.id, clone(candidate)]));
            const accepted = new Map((snapshot.accepted || []).map(candidate => [candidate.id, clone(candidate)]));
            const receipts = new Map((snapshot.receipts || []).map(record => [record.idempotencyKey, { accepted: clone(record.accepted), receipts: clone(record.receipts) }]));
            this.pending = pending;
            this.rejected = rejected;
            this.accepted = accepted;
            this.receipts = receipts;
            this.audit = clone(snapshot.audit || []);
            this.batchMeta = new Map((snapshot.batchMeta || []).map(([batchId, value]) => [batchId, clone(value)]));
            this.recomputeOverlaps();
            this.inFlight.clear();
            this.candidateLocks.clear();
            return this.exportReview();
        }

        listBatchMeta() {
            return [...this.batchMeta.entries()].map(([batchId, value]) => [batchId, clone(value)]);
        }
    }

    class InMemorySyncRepository {
        constructor(options) {
            const opts = options || {};
            this.candidates = new Map();
            this.cursor = null;
            this.cursorByConnection = new Map();
            this.completeRuns = new Set();
            this.leases = new Map();
            this.cooldownMs = Number.isFinite(opts.cooldownMs) && opts.cooldownMs >= 0 ? opts.cooldownMs : 4 * 60 * 60 * 1000;
            this.cooldownUntil = new Map();
            this.runs = new Map();
        }
        acquireLease(connectionKey, runId, options) {
            const key = text(connectionKey);
            const id = text(runId);
            const opts = options || {};
            const now = Number.isFinite(opts.now) ? opts.now : Date.now();
            const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : 60_000;
            if (!key || !id) throw new Error('Sync lease requires a connection key and run ID.');
            if (this.runs.has(id)) throw new Error('Sync run ID has already been used.');
            const current = this.leases.get(key);
            if (current && current.expiresAt > now) throw new Error('A sync run is already in progress for this connection.');
            if ((this.cooldownUntil.get(key) || 0) > now) throw new Error('Sync is inside its cooldown window.');
            const cursor = this.getCursor(key);
            const lease = { connectionKey: key, runId: id, acquiredAt: now, expiresAt: now + ttlMs, originalCursor: cursor && cursor.cursor || null };
            this.leases.set(key, lease);
            this.runs.set(id, { runId: id, connectionKey: key, originalCursor: lease.originalCursor, complete: false, records: [] });
            return clone(lease);
        }
        releaseLease(connectionKey, runId) {
            const key = text(connectionKey);
            const current = this.leases.get(key);
            if (!current || current.runId !== text(runId)) throw new Error('Sync lease is missing or owned by another run.');
            this.leases.delete(key);
            return true;
        }
        stagePage(runId, records) {
            if (!runId) throw new Error('Sync run ID is required.');
            if (this.completeRuns.has(runId)) throw new Error('Completed sync runs cannot accept more pages.');
            const run = this.runs.get(runId);
            if (run) for (const record of records || []) if (record && record.id) run.records.push(clone(record));
            for (const record of records || []) this.candidates.set(record.id, clone(record));
            return { runId, staged: (records || []).length };
        }
        publishCursor(runId, cursor, expectedIds, connectionKey, options) {
            if (!runId || !cursor) throw new Error('Sync cursor publication requires a run ID and cursor.');
            const key = text(connectionKey) || 'default';
            const now = options && Number.isFinite(options.now) ? options.now : Date.now();
            const strictLease = options && Number.isFinite(options.now);
            const lease = this.leases.get(key);
            const run = this.runs.get(text(runId));
            if (this.completeRuns.has(runId)) {
                const existing = this.getCursor(key);
                if (!existing || existing.runId !== runId || existing.cursor !== text(cursor)) throw new Error('Sync run is already complete with a different cursor.');
                return clone(existing);
            }
            for (const id of expectedIds || []) if (!this.candidates.has(id)) throw new Error('Cannot publish cursor before all candidates are staged.');
            if (strictLease && (!lease || lease.runId !== text(runId) || lease.expiresAt <= now)) throw new Error('Sync lease is missing or expired.');
            if (strictLease && (!run || run.connectionKey !== key || run.originalCursor !== ((this.getCursor(key) || {}).cursor || null))) throw new Error('Sync cursor is stale and cannot advance.');
            this.cursorByConnection = this.cursorByConnection || new Map();
            const published = { connectionKey: key, runId, cursor: text(cursor), publishedAt: new Date().toISOString() };
            this.cursor = published;
            this.cursorByConnection.set(key, published);
            this.completeRuns.add(runId);
            run.complete = true;
            this.cooldownUntil.set(key, now + this.cooldownMs);
            return clone(this.cursor);
        }
        getCursor(connectionKey) {
            const key = text(connectionKey);
            if (key && this.cursorByConnection && this.cursorByConnection.has(key)) return clone(this.cursorByConnection.get(key));
            return clone(this.cursor);
        }
        listCandidates() { return [...this.candidates.values()].map(clone); }
    }

    class SyncCoordinator {
        constructor(options) {
            const opts = options || {};
            this.cooldownMs = Number.isFinite(opts.cooldownMs) && opts.cooldownMs >= 0 ? opts.cooldownMs : 4 * 60 * 60 * 1000;
            this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
            this.active = null;
            this.lastSuccessAt = null;
        }

        status() {
            const now = this.now();
            if (this.active) return { state: 'in-progress', runId: this.active.runId, startedAt: this.active.startedAt };
            if (this.lastSuccessAt !== null && now - this.lastSuccessAt < this.cooldownMs) return { state: 'cooldown', retryAt: this.lastSuccessAt + this.cooldownMs };
            return { state: 'eligible' };
        }

        begin(runId) {
            const id = text(runId);
            if (!id) throw new Error('Sync run ID is required.');
            const current = this.status();
            if (current.state === 'in-progress') throw new Error('A sync run is already in progress.');
            if (current.state === 'cooldown') throw new Error('Sync is inside its cooldown window.');
            this.active = { runId: id, startedAt: this.now() };
            return clone(this.active);
        }

        finish(runId, success) {
            if (!this.active || this.active.runId !== text(runId)) throw new Error('Sync run is missing or owned by another run.');
            if (success === true) this.lastSuccessAt = this.now();
            this.active = null;
            return this.status();
        }
    }

    class DisabledProviderAdapter {
        constructor(reason) { this.reason = reason || 'Provider is not configured.'; }
        async fetchDelta() { throw new Error(this.reason); }
    }

    const api = Object.freeze({ VERSION, STATES, CHECKING_ACCOUNT_ALIAS, normalizeCandidate, normalizePendingCandidate, normalizeEditedCandidate, hasCheckingIncomeCategory, stableFingerprint, possibleOverlapDetails, overlapDetailsFor, ReviewStore, InMemorySyncRepository, SyncCoordinator, DisabledProviderAdapter, createBackup, validateSnapshot, validateReviewSnapshot, restoreBackup, migrateLegacyBackup });
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.TransactionReview = api;
})(typeof globalThis === 'undefined' ? this : globalThis);

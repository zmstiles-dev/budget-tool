/*
 * Credential-free protected backend contract for local and synthetic testing.
 *
 * This module is deliberately independent of Firebase and bank providers. In
 * production the same authorization, pending-inbox and atomic approval
 * contract must be implemented by the Firebase-adjacent service. Browser code
 * must never replace this boundary with a caller-supplied email or payload.
 */
(function (root) {
    'use strict';

    const review = typeof module !== 'undefined' && module.exports ? require('./transaction-review.js') : root.TransactionReview;
    if (!review) throw new Error('TransactionReview is required before TransactionBackend.');
    const EXISTING_ALLOWED_USERS = Object.freeze(['captainicebow@gmail.com', 'mgstiles13@gmail.com', 'zmstiles@gmail.com']);
    const SAFE_DIAGNOSTIC_STAGES = new Set(['setup', 'sync', 'backend', 'browser', 'approval', 'reload']);
    const SAFE_DIAGNOSTIC_TYPES = new Set(['API_ERROR', 'INSTITUTION_ERROR', 'ITEM_ERROR', 'INVALID_REQUEST', 'INVALID_INPUT', 'RATE_LIMIT_EXCEEDED', 'SANDBOX_ERROR']);
    const SAFE_DIAGNOSTIC_CODES = new Set([
        'ACCESS_NOT_GRANTED', 'BAD_REQUEST', 'INSTITUTION_DOWN', 'INSTITUTION_NOT_FOUND',
        'INSTITUTION_NOT_SUPPORTED', 'INTERNAL_SERVER_ERROR', 'INVALID_ACCESS_TOKEN',
        'INVALID_API_KEYS', 'INVALID_FIELD', 'INVALID_INPUT', 'INVALID_INSTITUTION',
        'INVALID_PRODUCT', 'INVALID_PUBLIC_TOKEN', 'ITEM_LOCKED', 'ITEM_LOGIN_REQUIRED',
        'ITEM_NOT_FOUND', 'MISSING_FIELDS', 'PRODUCT_NOT_READY', 'RATE_LIMIT_EXCEEDED',
        'SANDBOX_PRODUCT_NOT_ENABLED', 'UNAUTHORIZED_ENVIRONMENT', 'UNAUTHORIZED_ROUTE_ACCESS',
        'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION', 'INITIAL_SYNC_PENDING', 'SYNC_DEADLINE_EXCEEDED', 'ACCOUNT_NOT_MAPPED',
        'MISSING_REVIEWABLE_DATE', 'REMOVED_NOT_HYDRATED', 'UNSUPPORTED_CURRENCY',
        'INVALID_AMOUNT', 'MISSING_TRANSACTION_ID', 'INCOMPLETE_PAGE',
        'INCOMPLETE_SYNC_RESPONSE', 'PROVIDER_ERROR', 'INVALID_OBSERVATION',
        'MISSING_IDENTIFIER', 'INVALID_PENDING', 'INVALID_CATEGORY',
        'INVALID_FINANCE_CATEGORY', 'CURSOR_DID_NOT_ADVANCE', 'PAGE_LIMIT_EXCEEDED',
        'MUTATION_RESTART_LIMIT', 'SYNC_DID_NOT_COMPLETE', 'PROVIDER_REQUEST_FAILED',
        'ACCESS_TOKEN_RESOLVER_REQUIRED', 'INVALID_CUTOVER_DATE', 'ACCOUNT_MAPPING_REQUIRED',
        'BACKEND_REQUEST_FAILED', 'BACKEND_RESPONSE_INVALID_JSON', 'AUTHENTICATION_REQUIRED', 'AUTHORIZATION_FAILED',
        'CORS_ORIGIN_REJECTED', 'INVALID_REQUEST'
    ]);
    const SYNC_DEADLINE_EXCEEDED = 'SYNC_DEADLINE_EXCEEDED';
    const SAFE_RESPONSE_SHAPE_KEYS = Object.freeze(['added', 'modified', 'removed', 'has_more', 'next_cursor']);
    const SAFE_RESPONSE_SHAPE_TYPES = new Set(['missing', 'array', 'boolean', 'string', 'null', 'number', 'object', 'undefined']);

    function sanitizeResponseShape(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const output = {};
        for (const key of SAFE_RESPONSE_SHAPE_KEYS) {
            const field = value[key];
            if (!field || typeof field !== 'object' || Array.isArray(field)) return null;
            const present = field.present === true || field.present === false ? field.present : null;
            const type = text(field.type);
            if (present === null || !SAFE_RESPONSE_SHAPE_TYPES.has(type)) return null;
            const safe = { present, type };
            if (field.count !== undefined) {
                if (!Number.isSafeInteger(field.count) || field.count < 0 || field.count > 1000) return null;
                safe.count = field.count;
            }
            output[key] = Object.freeze(safe);
        }
        return Object.freeze(output);
    }

    function sanitizeDiagnostic(value, fallbackStage, fallbackStatus) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const stage = text(value.stage) || text(fallbackStage);
        if (!SAFE_DIAGNOSTIC_STAGES.has(stage)) return null;
        const diagnostic = { stage };
        const status = Number.isInteger(value.status) ? value.status : fallbackStatus;
        if (Number.isInteger(status) && status >= 100 && status <= 599) diagnostic.status = status;
        const httpStatus = Number.isInteger(value.http_status) ? value.http_status : null;
        if (httpStatus !== null && httpStatus >= 400 && httpStatus <= 599) diagnostic.http_status = httpStatus;
        if (SAFE_DIAGNOSTIC_TYPES.has(text(value.type))) diagnostic.type = text(value.type);
        if (SAFE_DIAGNOSTIC_CODES.has(text(value.code))) diagnostic.code = text(value.code);
        if (typeof value.request_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.request_id)) diagnostic.request_id = value.request_id;
        if (typeof value.source === 'string' && /^tests\/[A-Za-z0-9._-]+\.cjs:\d{1,5}$/.test(value.source)) diagnostic.source = value.source;
        const responseShape = sanitizeResponseShape(value.response_shape);
        if (responseShape) diagnostic.response_shape = responseShape;
        return Object.freeze(diagnostic);
    }

    function safeHttpMessage(error) {
        const message = text(typeof error === 'string' ? error : error && error.message);
        const allowed = new Set([
            'Bearer authentication is required.', 'Firebase Admin authorization is not configured.',
            'Authenticated user is not an approved app user.', 'Authenticated user is not an existing app user.',
            'Authenticated household membership is not configured.', 'User is not a member of this household.',
            'CORS origin is not allowed.', 'Request body is too large.', 'Request body must be valid JSON.',
            'Route not found.', 'Browser staging is limited to CSV observations.',
            'Approval candidates were already rejected or accepted.', 'A durable review transaction failed.',
            'Sync is inside its cooldown window.', 'Sync activation is not ready.',
            'Sync settings are not configured.', 'Sync settings revision is required.',
            'Sync settings changed since they were loaded.', 'Cutoff date must be a real YYYY-MM-DD date.',
            'Cutoff date cannot be in the future.',
            'Cutoff date can only move forward; earlier dates require an explicit backfill operation.',
            'This transaction is still pending with the bank and cannot be added until it posts.',
            'Provider transactions must use an existing budget category.'
        ]);
        if (/^Provider pending observation .+ must post before approval\.$/.test(message)) {
            return 'This transaction is still pending with the bank and cannot be added until it posts.';
        }
        if (allowed.has(message) || /^Possible duplicate requires review: [A-Za-z0-9._:/@-]+$/.test(message) || /^Amendment target changed since review: [A-Za-z0-9._:/@-]+$/.test(message)) return message;
        return 'Approval service request failed.';
    }

    function invalidResponseError(status) {
        const error = new Error('Approval service returned an invalid response.');
        const diagnostic = sanitizeDiagnostic({ stage: 'backend', status, code: 'BACKEND_RESPONSE_INVALID_JSON' }, 'backend', status);
        if (diagnostic) Object.defineProperty(error, 'diagnostic', { value: diagnostic, enumerable: false, configurable: true });
        return error;
    }

    function clone(value) {
        if (value === undefined) return value;
        return JSON.parse(JSON.stringify(value));
    }

    function text(value) {
        return String(value ?? '').trim();
    }

    function initialSyncPendingError() {
        const error = new Error('Plaid sync initial response is empty; retry the same Item.');
        error.code = 'INITIAL_SYNC_PENDING';
        error.error_code = 'INITIAL_SYNC_PENDING';
        return error;
    }

    function idList(values) {
        return [...new Set((values || []).map(value => text(value)).filter(Boolean))];
    }

    function sameList(left, right) {
        return left.slice().sort().join(',') === right.slice().sort().join(',');
    }

    function sameOrdered(left, right) {
        return left.length === right.length && left.every((value, index) => value === right[index]);
    }

    function validMonth(value) {
        return /^\d{4}-(?:0[1-9]|1[0-2])$/.test(text(value));
    }

    function unsafeMapKey(value) {
        const key = text(value);
        return key === '__proto__' || key === 'constructor' || key === 'prototype';
    }

    function normalizeInboundCandidate(record, source, index, batchId) {
        const input = { ...(record || {}) };
        const providerSignedAmount = String(source || '').toLowerCase() === 'bank-provider' && Number.isFinite(Number(input.providerSignedAmount))
            ? Number(input.providerSignedAmount)
            : null;
        delete input.providerSignedAmount;
        const candidate = review.normalizeCandidate(input, source, index, batchId);
        if (providerSignedAmount !== null) Object.defineProperty(candidate, '__providerSignedAmount', { value: providerSignedAmount, enumerable: false, configurable: true });
        if (text(record && record.sourceIdentity) && text(record && record.sourceRevision)) {
            candidate.sourceIdentity = text(record.sourceIdentity);
            candidate.sourceRevision = text(record.sourceRevision);
            candidate.id = `${candidate.sourceIdentity}@${candidate.sourceRevision}`;
            candidate.fingerprint = review.stableFingerprint(candidate);
        }
        return candidate;
    }

    function immutableSource(record) {
        const source = clone(record || {});
        ['status', 'revision', 'reviewedRevision', 'overlap', 'overlapDetails', 'rejectedBy',
            'rejectedAt', 'deferredBy', 'deferredAt', 'supersededBy',
            'supersededAt', 'approvedBy', 'approvedAt', 'sourceOriginal'].forEach(field => {
            delete source[field];
        });
        return source;
    }

    // Browser approval retries may include the candidate body when the stage
    // response was lost. Compare the review fields that affect the accepted
    // row, while ignoring server-owned lifecycle metadata and transport-only
    // fields. The server's pending row remains authoritative after this
    // comparison; the client body is never installed as a replacement.
    function approvalCandidateProjection(record) {
        const source = record || {};
        return {
            id: text(source.id),
            source: text(source.source),
            sourceIdentity: text(source.sourceIdentity),
            sourceRevision: text(source.sourceRevision),
            parentSourceIdentity: text(source.parentSourceIdentity),
            parentSourceRevision: text(source.parentSourceRevision),
            date: text(source.date),
            description: text(source.description),
            amount: source.amount,
            category: text(source.category),
            merchant: text(source.merchant),
            account: text(source.account),
            payment_method: text(source.payment_method),
            type: text(source.type),
            currency: text(source.currency || source.currency_code).toUpperCase(),
            pending: source.pending === true,
            transactionCode: text(source.transactionCode || source.transaction_code),
            amendment: text(source.amendment),
            targetSourceRevision: text(source.targetSourceRevision),
            targetAcceptedDigest: text(source.targetAcceptedDigest)
        };
    }

    function safeFingerprint(record) {
        if (!record || typeof record !== 'object') return '';
        try {
            // Recompute from the current fields so edits to accepted history
            // cannot leave a stale persisted fingerprint as the approval index.
            return review.stableFingerprint(record);
        } catch (_) {
            return text(record.fingerprint);
        }
    }

    function validDate(value) {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(value));
        if (!match) return false;
        const check = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
        return check.getUTCFullYear() === Number(match[1]) && check.getUTCMonth() + 1 === Number(match[2]) && check.getUTCDate() === Number(match[3]);
    }

    function syncRuntimeSetting(config, fallbackCutoffDate) {
        const source = config || {};
        const activation = source.syncActivation;
        const baseline = text(activation && activation.cutoffDate) || text(fallbackCutoffDate);
        if (!validDate(baseline)) throw new Error('Sync activation is not ready.');
        const runtime = source.syncSettings;
        if (runtime === undefined || runtime === null) return { cutoffDate: baseline, revision: Number.isSafeInteger(activation && activation.revision) && activation.revision >= 1 ? activation.revision : 0 };
        if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime) || !validDate(runtime.cutoffDate) || text(runtime.cutoffDate) < baseline || !Number.isSafeInteger(runtime.revision) || runtime.revision < 1) throw new Error('Sync activation is not ready.');
        return { cutoffDate: text(runtime.cutoffDate), revision: runtime.revision };
    }

    function createProtectedSyncSettings(options) {
        const opts = options || {};
        if (!opts.db || typeof opts.db.collection !== 'function' || typeof opts.db.runTransaction !== 'function') throw new Error('A Firestore sync settings client is required.');
        const householdId = text(opts.householdId);
        const configCollection = text(opts.configCollection || 'protectedAppConfig');
        const configDocument = text(opts.configDocument || 'transactionService');
        const connectionCollection = text(opts.connectionsCollection || 'protectedConnections');
        const requiredKeys = [...new Set((opts.requiredConnectionKeys || ['chase', 'capital-one']).map(text).filter(Boolean))];
        const syncReadiness = typeof opts.syncReadiness === 'function' ? opts.syncReadiness : null;
        const clock = typeof opts.clock === 'function' ? opts.clock : () => new Date().toISOString();
        const authorize = typeof opts.authorize === 'function' ? opts.authorize : async auth => {
            if (!auth || auth.tokenVerified !== true || !text(auth.uid) || !text(auth.email)) throw new Error('Authenticated server authorization is required.');
            if (text(auth.householdId) !== householdId) throw new Error('User is not a member of this household.');
            return auth;
        };
        const configRef = opts.db.collection(configCollection).doc(configDocument);
        const connectionRef = key => opts.db.collection(connectionCollection).doc(key);
        const read = async auth => {
            const user = await authorize(auth);
            const snapshot = await configRef.get();
            const config = snapshot && snapshot.exists ? snapshot.data() || {} : {};
            const activation = config.syncActivation;
            if (!activation || typeof activation !== 'object' || Array.isArray(activation) || text(config.householdId) !== householdId || config.allowed !== true || activation.enabled !== true) return { ready: false, cutoffDate: null, revision: null };
            const readiness = syncReadiness ? await syncReadiness(user) : null;
            if (readiness && readiness.ready !== true) return { ready: false, cutoffDate: null, revision: null };
            const setting = syncRuntimeSetting(config, opts.fallbackCutoverDate);
            return { ready: true, cutoffDate: setting.cutoffDate, revision: setting.revision, actor: text(user.uid) };
        };
        const update = async (auth, cutoffDate, expectedRevision) => {
            const user = await authorize(auth);
            const requested = text(cutoffDate);
            if (!validDate(requested)) throw new Error('Cutoff date must be a real YYYY-MM-DD date.');
            const clockValue = clock();
            const clockText = typeof clockValue === 'number' && Number.isFinite(clockValue)
                ? new Date(clockValue).toISOString()
                : text(clockValue);
            const today = clockText.slice(0, 10);
            if (!validDate(today)) throw new Error('Sync settings clock is invalid.');
            if (requested > today) throw new Error('Cutoff date cannot be in the future.');
            if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('Sync settings revision is required.');
            if (syncReadiness) {
                const readiness = await syncReadiness(user);
                if (!readiness || readiness.ready !== true) throw new Error('Sync activation is not ready.');
            }
            return opts.db.runTransaction(async transaction => {
                const configSnapshot = await transaction.get(configRef);
                const config = configSnapshot && configSnapshot.exists ? configSnapshot.data() || {} : {};
                const activation = config.syncActivation;
                if (!activation || typeof activation !== 'object' || Array.isArray(activation) || text(config.householdId) !== householdId || config.allowed !== true || activation.enabled !== true) throw new Error('Sync activation is not ready.');
                const current = syncRuntimeSetting(config, opts.fallbackCutoverDate);
                if (current.revision !== expectedRevision) throw new Error('Sync settings changed since they were loaded.');
                if (requested < current.cutoffDate) throw new Error('Cutoff date can only move forward; earlier dates require an explicit backfill operation.');
                for (const key of requiredKeys) {
                    const snapshot = await transaction.get(connectionRef(key));
                    const record = snapshot && snapshot.exists ? snapshot.data() || {} : {};
                    const ownerMatches = text(record.ownerUid) === text(user.uid);
                    if (!ownerMatches || text(record.householdId) !== householdId) throw new Error('User is not authorized for this provider connection.');
                }
                const next = { ...clone(config), syncSettings: { cutoffDate: requested, revision: current.revision + 1, updatedAt: text(clock()), updatedBy: text(user.uid) } };
                transaction.set(configRef, next);
                return { ok: true, cutoffDate: requested, revision: current.revision + 1 };
            });
        };
        return Object.freeze({ read, update });
    }

    function observationDigest(kind, item) {
        const source = item || {};
        // Keep this projection explicit. Provider payloads can contain access
        // tokens and unrelated fields that must never enter a candidate or
        // its revision identity.
        const safe = {
            kind: text(kind),
            transactionId: text(source.transaction_id || source.id),
            amount: source.amount,
            name: text(source.name),
            merchantName: text(source.merchant_name),
            date: text(source.date),
            dateModified: text(source.date_modified),
            authorizedDate: text(source.authorized_date),
            pendingTransactionId: text(source.pending_transaction_id),
            pending: source.pending === true,
            transactionCode: text(source.transaction_code),
            accountId: text(source.account_id || source.account),
            currency: text(source.iso_currency_code || source.currency_code).toUpperCase(),
            category: text(source.category),
            personalFinanceCategory: source.personal_finance_category && {
                primary: text(source.personal_finance_category.primary),
                detailed: text(source.personal_finance_category.detailed),
                confidenceLevel: text(source.personal_finance_category.confidence_level)
            },
            classification: text(source.classification)
        };
        const serialized = JSON.stringify(safe);
        return digestSerialized(serialized);
    }

    function digestSerialized(serialized) {
        try {
            if (typeof require === 'function') return require('crypto').createHash('sha256').update(serialized).digest('hex');
        } catch (_) { /* Browser fallback below; live provider calls stay server-side. */ }
        let hash = 2166136261;
        for (let index = 0; index < serialized.length; index += 1) {
            hash ^= serialized.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(16).padStart(8, '0');
    }

    function acceptedTargetDigest(item) {
        const source = item || {};
        // This bounded projection covers fields that a user can edit or that
        // identify a provider observation. Review/transport metadata is
        // intentionally excluded so callers cannot choose the fence value.
        return digestSerialized(JSON.stringify({
            source: text(source.source),
            sourceIdentity: text(source.sourceIdentity),
            sourceRevision: text(source.sourceRevision),
            parentSourceIdentity: text(source.parentSourceIdentity),
            parentSourceRevision: text(source.parentSourceRevision),
            date: text(source.date),
            description: text(source.description),
            amount: source.amount,
            category: text(source.category),
            merchant: text(source.merchant),
            account: text(source.account),
            paymentMethod: text(source.payment_method),
            type: text(source.type),
            currency: text(source.currency || source.currency_code).toUpperCase(),
            pending: source.pending === true,
            transactionCode: text(source.transactionCode || source.transaction_code)
        }));
    }

    function acceptedTargetSetDigest(items) {
        return digestSerialized(JSON.stringify((items || []).map(acceptedTargetDigest).sort()));
    }

    function amendmentTargetItems(candidate, acceptedValues) {
        const identity = text(candidate && candidate.sourceIdentity);
        const targetRevision = text(candidate && candidate.targetSourceRevision);
        if (!identity) return [];
        return (acceptedValues || []).filter(item => {
            if (!item || typeof item !== 'object') return false;
            const direct = text(item.sourceIdentity) === identity && (!targetRevision || text(item.sourceRevision) === targetRevision);
            const splitChild = text(item.parentSourceIdentity) === identity && (!targetRevision || text(item.parentSourceRevision) === targetRevision);
            return direct || splitChild;
        });
    }

    function isReviewableAcceptedTransaction(transaction) {
        const source = transaction || {};
        if (!validDate(source.date) || !text(source.description) || !text(source.account)) return false;
        try {
            review.stableFingerprint(source);
            return true;
        } catch (_) {
            return false;
        }
    }

    function identityPart(value) {
        return encodeURIComponent(text(value));
    }

    function amountCents(value) {
        const raw = text(value);
        if (!/^-?(?:\d+)(?:\.\d{1,2})?$/.test(raw)) throw new Error('Split amounts must use at most two decimal places.');
        const negative = raw.startsWith('-');
        const unsigned = negative ? raw.slice(1) : raw;
        const [whole, fraction = ''] = unsigned.split('.');
        const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
        if (!Number.isSafeInteger(cents)) throw new Error('Split amount is outside the supported range.');
        return negative ? -cents : cents;
    }

    function uniqueRunId(connectionKey, clock) {
        let random = '';
        try {
            if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') random = crypto.randomUUID();
            else if (typeof require === 'function') random = require('crypto').randomUUID();
        } catch (_) { /* A timestamp/random fallback is sufficient for local tests. */ }
        if (!random) random = `${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
        return `sync-${text(connectionKey) || 'connection'}-${clock()}-${random}`;
    }

    function toAccepted(candidate, actor, at) {
        const accepted = { ...clone(candidate), approvedBy: actor, approvedAt: at };
        // Keep the review revision/source metadata beside the canonical row so
        // a later server snapshot can reconstruct a revision-bound receipt.
        accepted.reviewRevision = candidate.revision;
        delete accepted.status;
        delete accepted.overlap;
        delete accepted.overlapDetails;
        delete accepted.revision;
        delete accepted.reviewedRevision;
        // batchId and source identity remain useful for historical batch
        // completion and dedupe after a reload.
        return accepted;
    }

    // An approval receipt is retained for idempotent retries, but it must not
    // retain the complete canonical history. Older snapshots used result,
    // which contained state and could grow with every approval. Read that
    // shape for compatibility and immediately reduce it to the receipt and
    // records approved by this request.
    function compactReceipt(value, idempotencyKey) {
        const source = value || {};
        const result = source.result && typeof source.result === 'object' ? source.result : {};
        const receipt = source.receipt || result.receipt || {
            idempotencyKey,
            actor: source.actor,
            approvedAt: source.approvedAt,
            candidateIds: source.candidateIds,
            revisions: source.revisions
        };
        const accepted = source.accepted || result.accepted || [];
        return {
            actor: text(source.actor || receipt.actor).toLowerCase(),
            candidateIds: Array.isArray(source.candidateIds) ? source.candidateIds.slice() : (Array.isArray(receipt.candidateIds) ? receipt.candidateIds.slice() : []),
            revisions: Array.isArray(source.revisions) ? source.revisions.slice() : (Array.isArray(receipt.revisions) ? receipt.revisions.slice() : []),
            approvedAt: text(source.approvedAt || receipt.approvedAt),
            receipt: clone(receipt),
            accepted: Array.isArray(accepted) ? clone(accepted) : []
        };
    }

    class KeyedMutex {
        constructor() { this.tails = new Map(); }

        async run(key, callback) {
            const scope = text(key) || 'default';
            const prior = this.tails.get(scope) || Promise.resolve();
            let release;
            const current = new Promise(resolve => { release = resolve; });
            this.tails.set(scope, current);
            await prior;
            try {
                return await callback();
            } finally {
                release();
                if (this.tails.get(scope) === current) this.tails.delete(scope);
            }
        }
    }

    function requireAcceptedRevision(expectedRevision, currentRevision) {
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('Accepted state revision is required.');
        if (expectedRevision !== currentRevision) throw new Error('Accepted state changed since it was loaded.');
    }

    function acceptedStateValidationSnapshot(source, transactions) {
        if (!source || typeof source !== 'object' || Array.isArray(source)
            || !Array.isArray(source.categories) || !Array.isArray(source.transactions)
            || !source.budgets || typeof source.budgets !== 'object' || Array.isArray(source.budgets)
            || !source.merchantDefaults || typeof source.merchantDefaults !== 'object' || Array.isArray(source.merchantDefaults)
            || !Array.isArray(source.categoryGroups) || !source.categoryColors || typeof source.categoryColors !== 'object' || Array.isArray(source.categoryColors)
            || !Array.isArray(source.categoryOrder)) throw new Error('Accepted state is invalid.');
        return {
            schemaVersion: review.VERSION,
            transactions,
            categories: source.categories,
            budgets: source.budgets,
            merchantDefaults: source.merchantDefaults,
            categoryGroups: source.categoryGroups,
            categoryColors: source.categoryColors,
            categoryOrder: source.categoryOrder
        };
    }

    function acceptsOpaqueAcceptedHistoryDates(source) {
        if (!source || !Object.prototype.hasOwnProperty.call(source, 'acceptedHistoryDateCompatibility')) return false;
        if (source.acceptedHistoryDateCompatibility !== true) throw new Error('Accepted history compatibility marker is invalid.');
        return true;
    }

    function sameSerialized(left, right) {
        return JSON.stringify(left) === JSON.stringify(right);
    }

    function acceptedStorageKey(transaction, index) {
        const source = transaction || {};
        return text(source.sourceIdentity) && text(source.sourceRevision)
            ? `${text(source.sourceIdentity)}@${text(source.sourceRevision)}`
            : `accepted:${index}`;
    }

    function acceptedCandidateId(transaction, index) {
        const source = transaction || {};
        return text(source.id) || acceptedStorageKey(source, index);
    }

    function validateAcceptedStateForSave(current, next) {
        const source = next || {};
        const currentSource = current || {};
        // Validate the shape and all non-transaction fields before inspecting
        // rows, so malformed state fails with a bounded application error.
        // Validate metadata independently. A legacy row may be invalid in an
        // already accepted snapshot, but metadata must never be bypassed by
        // keeping every existing row unchanged.
        review.validateSnapshot(acceptedStateValidationSnapshot(source, []));
        const rows = source.transactions;
        const existingRows = Array.isArray(currentSource.transactions) ? currentSource.transactions.slice() : [];
        const remainingExistingRows = existingRows.slice();
        for (let index = 0; index < rows.length; index += 1) {
            const transaction = rows[index];
            try {
                review.validateSnapshot(acceptedStateValidationSnapshot(source, [transaction]));
            } catch (_) {
                const legacyIndex = remainingExistingRows.findIndex(existing => sameSerialized(existing, transaction));
                if (legacyIndex < 0) throw new Error(`Accepted transaction ${index + 1} is invalid or changed.`);
                remainingExistingRows.splice(legacyIndex, 1);
            }
        }
    }

    class ProtectedReviewBackend {
        constructor(options) {
            const opts = options || {};
            this.householdId = text(opts.householdId || 'default-household');
            this.allowedUsers = new Set((opts.allowedUsers || EXISTING_ALLOWED_USERS).map(value => text(value).toLowerCase()).filter(Boolean));
            this.allowedUserIds = new Set((opts.allowedUserIds || []).map(value => text(value)).filter(Boolean));
            this.allowExistingAppUserClaim = opts.allowExistingAppUserClaim === true;
            this.clock = typeof opts.clock === 'function' ? opts.clock : () => new Date().toISOString();
            this.pending = new Map();
            this.rejected = new Map();
            this.accepted = new Map();
            this.approvedAmendments = new Map();
            this.receipts = new Map();
            this.batchMeta = new Map();
            this.audit = [];
            this.revision = Number.isSafeInteger(opts.revision) && opts.revision >= 0 ? opts.revision : 0;
            const state = opts.initialState || {};
            this.state = {
                categories: clone(state.categories || []),
                budgets: clone(state.budgets || {}),
                merchantDefaults: clone(state.merchantDefaults || {}),
                categoryGroups: clone(state.categoryGroups || []),
                categoryColors: clone(state.categoryColors || {}),
                categoryOrder: clone(state.categoryOrder || [])
            };
            (state.transactions || []).forEach(transaction => {
                const sourceKey = transaction.sourceIdentity && transaction.sourceRevision ? `${transaction.sourceIdentity}@${transaction.sourceRevision}` : `accepted:${this.accepted.size}`;
                this.accepted.set(sourceKey, clone(transaction));
            });
            this.mutex = new KeyedMutex();
        }

        authorize(auth) {
            const actor = auth || {};
            const email = text(actor.email).toLowerCase();
            if (actor.tokenVerified !== true || !text(actor.uid) || !email) throw new Error('Authenticated server authorization is required.');
            if (!this.allowedUsers.has(email) && !this.allowedUserIds.has(text(actor.uid)) && !(this.allowExistingAppUserClaim && actor.existingAppUser === true)) throw new Error('Authenticated user is not an approved app user.');
            if (actor.householdId !== undefined && text(actor.householdId) !== this.householdId) throw new Error('User is not a member of this household.');
            return { uid: text(actor.uid), email, householdId: this.householdId };
        }

        async stage(auth, records, options) {
            const user = this.authorize(auth);
            const opts = options || {};
            const source = text(opts.source || (records && records[0] && records[0].source) || 'manual-csv').toLowerCase();
            const batchId = text(opts.batchId || `backend-${Date.now()}`);
            return this.mutex.run(this.householdId, async () => {
                const staged = [];
                const seen = new Set();
                (records || []).forEach((record, index) => {
                    const candidate = normalizeInboundCandidate(record, source || record.source || 'manual-csv', index, batchId);
                    if (seen.has(candidate.id)) return;
                    seen.add(candidate.id);
                    const old = this.pending.get(candidate.id);
                    if (old && old.sourceRevision === candidate.sourceRevision) return;
                    const priorPending = [...this.pending.values()].find(item => item.sourceIdentity === candidate.sourceIdentity);
                    const priorRejected = [...this.rejected.values()].find(item => item.sourceIdentity === candidate.sourceIdentity && item.sourceRevision === candidate.sourceRevision);
                    const priorHistory = [...this.rejected.values()].find(item => item.sourceIdentity === candidate.sourceIdentity);
                    const priorAccepted = [...this.accepted.values()].find(item => item.sourceIdentity === candidate.sourceIdentity && item.sourceRevision !== candidate.sourceRevision) ||
                        [...this.accepted.values()].find(item => item.parentSourceIdentity === candidate.sourceIdentity && item.parentSourceRevision !== candidate.sourceRevision);
                    if (priorAccepted && (candidate.amendment === 'modified' || candidate.amendment === 'removed')) {
                        candidate.targetSourceRevision = priorAccepted.parentSourceIdentity === candidate.sourceIdentity
                            ? priorAccepted.parentSourceRevision
                            : priorAccepted.sourceRevision;
                        const targetItems = amendmentTargetItems(candidate, [...this.accepted.values()]);
                        candidate.targetAcceptedDigest = acceptedTargetSetDigest(targetItems);
                        candidate.targetAcceptedReviewRevision = Number.isSafeInteger(priorAccepted.reviewRevision) ? priorAccepted.reviewRevision : null;
                    }
                    if (priorRejected && opts.reconsider !== true) return;
                    if (priorPending && priorPending.sourceRevision !== candidate.sourceRevision) {
                        this.rejected.set(priorPending.id, { ...priorPending, status: 'superseded', supersededBy: candidate.id, supersededAt: this.clock() });
                        this.pending.delete(priorPending.id);
                    }
                    if ([...this.accepted.values()].some(item => item.sourceIdentity === candidate.sourceIdentity && item.sourceRevision === candidate.sourceRevision)) return;
                    candidate.status = review.STATES.PENDING;
                    const providerClassification = source === 'bank-provider' && (candidate.providerClassification === 'income' || candidate.providerClassification === 'expense')
                        ? candidate.providerClassification
                        : '';
                    candidate.sourceOriginal = immutableSource(candidate);
                    if (opts.serverIngest === true && source === 'bank-provider' && Number.isFinite(candidate.__providerSignedAmount)) candidate.sourceOriginal.amount = candidate.__providerSignedAmount;
                    if (providerClassification) candidate.sourceOriginal.providerClassification = providerClassification;
                    delete candidate.providerClassification;
                    candidate.revision = (old || priorPending || priorHistory ? (old || priorPending || priorHistory).revision : 0) + 1;
                    candidate.reviewedRevision = candidate.revision;
                    this.pending.set(candidate.id, candidate);
                    staged.push(clone(candidate));
                });
                this.recomputeOverlaps();
                staged.forEach(candidate => {
                    const refreshed = this.pending.get(candidate.id);
                    if (refreshed) Object.assign(candidate, clone(refreshed));
                });
                if (!staged.length) return { revision: this.revision, candidates: [] };
                this.batchMeta.set(batchId, { ...clone(opts.batchMeta || {}), ids: staged.map(candidate => candidate.id) });
                this.audit.push({ action: 'stage', actor: user.email, batchId, count: staged.length, at: this.clock() });
                this.revision += 1;
                return { revision: this.revision, candidates: staged };
            });
        }

        findOverlap(candidate) {
            return this.findOverlapDetails(candidate).map(detail => detail.id);
        }

        findOverlapDetails(candidate) {
            return review.overlapDetailsFor(candidate, [...this.pending.entries(), ...this.accepted.entries()]);
        }

        recomputeOverlaps() {
            for (const candidate of this.pending.values()) {
                const details = this.findOverlapDetails(candidate);
                candidate.overlap = details.map(detail => detail.id);
                candidate.overlapDetails = details;
            }
        }

        async listPending(auth) {
            this.authorize(auth);
            this.normalizeHydratedPending();
            return [...this.pending.values()].map(clone);
        }

        normalizeHydratedPending() {
            for (const [id, candidate] of this.pending.entries()) {
                const normalized = review.normalizePendingCandidate(candidate);
                if (normalized && normalized.id === id) this.pending.set(id, normalized);
            }
        }

        async edit(auth, candidateId, patch, expectedRevision) {
            const user = this.authorize(auth);
            return this.mutex.run(this.householdId, async () => {
                const current = this.pending.get(text(candidateId));
                if (!current) throw new Error('Candidate is no longer pending.');
                if (current.revision !== expectedRevision) throw new Error('Candidate changed since it was loaded.');
                const next = review.normalizeEditedCandidate({ ...current, sourceIdentity: current.sourceIdentity, sourceRevision: current.sourceRevision }, patch);
                next.sourceIdentity = current.sourceIdentity;
                next.sourceRevision = current.sourceRevision;
                next.id = current.id;
                next.sourceOriginal = clone(current.sourceOriginal || immutableSource(current));
                next.revision = current.revision + 1;
                next.reviewedRevision = next.revision;
                next.status = review.STATES.PENDING;
                this.pending.set(current.id, next);
                this.recomputeOverlaps();
                this.audit.push({ action: 'edit', actor: user.email, id: current.id, revision: next.revision, at: this.clock() });
                this.revision += 1;
                return clone(this.pending.get(current.id));
            });
        }

        async split(auth, candidateId, parts, expectedRevision) {
            const user = this.authorize(auth);
            return this.mutex.run(this.householdId, async () => {
                const id = text(candidateId);
                const current = this.pending.get(id);
                if (!current) throw new Error('Candidate is no longer pending.');
                if (current.revision !== expectedRevision) throw new Error('Candidate changed since it was loaded.');
                if (!Array.isArray(parts) || parts.length < 2) throw new Error('A split requires at least two parts.');
                const sourceCents = amountCents(current.amount);
                const sign = sourceCents < 0 ? -1 : 1;
                const partCents = parts.map(part => {
                    const cents = amountCents(part && part.amount);
                    if (cents <= 0 || !text(part && part.category)) throw new Error('Split parts require positive amounts and categories.');
                    return cents;
                });
                if (partCents.reduce((sum, cents) => sum + cents, 0) !== Math.abs(sourceCents)) throw new Error('Split parts must conserve the signed transaction amount.');
                this.pending.delete(id);
                const created = partCents.map((cents, index) => {
                    const part = parts[index];
                    const candidate = normalizeInboundCandidate({ ...current, amount: sign * cents / 100, category: text(part.category), description: text(part.description) || `${current.description} (split ${index + 1})`, sourceIdentity: `${current.sourceIdentity}/split/${index + 1}`, sourceRevision: `${current.sourceRevision}.${index + 1}`, parentSourceIdentity: current.sourceIdentity, parentSourceRevision: current.sourceRevision }, current.source, index, current.batchId);
                    candidate.parentSourceIdentity = current.sourceIdentity;
                    candidate.parentSourceRevision = current.sourceRevision;
                    candidate.sourceOriginal = clone(current.sourceOriginal || immutableSource(current));
                    candidate.status = review.STATES.PENDING;
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
                this.audit.push({ action: 'split', actor: user.email, id, parts: created.map(item => item.id), at: this.clock() });
                this.revision += 1;
                return { revision: this.revision, candidates: created.map(clone) };
            });
        }

        async reject(auth, candidateId, expectedRevision) {
            return this.mutateStatus(auth, candidateId, expectedRevision, review.STATES.REJECTED);
        }

        async defer(auth, candidateId, expectedRevision) {
            return this.mutateStatus(auth, candidateId, expectedRevision, review.STATES.DEFERRED);
        }

        async cancel(auth) {
            const user = this.authorize(auth);
            return this.mutex.run(this.householdId, async () => {
                const count = this.pending.size;
                this.pending.clear();
                this.batchMeta.clear();
                this.audit.push({ action: 'cancel', actor: user.email, count, at: this.clock() });
                this.revision += 1;
                return { count, revision: this.revision };
            });
        }

        replaceAccepted(auth, state, expectedRevision) {
            this.authorize(auth);
            requireAcceptedRevision(expectedRevision, this.revision);
            const source = state || {};
            review.validateSnapshot({
                schemaVersion: review.VERSION,
                transactions: Array.isArray(source.transactions) ? source.transactions : [],
                categories: Array.isArray(source.categories) ? source.categories : [],
                budgets: source.budgets || {}, merchantDefaults: source.merchantDefaults || {},
                categoryGroups: source.categoryGroups || [], categoryColors: source.categoryColors || {}, categoryOrder: source.categoryOrder || []
            }, { allowOpaqueAcceptedHistoryDates: acceptsOpaqueAcceptedHistoryDates(source) });
            const invalidatedReceipts = this.receipts.size;
            this.accepted.clear();
            this.approvedAmendments.clear();
            this.receipts.clear();
            (source.transactions || []).forEach((transaction, index) => {
                const key = acceptedStorageKey(transaction, index);
                this.accepted.set(key, clone(transaction));
            });
            this.state = {
                categories: clone(source.categories || []), budgets: clone(source.budgets || {}), merchantDefaults: clone(source.merchantDefaults || {}),
                categoryGroups: clone(source.categoryGroups || []), categoryColors: clone(source.categoryColors || {}), categoryOrder: clone(source.categoryOrder || [])
            };
            this.revision += 1;
            this.audit.push({ action: 'restore', actor: text(auth.email).toLowerCase(), count: this.accepted.size, invalidatedReceipts, at: this.clock() });
            return { ok: true, revision: this.revision, state: this.canonicalState() };
        }

        saveAcceptedState(auth, state, expectedRevision) {
            this.authorize(auth);
            requireAcceptedRevision(expectedRevision, this.revision);
            const source = state || {};
            validateAcceptedStateForSave(this.canonicalState(), source);
            const nextTransactions = Array.isArray(source.transactions) ? source.transactions : [];
            const nextIds = new Set(nextTransactions.map((transaction, index) => acceptedCandidateId(transaction, index)));
            const receiptIds = new Set();
            this.receipts.forEach((value, idempotencyKey) => {
                const compact = compactReceipt(value, idempotencyKey);
                (compact.candidateIds || []).forEach(id => {
                    const candidateId = text(id);
                    if (candidateId) receiptIds.add(candidateId);
                });
            });
            const existingHistoryIds = new Set([...this.approvedAmendments.values()].map((transaction, index) => acceptedCandidateId(transaction, index)));
            [...this.accepted.values()].forEach((transaction, index) => {
                const candidateId = acceptedCandidateId(transaction, index);
                if (nextIds.has(candidateId) || !receiptIds.has(candidateId) || existingHistoryIds.has(candidateId)) return;
                const historyKey = `history:receipt:${digestSerialized(candidateId)}`;
                this.approvedAmendments.set(historyKey, { ...clone(transaction), reviewHistory: true });
                existingHistoryIds.add(candidateId);
            });
            this.accepted.clear();
            nextTransactions.forEach((transaction, index) => {
                const key = acceptedStorageKey(transaction, index);
                this.accepted.set(key, clone(transaction));
            });
            this.state = {
                categories: clone(source.categories), budgets: clone(source.budgets), merchantDefaults: clone(source.merchantDefaults),
                categoryGroups: clone(source.categoryGroups), categoryColors: clone(source.categoryColors), categoryOrder: clone(source.categoryOrder)
            };
            this.revision += 1;
            this.audit.push({ action: 'save-accepted-state', actor: text(auth.email).toLowerCase(), count: this.accepted.size, at: this.clock() });
            return { ok: true, revision: this.revision, state: this.canonicalState() };
        }

        resetAccepted(auth, expectedRevision) {
            this.authorize(auth);
            requireAcceptedRevision(expectedRevision, this.revision);
            const invalidatedReceipts = this.receipts.size;
            this.accepted.clear();
            this.approvedAmendments.clear();
            this.receipts.clear();
            this.state.budgets = {};
            this.state.merchantDefaults = {};
            this.revision += 1;
            this.audit.push({ action: 'reset-accepted', actor: text(auth.email).toLowerCase(), invalidatedReceipts, at: this.clock() });
            return { ok: true, revision: this.revision, state: this.canonicalState() };
        }

        async mutateStatus(auth, candidateId, expectedRevision, status) {
            const user = this.authorize(auth);
            return this.mutex.run(this.householdId, async () => {
                const id = text(candidateId);
                const current = this.pending.get(id);
                if (!current) throw new Error('Candidate is no longer pending.');
                if (current.revision !== expectedRevision) throw new Error('Candidate changed since it was loaded.');
                const next = { ...current, status, ...(status === review.STATES.REJECTED ? { rejectedBy: user.email, rejectedAt: this.clock() } : { deferredBy: user.email, deferredAt: this.clock() }) };
                this.pending.delete(id);
                if (status === review.STATES.REJECTED) this.rejected.set(id, next);
                else this.pending.set(id, next);
                this.audit.push({ action: status, actor: user.email, id, revision: current.revision, at: this.clock() });
                this.revision += 1;
                return clone(next);
            });
        }

        async approve(auth, request) {
            const user = this.authorize(auth);
            const input = request || {};
            const rawIds = (input.candidateIds || []).map(value => text(value)).filter(Boolean);
            const ids = idList(input.candidateIds);
            const revisions = (input.revisions || []).map(value => Number(value));
            const key = text(input.idempotencyKey);
            if (!ids.length || ids.length !== rawIds.length || !key || revisions.length !== ids.length || revisions.some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error('Atomic approval requires unique candidate IDs, revisions and an idempotency key.');
            return this.mutex.run(this.householdId, async () => {
                const prior = this.receipts.get(key);
                if (prior) {
                    if (prior.actor !== user.email || !sameOrdered(prior.candidateIds, ids) || !sameOrdered(prior.revisions, revisions)) throw new Error('Idempotency key is already bound to another approval.');
                    return {
                        ok: true,
                        revision: this.revision,
                        state: this.canonicalState(),
                        accepted: clone(prior.accepted || []),
                        receipt: clone(prior.receipt)
                    };
                }
                const selected = ids.map(id => this.pending.get(id));
                if (selected.some(candidate => !candidate)) throw new Error('Every candidate must remain pending for approval.');
                this.recomputeOverlaps();
                selected.forEach((candidate, index) => {
                    if (candidate.revision !== revisions[index]) throw new Error(`Candidate ${candidate.id} changed since review.`);
                    if (candidate.status !== review.STATES.PENDING && candidate.status !== review.STATES.DEFERRED) throw new Error(`Candidate ${candidate.id} is not approvable.`);
                    if (candidate.providerPending === true || candidate.pending === true) throw new Error(`Provider pending observation ${candidate.id} must post before approval.`);
                    if (candidate.source === 'bank-provider' && !this.state.categories.some(category => category && text(category.name) === text(candidate.category))) throw new Error('Provider transactions must use an existing budget category.');
                    // Recompute overlap against the current accepted history and
                    // the complete selection. A staged overlap index can be stale
                    // after another edit/delete, and two matching pending rows
                    // still require an explicit duplicate override.
                    const acceptedOverlap = this.findOverlapDetails(candidate).some(detail => {
                        const acceptedItem = this.accepted.get(detail.id);
                        if (!acceptedItem) return false;
                        const isAmendmentTarget = (candidate.amendment === 'modified' || candidate.amendment === 'removed') &&
                            acceptedItem.sourceIdentity === candidate.sourceIdentity &&
                            (!candidate.targetSourceRevision || acceptedItem.sourceRevision === candidate.targetSourceRevision);
                        return !isAmendmentTarget;
                    });
                    const selectedOverlap = selected.some(other => other !== candidate && review.possibleOverlapDetails(candidate, other, other.id));
                    // Pending rows remain reviewable warnings. Only rows selected
                    // together in this approval are blocked, so a user can make
                    // an explicit decision on one row while leaving its possible
                    // overlap in the inbox for later review.
                    if ((acceptedOverlap || selectedOverlap) && input.allowOverlap !== true) throw new Error(`Possible duplicate requires review: ${candidate.id}`);
                    if (candidate.amendment === 'modified' || candidate.amendment === 'removed') {
                        const targetItems = amendmentTargetItems(candidate, [...this.accepted.values()]);
                        if (!candidate.targetAcceptedDigest || !targetItems.length || acceptedTargetSetDigest(targetItems) !== candidate.targetAcceptedDigest) throw new Error(`Amendment target changed since review: ${candidate.id}`);
                    }
                });
                const before = this.exportState();
                try {
                    if (typeof input.beforeCommit === 'function') await input.beforeCommit();
                    const approvedAt = this.clock();
                    const accepted = selected.map(candidate => toAccepted(candidate, user.email, approvedAt));
                    accepted.forEach(candidate => {
                        if (candidate.amendment === 'modified' || candidate.amendment === 'removed') this.applyAmendment(candidate);
                        const sourceKey = candidate.sourceIdentity && candidate.sourceRevision ? `${candidate.sourceIdentity}@${candidate.sourceRevision}` : `accepted:${this.accepted.size}`;
                        if (candidate.amendment === 'removed') this.approvedAmendments.set(sourceKey, candidate);
                        else if (!this.accepted.has(sourceKey)) this.accepted.set(sourceKey, candidate);
                        this.pending.delete(candidate.id);
                    });
                    this.applyApprovalChanges(input, accepted.filter(candidate => candidate.amendment !== 'removed'), ids);
                    const receipt = { idempotencyKey: key, actor: user.email, approvedAt, candidateIds: ids.slice(), revisions: revisions.slice() };
                    this.revision += 1;
                    const result = { ok: true, revision: this.revision, state: this.canonicalState(), accepted: clone(accepted), receipt };
                    this.receipts.set(key, compactReceipt({ actor: user.email, candidateIds: ids, revisions, approvedAt, receipt, accepted }, key));
                    this.audit.push({ action: 'approve', actor: user.email, candidateIds: ids.slice(), revisions: revisions.slice(), at: approvedAt });
                    return result;
                } catch (error) {
                    this.restoreState(before);
                    throw error;
                }
            });
        }

        applyAmendment(candidate) {
            const targets = [...this.accepted.entries()].filter(([, item]) => amendmentTargetItems(candidate, [item]).length > 0);
            if (candidate.amendment === 'modified' && targets.length) candidate.sourceOriginal = clone(targets.map(([, item]) => item));
            targets.forEach(([key, item]) => {
                this.approvedAmendments.set(`history:${key}`, { ...clone(item), reviewHistory: true });
                this.accepted.delete(key);
            });
        }

        applyApprovalChanges(input, accepted, selectedIds) {
            const batches = Array.isArray(input.budgetBatches) && input.budgetBatches.length ? input.budgetBatches : [...this.batchMeta.values()].filter(batch => batch && batch.budgets);
            batches.forEach(batch => {
                if (!batch || !Array.isArray(batch.ids) || !batch.ids.length) return;
                const metadata = batch.batchId && this.batchMeta.get(text(batch.batchId));
                const allIds = metadata && Array.isArray(metadata.ids) && metadata.ids.length ? metadata.ids.map(text) : batch.ids.map(text);
                const selected = new Set(selectedIds.map(text));
                const acceptedIds = new Set([...this.accepted.values()].map(item => text(item.id)));
                // A historical batch may be approved in several durable
                // subsets. Apply its budgets only when every batch member is
                // now accepted or selected in this transaction.
                if (!allIds.every(id => selected.has(id) || acceptedIds.has(id))) return;
                if (!batch.budgets || typeof batch.budgets !== 'object' || Array.isArray(batch.budgets)) throw new Error('Approval budget batch is invalid.');
                Object.entries(batch.budgets).forEach(([month, values]) => {
                    if (!validMonth(month) || !values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Approval budget batch is invalid.');
                    Object.entries(values).forEach(([category, amount]) => {
                        if (!text(category) || typeof amount !== 'number' || !Number.isFinite(amount)) throw new Error('Approval budget batch is invalid.');
                        if (unsafeMapKey(category) || unsafeMapKey(month)) throw new Error('Approval budget batch contains an unsafe map key.');
                        if (!Object.prototype.hasOwnProperty.call(this.state.budgets, category) || !this.state.budgets[category] || typeof this.state.budgets[category] !== 'object' || Array.isArray(this.state.budgets[category])) this.state.budgets[category] = {};
                        this.state.budgets[category][month] = amount;
                    });
                });
                for (const [batchId, metadataEntry] of this.batchMeta.entries()) {
                    if (metadataEntry && Array.isArray(metadataEntry.ids) && sameList(metadataEntry.ids, allIds)) this.batchMeta.delete(batchId);
                }
            });
            accepted.forEach(candidate => {
                if (candidate.source === 'bank-provider') return;
                const name = text(candidate.category);
                if (!name || this.state.categories.some(category => category && text(category.name) === name)) return;
                this.state.categories.push({ name, type: candidate.type === 'income' ? 'income' : 'expense' });
            });
        }

        canonicalState() {
            return {
                transactions: [...this.accepted.values()].filter(item => !item.reviewHistory && item.amendment !== 'removed').map(clone),
                categories: clone(this.state.categories),
                budgets: clone(this.state.budgets),
                merchantDefaults: clone(this.state.merchantDefaults),
                categoryGroups: clone(this.state.categoryGroups),
                categoryColors: clone(this.state.categoryColors),
                categoryOrder: clone(this.state.categoryOrder)
            };
        }

        exportState() {
            this.normalizeHydratedPending();
            return {
                pending: [...this.pending.entries()].map(([id, value]) => [id, clone(value)]),
                rejected: [...this.rejected.entries()].map(([id, value]) => [id, clone(value)]),
                accepted: [...this.accepted.entries()].map(([id, value]) => [id, clone(value)]),
                approvedAmendments: [...this.approvedAmendments.entries()].map(([id, value]) => [id, clone(value)]),
                receipts: [...this.receipts.entries()].map(([id, value]) => [id, clone(value)]),
                batchMeta: [...this.batchMeta.entries()].map(([id, value]) => [id, clone(value)]),
                audit: clone(this.audit),
                revision: this.revision,
                state: clone(this.state)
            };
        }

        exportReviewSnapshot() {
            this.normalizeHydratedPending();
            // Keep legacy rows in canonical accepted state, but omit rows that
            // cannot satisfy the strict review schema. No date is fabricated;
            // accepted-history backup compatibility is handled by the
            // explicit restore/export marker rather than by review metadata.
            const accepted = [];
            const acceptedIds = new Set();
            [...this.accepted.values(), ...this.approvedAmendments.values()]
                .filter(isReviewableAcceptedTransaction)
                .forEach((transaction, index) => {
                    const candidate = {
                        ...clone(transaction),
                        status: review.STATES.APPROVED,
                        revision: Number.isSafeInteger(transaction.reviewRevision) && transaction.reviewRevision > 0 ? transaction.reviewRevision : index + 1,
                        reviewedRevision: Number.isSafeInteger(transaction.reviewRevision) && transaction.reviewRevision > 0 ? transaction.reviewRevision : index + 1,
                        sourceIdentity: text(transaction.sourceIdentity) || 'accepted-history',
                        sourceRevision: text(transaction.sourceRevision) || String(index + 1),
                        id: text(transaction.id) || `${text(transaction.sourceIdentity) || 'accepted-history'}@${text(transaction.sourceRevision) || String(index + 1)}`
                    };
                    candidate.id = `${candidate.sourceIdentity}@${candidate.sourceRevision}`;
                    if (acceptedIds.has(candidate.id)) return;
                    acceptedIds.add(candidate.id);
                    candidate.fingerprint = review.stableFingerprint(candidate);
                    accepted.push(candidate);
                });
            const acceptedById = new Map(accepted.map(candidate => [candidate.id, candidate]));
            const receiptSnapshots = [...this.receipts.entries()].map(([idempotencyKey, value]) => {
                const compact = compactReceipt(value, idempotencyKey);
                const receipt = compact.receipt;
                const receiptAccepted = [];
                for (const [index, transaction] of (compact.accepted || []).entries()) {
                    const id = text(transaction && transaction.id) || text(receipt.candidateIds && receipt.candidateIds[index]);
                    const stored = acceptedById.get(id);
                    const fallback = stored || { ...clone(transaction), status: review.STATES.APPROVED, sourceIdentity: text(transaction.sourceIdentity) || 'accepted-history', sourceRevision: text(transaction.sourceRevision) || String(index + 1), revision: Number(receipt.revisions && receipt.revisions[index]) || index + 1, reviewedRevision: Number(receipt.revisions && receipt.revisions[index]) || index + 1 };
                    if (!stored) {
                        fallback.id = `${fallback.sourceIdentity}@${fallback.sourceRevision}`;
                        try { fallback.fingerprint = review.stableFingerprint(fallback); } catch (_) { return null; }
                    }
                    if (!isReviewableAcceptedTransaction(fallback)) return null;
                    receiptAccepted.push(clone(fallback));
                }
                return { idempotencyKey, accepted: receiptAccepted, receipts: [clone(receipt)] };
            }).filter(Boolean);
            return {
                schemaVersion: review.VERSION,
                pending: [...this.pending.values()].map(clone),
                rejected: [...this.rejected.values()].map(clone),
                accepted,
                audit: clone(this.audit),
                receipts: receiptSnapshots,
                batchMeta: [...this.batchMeta.entries()].map(([id, value]) => [id, clone(value)])
            };
        }

        restoreState(snapshot) {
            this.pending = new Map((snapshot.pending || []).map(entry => {
                const key = Array.isArray(entry) ? entry[0] : entry && entry.id;
                const value = Array.isArray(entry) ? entry[1] : entry;
                const normalized = review.normalizePendingCandidate(value);
                return [key, normalized];
            }));
            this.rejected = new Map(snapshot.rejected);
            this.accepted = new Map(snapshot.accepted);
            this.approvedAmendments = new Map(snapshot.approvedAmendments || []);
            this.receipts = new Map((snapshot.receipts || []).map(entry => [entry[0], compactReceipt(entry[1], entry[0])]));
            this.batchMeta = new Map(snapshot.batchMeta);
            this.audit = snapshot.audit;
            this.revision = snapshot.revision;
            this.state = snapshot.state;
            this.recomputeOverlaps();
        }
    }

    function emptyDurableState() {
        return {
            pending: [], rejected: [], accepted: [], approvedAmendments: [], receipts: [], batchMeta: [], audit: [], revision: 0,
            state: { categories: [], budgets: {}, merchantDefaults: {}, categoryGroups: [], categoryColors: {}, categoryOrder: [] }
        };
    }

    // Firestore rejects arrays nested directly inside arrays. The in-memory
    // backend exports map entries as [key, value] pairs, so the durable
    // repository stores those entries as objects and accepts both forms when
    // reading older documents.
    function mapEntries(value) {
        if (!Array.isArray(value)) return [];
        return value.map(entry => {
            if (Array.isArray(entry) && entry.length === 2) return [text(entry[0]), clone(entry[1])];
            if (entry && typeof entry === 'object' && text(entry.key)) return [text(entry.key), clone(entry.value)];
            return null;
        }).filter(Boolean);
    }

    function firestoreMapEntries(value) {
        return mapEntries(value).map(([key, value]) => ({ key, value }));
    }

    class FirestoreReviewRepository {
        constructor(options) {
            const opts = options || {};
            if (!opts.db || typeof opts.db.runTransaction !== 'function') throw new Error('A Firestore transaction client is required.');
            this.db = opts.db;
            this.collection = text(opts.collection || 'protectedTransactionReview');
            this.acceptedCollection = text(opts.acceptedCollection || 'shared');
            this.acceptedDocumentId = text(opts.acceptedDocumentId || 'data');
            this.householdId = text(opts.householdId);
            if (!this.householdId) throw new Error('A household ID is required.');
            this.pendingRef = typeof opts.ref === 'function' ? opts.ref(this.db, this.householdId) : this.db.collection(this.collection).doc(this.householdId);
            this.acceptedRef = typeof opts.acceptedRef === 'function' ? opts.acceptedRef(this.db, this.householdId) : this.db.collection(this.acceptedCollection).doc(this.acceptedDocumentId);
            this.ref = this.pendingRef;
        }

        async read() {
            return this.db.runTransaction(async transaction => {
                const pending = await transaction.get(this.pendingRef);
                const accepted = await transaction.get(this.acceptedRef);
                return this.composeSnapshot(pending && pending.exists ? pending.data() : {}, accepted && accepted.exists ? accepted.data() : {});
            });
        }

        composeSnapshot(pendingData, acceptedData) {
            const pending = pendingData || {};
            const accepted = acceptedData || {};
            const acceptedEntries = mapEntries(accepted.accepted).length ? mapEntries(accepted.accepted) : (Array.isArray(accepted.transactions) ? accepted.transactions.map((transaction, index) => [transaction.sourceIdentity && transaction.sourceRevision ? `${transaction.sourceIdentity}@${transaction.sourceRevision}` : `accepted:${index}`, transaction]) : []);
            return {
                ...emptyDurableState(), ...clone(pending),
                pending: mapEntries(pending.pending), rejected: mapEntries(pending.rejected), approvedAmendments: mapEntries(pending.approvedAmendments), receipts: mapEntries(pending.receipts), batchMeta: mapEntries(pending.batchMeta), audit: Array.isArray(pending.audit) ? clone(pending.audit) : [],
                accepted: acceptedEntries,
                state: accepted.state || { categories: accepted.categories || [], budgets: accepted.budgets || {}, merchantDefaults: accepted.merchantDefaults || {}, categoryGroups: accepted.categoryGroups || [], categoryColors: accepted.categoryColors || {}, categoryOrder: accepted.categoryOrder || [] },
                revision: Number(accepted.revision) || 0, pendingRevision: Number(pending.revision) || 0
            };
        }

        async transaction(mutator) {
            return this.db.runTransaction(async transaction => {
                const pendingSnapshot = await transaction.get(this.pendingRef);
                const acceptedSnapshot = await transaction.get(this.acceptedRef);
                const pendingData = pendingSnapshot && pendingSnapshot.exists ? pendingSnapshot.data() : {};
                const acceptedData = acceptedSnapshot && acceptedSnapshot.exists ? acceptedSnapshot.data() : {};
                const acceptedEntries = mapEntries(acceptedData.accepted).length ? mapEntries(acceptedData.accepted) : (Array.isArray(acceptedData.transactions) ? acceptedData.transactions.map((transaction, index) => [transaction.sourceIdentity && transaction.sourceRevision ? `${transaction.sourceIdentity}@${transaction.sourceRevision}` : `accepted:${index}`, transaction]) : []);
                const current = this.composeSnapshot(pendingData, acceptedData);
                const output = await mutator(current);
                if (!output || !output.state) throw new Error('Durable review transaction must return a state.');
                const next = output.state;
                transaction.set(this.pendingRef, clone({ pending: firestoreMapEntries(next.pending), rejected: firestoreMapEntries(next.rejected), approvedAmendments: firestoreMapEntries(next.approvedAmendments), receipts: firestoreMapEntries(next.receipts), batchMeta: firestoreMapEntries(next.batchMeta), audit: next.audit || [], revision: next.revision || 0 }));
                if (output.writeAccepted !== false) {
                    const acceptedState = next.state || emptyDurableState().state;
                    // Keep the existing app's shared/data shape readable on
                    // reload. The server derives its retry map from this
                    // canonical transaction array instead of duplicating it.
                    transaction.set(this.acceptedRef, clone({
                        transactions: (next.accepted || []).map(entry => Array.isArray(entry) ? entry[1] : entry).filter(transaction => transaction && !transaction.reviewHistory && transaction.amendment !== 'removed'),
                        ...acceptedState,
                        revision: next.revision || 0
                    }));
                }
                return output.result;
            });
        }
    }

    class DurableProtectedReviewBackend {
        constructor(options) {
            const opts = options || {};
            if (!opts.repository || typeof opts.repository.transaction !== 'function' || typeof opts.repository.read !== 'function') throw new Error('A durable review repository is required.');
            this.repository = opts.repository;
            this.policy = new ProtectedReviewBackend(opts);
        }

        authorize(auth) { return this.policy.authorize(auth); }

        makeMemory(snapshot) {
            const memory = new ProtectedReviewBackend({
                householdId: this.policy.householdId,
                allowedUsers: [...this.policy.allowedUsers],
                allowedUserIds: [...this.policy.allowedUserIds],
                allowExistingAppUserClaim: this.policy.allowExistingAppUserClaim,
                clock: this.policy.clock,
                initialState: snapshot && snapshot.state ? { ...snapshot.state, transactions: (snapshot.accepted || []).map(entry => Array.isArray(entry) ? entry[1] : entry) } : {}
            });
            if (snapshot && Array.isArray(snapshot.pending)) memory.restoreState(snapshot);
            return memory;
        }

        async mutate(auth, callback, options) {
            this.authorize(auth);
            return this.repository.transaction(async snapshot => {
                const memory = this.makeMemory(snapshot);
                const result = await callback(memory);
                return { state: memory.exportState(), result, writeAccepted: !options || options.writeAccepted !== false };
            });
        }

        async stage(auth, records, options) { return this.mutate(auth, memory => memory.stage(auth, records, options), { writeAccepted: false }); }
        async edit(auth, candidateId, patch, expectedRevision) { return this.mutate(auth, memory => memory.edit(auth, candidateId, patch, expectedRevision), { writeAccepted: false }); }
        async split(auth, candidateId, parts, expectedRevision) { return this.mutate(auth, memory => memory.split(auth, candidateId, parts, expectedRevision), { writeAccepted: false }); }
        async reject(auth, candidateId, expectedRevision) { return this.mutate(auth, memory => memory.reject(auth, candidateId, expectedRevision), { writeAccepted: false }); }
        async defer(auth, candidateId, expectedRevision) { return this.mutate(auth, memory => memory.defer(auth, candidateId, expectedRevision), { writeAccepted: false }); }
        async cancel(auth) { return this.mutate(auth, memory => memory.cancel(auth), { writeAccepted: false }); }
        async replaceAccepted(auth, state, expectedRevision) { return this.mutate(auth, memory => memory.replaceAccepted(auth, state, expectedRevision)); }
        async saveAcceptedState(auth, state, expectedRevision) { return this.mutate(auth, memory => memory.saveAcceptedState(auth, state, expectedRevision)); }
        async resetAccepted(auth, expectedRevision) { return this.mutate(auth, memory => memory.resetAccepted(auth, expectedRevision)); }
        async approve(auth, request) {
            const input = { ...(request || {}) };
            return this.mutate(auth, async memory => {
                if (Array.isArray(input.candidates) && input.candidates.length) {
                    const existingReceipt = text(input.idempotencyKey) && memory.receipts.get(text(input.idempotencyKey));
                    if (existingReceipt) {
                        delete input.candidates;
                        return memory.approve(auth, input);
                    }
                    const sourceSet = new Set(input.candidates.map(candidate => text(candidate && candidate.source || input.source).toLowerCase()));
                    if ([...sourceSet].some(source => source !== 'bank-csv' && source !== 'historical-csv' && source !== 'manual-csv')) throw new Error('Inline candidates are limited to new manual CSV observations.');
                    const requestedIds = Array.isArray(input.candidateIds) ? input.candidateIds.map(text).filter(Boolean) : [];
                    const suppliedRevisions = Array.isArray(input.revisions) ? input.revisions.map(value => Number(value)) : [];
                    const pendingIds = requestedIds.filter(id => memory.pending.has(id));
                    if (pendingIds.length) {
                        // The stage request may have committed while its HTTP
                        // response was lost. Recover only when every requested
                        // server row is still pending and every reviewed field
                        // matches that authoritative row. This prevents an
                        // altered inline body from replacing a server review
                        // revision or mixing stale/rejected rows into one
                        // approval.
                        if (pendingIds.length !== requestedIds.length || input.candidates.length !== requestedIds.length) throw new Error('Inline candidates cannot mix existing server review revisions.');
                        const requested = new Set(requestedIds);
                        const seen = new Set();
                        input.candidates.forEach(candidate => {
                            const id = text(candidate && candidate.id);
                            if (!id || seen.has(id) || !requested.has(id)) throw new Error('Inline candidates do not match the existing server review revision.');
                            seen.add(id);
                            const serverCandidate = memory.pending.get(id);
                            if (!serverCandidate || Number(candidate.revision) !== serverCandidate.revision) throw new Error(`Candidate ${id} changed since review.`);
                            let normalized;
                            try {
                                normalized = normalizeInboundCandidate(candidate, candidate.source, 0, serverCandidate.batchId);
                            } catch (_) {
                                throw new Error(`Candidate ${id} changed since review.`);
                            }
                            if (!sameSerialized(approvalCandidateProjection(normalized), approvalCandidateProjection(serverCandidate))) throw new Error(`Candidate ${id} changed since review.`);
                        });
                        if (seen.size !== requestedIds.length) throw new Error('Inline candidates do not match the existing server review revision.');
                        delete input.candidates;
                        return memory.approve(auth, input);
                    }
                    if (requestedIds.some(id => memory.rejected.has(id) || [...memory.accepted.values()].some(candidate => candidate.id === id))) throw new Error('Inline candidates cannot replace an existing server review revision.');
                    const staged = await memory.stage(auth, input.candidates, {
                        source: input.source || input.candidates[0].source || 'manual-csv',
                        batchId: input.batchId || `browser-${input.idempotencyKey || Date.now()}`,
                        batchMeta: input.batchMeta || {},
                        reconsider: input.reconsider === true
                    });
                    const stagedCandidates = Array.isArray(staged && staged.candidates) ? staged.candidates : [];
                    if (!stagedCandidates.length && (!input.candidateIds || !input.candidateIds.length)) throw new Error('Approval candidates were already rejected or accepted.');
                    if (stagedCandidates.length) {
                        const stagedById = new Map(stagedCandidates.map(candidate => [candidate.id, candidate]));
                        if (requestedIds.length) {
                            if (requestedIds.length !== stagedCandidates.length || suppliedRevisions.length !== requestedIds.length || new Set(requestedIds).size !== requestedIds.length) throw new Error('Inline candidates do not match the staged review selection.');
                            requestedIds.forEach((id, index) => {
                                const stagedCandidate = stagedById.get(id);
                                if (!stagedCandidate || suppliedRevisions[index] !== stagedCandidate.revision) throw new Error('Inline candidates do not match the staged review selection.');
                            });
                            input.candidateIds = requestedIds.slice();
                            input.revisions = suppliedRevisions.slice();
                        } else {
                            input.candidateIds = stagedCandidates.map(candidate => candidate.id);
                            input.revisions = stagedCandidates.map(candidate => candidate.revision);
                        }
                    } else {
                        input.revisions = input.candidateIds.map((id, index) => {
                            const current = memory.pending.get(text(id));
                            return current ? current.revision : Number(input.revisions && input.revisions[index]);
                        });
                    }
                }
                delete input.candidates;
                return memory.approve(auth, input);
            });
        }
        async listPending(auth) {
            this.authorize(auth);
            const snapshot = await this.repository.read();
            const memory = this.makeMemory(snapshot);
            return memory.listPending(auth);
        }
        async exportReview(auth) {
            this.authorize(auth);
            const snapshot = await this.repository.read();
            const memory = this.makeMemory(snapshot);
            const reviewSnapshot = memory.exportReviewSnapshot();
            review.validateReviewSnapshot(reviewSnapshot);
            return reviewSnapshot;
        }
        async exportState(auth) {
            this.authorize(auth);
            return this.repository.read();
        }
    }

    class FirestoreSyncRepository {
        constructor(options) {
            const opts = options || {};
            if (!opts.db || typeof opts.db.runTransaction !== 'function') throw new Error('A Firestore transaction client is required.');
            this.db = opts.db;
            this.runs = text(opts.runsCollection || 'protectedSyncRuns');
            this.connections = text(opts.connectionsCollection || 'protectedConnections');
            this.cooldownMs = Number.isFinite(opts.cooldownMs) && opts.cooldownMs >= 0 ? opts.cooldownMs : 4 * 60 * 60 * 1000;
            this.runRef = runId => this.db.collection(this.runs).doc(text(runId));
            this.connectionRef = key => this.db.collection(this.connections).doc(text(key));
        }

        async acquireLease(connectionKey, runId, options) {
            const key = text(connectionKey); const id = text(runId); const opts = options || {};
            const now = Number.isFinite(opts.now) ? opts.now : Date.now();
            const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : 60_000;
            if (!key || !id) throw new Error('Sync lease requires a connection key and run ID.');
            return this.db.runTransaction(async transaction => {
                const ref = this.connectionRef(key); const runRef = this.runRef(id); const snapshot = await transaction.get(ref); const priorRun = await transaction.get(runRef); const current = snapshot && snapshot.exists ? snapshot.data() : {};
                if (priorRun && priorRun.exists) throw new Error('Sync run ID has already been used.');
                if (current.lease && current.lease.expiresAt > now) throw new Error('A sync run is already in progress for this connection.');
                if (Number(current.cooldownUntil) > now) throw new Error('Sync is inside its cooldown window.');
                const originalCursor = current.cursor && current.cursor.cursor || null;
                const lease = { connectionKey: key, runId: id, acquiredAt: now, expiresAt: now + ttlMs, originalCursor };
                transaction.set(ref, { ...clone(current), lease });
                transaction.set(runRef, { runId: id, connectionKey: key, originalCursor, records: [], complete: false, acquiredAt: now });
                return clone(lease);
            });
        }

        async releaseLease(connectionKey, runId) {
            const key = text(connectionKey); const id = text(runId);
            return this.db.runTransaction(async transaction => {
                const ref = this.connectionRef(key); const snapshot = await transaction.get(ref); const current = snapshot && snapshot.exists ? snapshot.data() : {};
                if (!current.lease || current.lease.runId !== id) throw new Error('Sync lease is missing or owned by another run.');
                const next = clone(current); delete next.lease; transaction.set(ref, next); return true;
            });
        }

        async stagePage(runId, records) {
            const id = text(runId);
            return this.db.runTransaction(async transaction => {
                const ref = this.runRef(id); const snapshot = await transaction.get(ref); const current = snapshot && snapshot.exists ? snapshot.data() : {};
                if (current.complete === true) throw new Error('Completed sync runs cannot accept more pages.');
                const byId = new Map((current.records || []).map(record => [record.id, record]));
                (records || []).forEach(record => { if (record && record.id) byId.set(record.id, clone(record)); });
                transaction.set(ref, { ...clone(current), runId: id, records: [...byId.values()] }); return { runId: id, staged: (records || []).length };
            });
        }

        async publishCursor(runId, cursor, expectedIds, connectionKey, options) {
            const id = text(runId); const value = text(cursor); const key = text(connectionKey);
            if (!id || !value || !key) throw new Error('Sync cursor publication requires a run, connection and cursor.');
            const now = options && Number.isFinite(options.now) ? options.now : Date.now();
            const strictLease = options && Number.isFinite(options.now);
            return this.db.runTransaction(async transaction => {
                const runRef = this.runRef(id); const connectionRef = this.connectionRef(key);
                const runSnapshot = await transaction.get(runRef); const connectionSnapshot = await transaction.get(connectionRef);
                const run = runSnapshot && runSnapshot.exists ? runSnapshot.data() : {};
                const connection = connectionSnapshot && connectionSnapshot.exists ? connectionSnapshot.data() : {};
                if (strictLease && (!connection.lease || connection.lease.runId !== id || Number(connection.lease.expiresAt) <= now)) throw new Error('Sync lease is missing or expired.');
                if (run.complete === true) {
                    if (!connection.cursor || connection.cursor.runId !== id || connection.cursor.cursor !== value) throw new Error('Sync run is already complete with a different cursor.');
                    return clone(connection.cursor);
                }
                if (strictLease && (text(run.connectionKey) !== key || (run.originalCursor || null) !== ((connection.cursor && connection.cursor.cursor) || null))) throw new Error('Sync cursor is stale and cannot advance.');
                const records = new Set((run.records || []).map(record => record.id));
                for (const expectedId of expectedIds || []) if (!records.has(expectedId)) throw new Error('Cannot publish cursor before all candidates are staged.');
                const published = { connectionKey: key, runId: id, cursor: value, publishedAt: new Date().toISOString() };
                transaction.set(connectionRef, { ...clone(connection), cursor: published, cooldownUntil: now + this.cooldownMs });
                transaction.set(runRef, { ...clone(run), complete: true }); return clone(published);
            });
        }

        async getCursor(connectionKey) {
            const snapshot = await this.connectionRef(text(connectionKey)).get(); const data = snapshot && snapshot.exists ? snapshot.data() : {};
            return clone(data.cursor || null);
        }
    }

    async function verifyFirebaseAuthorization(request, options) {
        const opts = options || {};
        const header = request && request.headers && (request.headers.authorization || request.headers.Authorization);
        const match = /^Bearer\s+(.+)$/i.exec(text(header));
        if (!match) throw new Error('Bearer authentication is required.');
        const admin = opts.admin || (() => {
            try { return require('firebase-admin'); } catch (_) { throw new Error('Firebase Admin authorization is not configured.'); }
        })();
        if (!admin || !admin.auth || typeof admin.auth !== 'function') throw new Error('Firebase Admin authorization is not configured.');
        const decoded = await admin.auth().verifyIdToken(match[1], true);
        const email = text(decoded && decoded.email).toLowerCase();
        const allowedUsers = new Set((opts.allowedUsers || EXISTING_ALLOWED_USERS).map(value => text(value).toLowerCase()).filter(Boolean));
        if (!decoded || !text(decoded.uid) || !email || !decoded.email_verified || !allowedUsers.has(email)) throw new Error('Authenticated user is not an approved app user.');
        const householdId = typeof opts.householdForUser === 'function' ? await opts.householdForUser(decoded) : text(opts.householdId);
        if (!householdId) throw new Error('Authenticated household membership is not configured.');
        return { uid: text(decoded.uid), email, householdId, tokenVerified: true, authTime: decoded.auth_time };
    }

    class BrowserApprovalClient {
        constructor(options) {
            const opts = options || {};
            this.endpoint = text(opts.endpoint).replace(/\/$/, '');
            this.auth = opts.auth;
            this.fetch = opts.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
            this.serverBacked = true;
            this.stagedIds = new Set();
            this.pendingStage = null;
            if (!this.endpoint || !this.auth || !this.fetch) throw new Error('Approval client requires endpoint, auth and fetch.');
        }

        async request(path, requestBody) {
            const user = this.auth.currentUser;
            if (!user || typeof user.getIdToken !== 'function') throw new Error('Fresh authenticated server authorization is unavailable.');
            const token = await user.getIdToken(true);
            if (!token) throw new Error('Fresh authenticated server authorization is unavailable.');
            const response = await this.fetch(`${this.endpoint}/${path.replace(/^\//, '')}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify(requestBody || {})
            });
            let responseBody;
            let responseJsonFailed = false;
            try { responseBody = await response.json(); } catch (_) { responseJsonFailed = true; }
            if (!response.ok) {
                const error = new Error(safeHttpMessage(responseBody && responseBody.error));
                const diagnostic = sanitizeDiagnostic(responseBody && responseBody.diagnostic, 'backend', response.status)
                    || sanitizeDiagnostic({ stage: 'backend', status: response.status, code: 'BACKEND_REQUEST_FAILED' }, 'backend', response.status);
                if (diagnostic) Object.defineProperty(error, 'diagnostic', { value: diagnostic, enumerable: false, configurable: true });
                throw error;
            }
            if (responseJsonFailed || !responseBody || typeof responseBody !== 'object' || Array.isArray(responseBody)) throw invalidResponseError(response.status);
            return responseBody;
        }

        async get(path) {
            const user = this.auth.currentUser;
            if (!user || typeof user.getIdToken !== 'function') throw new Error('Fresh authenticated server authorization is unavailable.');
            const token = await user.getIdToken(true);
            const response = await this.fetch(`${this.endpoint}/${path.replace(/^\//, '')}`, { headers: { Authorization: `Bearer ${token}` } });
            let body;
            let responseJsonFailed = false;
            try { body = await response.json(); } catch (_) { responseJsonFailed = true; }
            if (!response.ok) {
                const error = new Error(safeHttpMessage(body && body.error));
                const diagnostic = sanitizeDiagnostic(body && body.diagnostic, 'backend', response.status)
                    || sanitizeDiagnostic({ stage: 'backend', status: response.status, code: 'BACKEND_REQUEST_FAILED' }, 'backend', response.status);
                if (diagnostic) Object.defineProperty(error, 'diagnostic', { value: diagnostic, enumerable: false, configurable: true });
                throw error;
            }
            const expectedArray = path.replace(/^\//, '') === 'pending';
            const validBody = expectedArray ? Array.isArray(body) : body && typeof body === 'object' && !Array.isArray(body);
            if (responseJsonFailed || !validBody) throw invalidResponseError(response.status);
            return body;
        }

        async stage(records, options) {
            const operation = this.request('stage', { ...(options || {}), records });
            this.pendingStage = operation;
            try {
                const result = await operation;
                (result.candidates || []).forEach(candidate => this.stagedIds.add(candidate.id));
                return result;
            } finally {
                if (this.pendingStage === operation) this.pendingStage = null;
            }
        }

        async listPending() {
            const result = await this.get('pending');
            (result || []).forEach(candidate => this.stagedIds.add(candidate.id));
            return result || [];
        }
        async loadReview() {
            const result = await this.get('review');
            (result && result.pending || []).forEach(candidate => this.stagedIds.add(candidate.id));
            return result;
        }
        async createLinkToken(connectionKey, sessionId) { return this.request('link-token', { connectionKey, mode: 'create', ...(sessionId ? { sessionId } : {}) }); }
        async exchangeLink(connectionKey, publicToken, accountBindings, requestId) { return this.request('link-exchange', { connectionKey, ...(publicToken ? { publicToken } : {}), ...(accountBindings ? { accountBindings } : {}), requestId }); }
        async linkStatus(connectionKey, requestId) { return this.request('link-status', { connectionKey, requestId }); }
        async disconnectLink(connectionKey) { return this.request('link-disconnect', { connectionKey }); }
        async updateLinkToken(connectionKey) { return this.request('link-update', { connectionKey, mode: 'update' }); }
        async sync(connectionKey) { return this.request('sync', { connectionKey }); }
        async syncReadiness() { return this.get('sync-readiness'); }
        async syncSettings() { return this.get('sync-settings'); }
        async updateSyncSettings(cutoffDate, expectedRevision) { return this.request('sync-settings', { cutoffDate, expectedRevision }); }

        async edit(candidateId, patch, expectedRevision) { return this.request('edit', { candidateId, patch, expectedRevision }); }
        async split(candidateId, parts, expectedRevision) { return this.request('split', { candidateId, parts, expectedRevision }); }
        async reject(candidateId, expectedRevision) { const result = await this.request('reject', { candidateId, expectedRevision }); this.stagedIds.delete(candidateId); return result; }
        async defer(candidateId, expectedRevision) { return this.request('defer', { candidateId, expectedRevision }); }
        async cancel() { const result = await this.request('cancel', {}); this.stagedIds.clear(); return result; }
        async restore(state, expectedRevision) { return this.request('restore', { state, expectedRevision }); }
        async reset(expectedRevision) { return this.request('reset', { expectedRevision }); }
        async saveAcceptedState(state, expectedRevision) { return this.request('accepted-state', { state, expectedRevision }); }

        async approve(payload, receipt, context) {
            if (this.pendingStage) await this.pendingStage;
            const ids = (receipt && receipt.candidateIds) || (payload || []).map(item => item.id);
            const revisions = (receipt && receipt.revisions) || (payload || []).map(item => item.revision);
            const body = {
                candidateIds: ids,
                revisions,
                idempotencyKey: receipt && receipt.idempotencyKey,
                allowOverlap: context && context.allowOverlap === true,
                budgetBatches: context && context.budgetBatches
            };
            if (!ids.every(id => this.stagedIds.has(id))) body.candidates = payload || [];
            const result = await this.request('approve', body);
            ids.forEach(id => this.stagedIds.delete(id));
            return result;
        }
    }

    function jsonResponse(response, status, body) {
        response.statusCode = status;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.end(JSON.stringify(body));
    }

    function createHttpHandler(options) {
        const opts = options || {};
        const backend = opts.backend;
        if (!backend) throw new Error('An approval backend is required.');
        const authenticate = opts.authenticate || (request => verifyFirebaseAuthorization(request, opts));
        // Existing canonical backups can be larger than 512 KiB. Keep a
        // bounded default that accepts those backups while Firestore still
        // enforces its separate per-document size limit.
        const maxBodyBytes = Number.isSafeInteger(opts.maxBodyBytes) && opts.maxBodyBytes > 0 ? opts.maxBodyBytes : 2 * 1024 * 1024;
        const allowedOrigins = new Set((opts.allowedOrigins || []).map(value => text(value)).filter(Boolean));
        if (allowedOrigins.has('*')) throw new Error('Wildcard CORS origins are not permitted for authenticated requests.');
        const applyCors = (request, response) => {
            const origin = text(request && request.headers && (request.headers.origin || request.headers.Origin));
            if (!origin) return;
            if (!allowedOrigins.has(origin)) throw new Error('CORS origin is not allowed.');
            response.setHeader('Access-Control-Allow-Origin', origin);
            response.setHeader('Vary', 'Origin');
            response.setHeader('Access-Control-Allow-Credentials', 'true');
            response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
            response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        };
        return async function transactionHttpHandler(request, response) {
            let requestStage = 'backend';
            try {
                const url = new URL(request.url || '/', 'http://localhost');
                requestStage = url.pathname === '/sync' || url.pathname === '/sync-readiness' ? 'sync' : 'backend';
                applyCors(request, response);
                if (request.method === 'OPTIONS') return jsonResponse(response, 204, {});
                const auth = await authenticate(request);
                const body = await new Promise((resolve, reject) => {
                    if (request.method === 'GET') return resolve({});
                    let size = 0; let raw = '';
                    request.on('data', chunk => { const piece = String(chunk); size += typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function' ? Buffer.byteLength(piece) : piece.length; if (size > maxBodyBytes) reject(new Error('Request body is too large.')); else raw += piece; });
                    request.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { reject(new Error('Request body must be valid JSON.')); } });
                    request.on('error', reject);
                });
                let result;
                if (url.pathname === '/pending' && request.method === 'GET') result = await backend.listPending(auth);
                else if (url.pathname === '/review' && request.method === 'GET' && typeof backend.exportReview === 'function') result = await backend.exportReview(auth);
                else if (url.pathname === '/sync-readiness' && request.method === 'GET' && typeof opts.syncReadiness === 'function') {
                    const readiness = await opts.syncReadiness(auth);
                    result = { ready: readiness && readiness.ready === true, revision: readiness && readiness.revision, cutoffDate: readiness && readiness.cutoffDate, cutoffRevision: readiness && readiness.cutoffRevision, connectionKeys: readiness && readiness.connectionKeys };
                }
                else if (url.pathname === '/sync-settings' && request.method === 'GET' && opts.syncSettings && typeof opts.syncSettings.read === 'function') result = await opts.syncSettings.read(auth);
                else if (url.pathname === '/sync-settings' && request.method === 'POST' && opts.syncSettings && typeof opts.syncSettings.update === 'function') result = await opts.syncSettings.update(auth, body.cutoffDate, body.expectedRevision);
                else if (url.pathname === '/stage' && request.method === 'POST') {
                    const source = text(body.source || body.records && body.records[0] && body.records[0].source || 'manual-csv').toLowerCase();
                    if (!['manual-csv', 'bank-csv', 'historical-csv'].includes(source)) throw new Error('Browser staging is limited to CSV observations.');
                    result = await backend.stage(auth, body.records, { ...body, source, serverIngest: false });
                }
                else if (url.pathname === '/approve' && request.method === 'POST') result = await backend.approve(auth, body);
                else if (url.pathname === '/edit' && request.method === 'POST') result = await backend.edit(auth, body.candidateId, body.patch, body.expectedRevision);
                else if (url.pathname === '/split' && request.method === 'POST') result = await backend.split(auth, body.candidateId, body.parts, body.expectedRevision);
                else if (url.pathname === '/reject' && request.method === 'POST') result = await backend.reject(auth, body.candidateId, body.expectedRevision);
                else if (url.pathname === '/defer' && request.method === 'POST') result = await backend.defer(auth, body.candidateId, body.expectedRevision);
                else if (url.pathname === '/cancel' && request.method === 'POST') result = await backend.cancel(auth);
                else if (url.pathname === '/restore' && request.method === 'POST') result = await backend.replaceAccepted(auth, body.state, body.expectedRevision);
                else if (url.pathname === '/accepted-state' && request.method === 'POST' && typeof backend.saveAcceptedState === 'function') result = await backend.saveAcceptedState(auth, body.state, body.expectedRevision);
                else if (url.pathname === '/reset' && request.method === 'POST') result = await backend.resetAccepted(auth, body.expectedRevision);
                else if (url.pathname === '/sync' && request.method === 'POST' && opts.syncService) result = await opts.syncService.runOnOpen(auth, body.connectionKey, body);
                else return jsonResponse(response, 404, { error: 'Route not found.' });
                return jsonResponse(response, 200, result);
            } catch (error) {
                const message = text(error && error.message) || 'Request failed.';
                const status = /authentication|approved app user|existing app user|household|Bearer|membership/i.test(message) ? 401 : /CORS origin/i.test(message) ? 403 : /changed|pending|approval|duplicate requires review|invalid|revision|Route|too large|JSON/i.test(message) || message === 'Browser staging is limited to CSV observations.' ? 409 : 500;
                let diagnostic = null;
                if (typeof opts.errorDiagnostic === 'function') {
                    try {
                        const provided = opts.errorDiagnostic(error, { stage: requestStage, status });
                        const decorated = provided && typeof provided === 'object' && Number.isInteger(provided.status) && provided.status !== status && !Number.isInteger(provided.http_status)
                            ? { ...provided, http_status: status }
                            : provided;
                        diagnostic = sanitizeDiagnostic(decorated, requestStage, status);
                    } catch (_) { diagnostic = null; }
                }
                if (!diagnostic) {
                    // A provider error can carry a trusted sync diagnostic;
                    // an unbranded failure here is the adjacent service's
                    // staging/HTTP boundary and is reported as backend.
                    const fallbackStage = requestStage === 'sync' ? 'backend' : requestStage;
                    const fallbackCode = status === 401 ? 'AUTHENTICATION_REQUIRED' : status === 403 ? 'CORS_ORIGIN_REJECTED' : 'BACKEND_REQUEST_FAILED';
                    diagnostic = sanitizeDiagnostic({ stage: fallbackStage, status, code: fallbackCode }, fallbackStage, status);
                }
                return jsonResponse(response, status, { error: safeHttpMessage(error), diagnostic });
            }
        };
    }

    class PlaidTransactionsSyncAdapter {
        constructor(options) {
            const opts = options || {};
            if (!opts.client || typeof opts.client.sync !== 'function') throw new Error('Plaid sync adapter requires an injected client.');
            this.client = opts.client;
            this.maxPages = Number.isSafeInteger(opts.maxPages) && opts.maxPages > 0 ? opts.maxPages : 20;
            this.maxRetries = Number.isSafeInteger(opts.maxRetries) && opts.maxRetries >= 0 ? opts.maxRetries : 3;
            this.maxMutationRestarts = Number.isSafeInteger(opts.maxMutationRestarts) && opts.maxMutationRestarts >= 0 ? opts.maxMutationRestarts : 2;
            this.backoffMs = Number.isFinite(opts.backoffMs) && opts.backoffMs >= 0 ? opts.backoffMs : 0;
            this.sleep = typeof opts.sleep === 'function' ? opts.sleep : async ms => { if (ms) await new Promise(resolve => setTimeout(resolve, ms)); };
            this.clock = typeof opts.clock === 'function' ? opts.clock : () => new Date();
            this.resolveRemoved = typeof opts.resolveRemoved === 'function' ? opts.resolveRemoved : null;
            this.accountMap = opts.accountMap && typeof opts.accountMap === 'object' && !Array.isArray(opts.accountMap) ? opts.accountMap : null;
            if (opts.ignoredAccountIds !== undefined && !Array.isArray(opts.ignoredAccountIds)) throw new Error('Plaid ignored account IDs must be an array.');
            const ignoredAccountIds = [];
            for (const value of opts.ignoredAccountIds || []) {
                if (typeof value !== 'string' || !text(value)) throw new Error('Plaid ignored account IDs must be non-empty strings.');
                const id = text(value);
                if (!ignoredAccountIds.includes(id)) ignoredAccountIds.push(id);
            }
            if (this.accountMap && ignoredAccountIds.some(id => Object.prototype.hasOwnProperty.call(this.accountMap, id))) {
                throw new Error('Plaid ignored account IDs must not overlap mapped accounts.');
            }
            this.ignoredAccountIds = new Set(ignoredAccountIds);
            this.preserveError = typeof opts.preserveError === 'function' ? opts.preserveError : null;
            this.classify = typeof opts.classify === 'function' ? opts.classify : null;
        }

        today() {
            const value = this.clock();
            const date = value instanceof Date ? value : new Date(value);
            return Number.isNaN(date.getTime()) ? new Date().toISOString().slice(0, 10) : date.toISOString().slice(0, 10);
        }

        isMutation(response) {
            const code = this.mutationCode(response);
            return code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION';
        }

        mutationCode(value) {
            return text(value && (value.error_code || value.error && value.error.error_code || value.response && value.response.data && value.response.data.error_code || value.data && value.data.error_code || value.code));
        }

        assertSyncActive(payload) {
            const value = payload || {};
            const deadlineAt = Number.isSafeInteger(value.deadlineAt) ? value.deadlineAt : null;
            if ((value.signal && value.signal.aborted) || (deadlineAt !== null && deadlineAt <= Date.now())) {
                const error = new Error('Plaid sync exceeded its bounded execution window.');
                error.code = SYNC_DEADLINE_EXCEEDED;
                error.error_code = SYNC_DEADLINE_EXCEEDED;
                throw error;
            }
        }

        async call(payload, control) {
            const timing = control && typeof control === 'object' ? control : payload;
            let lastError;
            for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
                this.assertSyncActive(timing);
                try {
                    // `payload` is the provider request. Execution controls
                    // stay in the adapter and are passed separately so they
                    // can never become undocumented provider fields.
                    const result = await this.client.sync(payload, timing);
                    this.assertSyncActive(timing);
                    if (result && result.error_code && result.error_code !== 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') {
                        if (text(result.error_code) === 'PRODUCT_NOT_READY') {
                            const notReady = new Error('Plaid sync data is not ready; retry the sync.');
                            notReady.code = 'PRODUCT_NOT_READY';
                            notReady.error_code = 'PRODUCT_NOT_READY';
                            throw notReady;
                        }
                        throw new Error('Plaid sync provider request failed.');
                    }
                    return result || {};
                } catch (error) {
                    this.assertSyncActive(timing);
                    if (this.isMutation(error)) {
                        const mutation = new Error('Plaid sync changed during pagination.');
                        mutation.code = 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION';
                        mutation.error_code = mutation.code;
                        throw mutation;
                    }
                    if (this.mutationCode(error) === 'PRODUCT_NOT_READY') {
                        // A Sandbox transport may carry a branded,
                        // allowlisted diagnostic through this adapter. Keep
                        // that object so the runner can retain status/type/
                        // code/request-id metadata instead of reducing every
                        // readiness response to a bare error code.
                        let preservedNotReady = null;
                        try { preservedNotReady = this.preserveError ? this.preserveError(error) : null; } catch (_) { preservedNotReady = null; }
                        if (preservedNotReady && preservedNotReady.error === error) throw error;
                        const notReady = new Error('Plaid sync data is not ready; retry the sync.');
                        notReady.code = 'PRODUCT_NOT_READY';
                        notReady.error_code = 'PRODUCT_NOT_READY';
                        throw notReady;
                    }
                    let preserved = null;
                    try { preserved = this.preserveError ? this.preserveError(error) : null; } catch (_) { preserved = null; }
                    if (preserved) {
                        const preservedError = preserved.error || preserved;
                        const retryable = preserved.retryable !== false;
                        lastError = preservedError;
                        if (!retryable || attempt >= this.maxRetries) throw preservedError;
                        await this.sleep(this.backoffMs * (attempt + 1));
                        this.assertSyncActive(timing);
                        continue;
                    }
                    lastError = new Error('Plaid sync provider request failed.');
                    if (attempt >= this.maxRetries) throw lastError;
                    await this.sleep(this.backoffMs * (attempt + 1));
                    this.assertSyncActive(timing);
                }
            }
            throw lastError || new Error('Plaid sync failed.');
        }

        async normalizeTransaction(transaction, kind, index, cursor, connectionKey) {
            let item = transaction || {};
            const id = text(item.transaction_id || item.id);
            if (!id) throw new Error('Plaid transaction is missing transaction_id.');
            const rawAccountId = text(item.account_id || item.account);
            if (rawAccountId && this.ignoredAccountIds.has(rawAccountId)) return null;
            if (kind === 'removed' && (!item.date || item.amount === undefined || !item.account_id && !item.account)) {
                const prior = this.resolveRemoved ? await this.resolveRemoved(id, item) : null;
                if (!prior || !prior.date || prior.amount === undefined || !text(prior.account_id || prior.account)) throw new Error('Removed provider transaction could not be hydrated from accepted history.');
                item = { ...prior, ...item, date: item.date || prior.date, amount: item.amount === undefined ? prior.amount : item.amount, account_id: item.account_id || prior.account_id || prior.account };
            }
            if (!this.accountMap) throw new Error('Plaid account name mapping is not configured.');
            const accountId = text(item.account_id || item.account);
            const account = Object.prototype.hasOwnProperty.call(this.accountMap, accountId) ? text(this.accountMap[accountId]) : '';
            if (!account) {
                if (this.ignoredAccountIds.has(accountId)) return null;
                throw new Error('Plaid transaction account is not mapped.');
            }
            const currency = text(item.iso_currency_code || item.currency_code).toUpperCase();
            if (currency !== 'USD') throw new Error('Plaid transaction currency is not supported; USD is required.');
            const amount = Number(item.amount);
            if (!Number.isFinite(amount)) throw new Error('Plaid transaction amount is invalid.');
            const signedAmount = amount;
            const category = text(item.category || item.personal_finance_category && (item.personal_finance_category.primary || item.personal_finance_category.detailed) || 'Uncategorized');
            const classified = this.classify ? text(await this.classify({ kind, id, amount: signedAmount, category, name: text(item.name), merchantName: text(item.merchant_name), accountId, currency: 'USD', pending: item.pending === true })) : '';
            const categoryIncome = !classified && signedAmount < 0 && review.hasCheckingIncomeCategory(category);
            const checkingIncome = account === review.CHECKING_ACCOUNT_ALIAS && (classified === 'income' || categoryIncome);
            const type = checkingIncome || classified === 'income' ? 'income' : 'expense';
            const canonicalAmount = checkingIncome ? Math.abs(signedAmount) : signedAmount;
            const revision = `sha256:${observationDigest(kind, { ...item, classification: classified })}`;
            const linkedId = text(item.pending_transaction_id) || id;
            const candidate = {
                source: 'bank-provider', sourceIdentity: `plaid:${identityPart(connectionKey || 'connection')}:${identityPart(accountId)}:${identityPart(linkedId)}`, sourceRevision: revision,
                date: text(item.date), description: text(item.name || item.merchant_name || id),
                amount: canonicalAmount, account, payment_method: account, merchant: text(item.merchant_name || item.name || id), category,
                // Plaid's sign is preserved for expenses and non-checking
                // accounts. Checking income uses a positive canonical amount;
                // retain the provider sign only in a server-side staging hint
                // so sourceOriginal can preserve the raw observation.
                type, currency: 'USD', amendment: kind === 'removed' ? 'removed' : kind,
                ...(checkingIncome ? { providerSignedAmount: signedAmount } : {}),
                ...(classified === 'income' || classified === 'expense' ? { providerClassification: classified } : {}),
                ...(text(item.pending_transaction_id) ? { pendingTransactionId: text(item.pending_transaction_id) } : {}),
                providerPending: item.pending === true
            };
            if (!candidate.date) throw new Error('Provider transaction is missing a reviewable date.');
            candidate.id = `${candidate.sourceIdentity}@${candidate.sourceRevision}`;
            return candidate;
        }

        async fetchDelta(options) {
            const opts = options || {};
            if (!text(opts.accessToken)) throw new Error('Plaid sync requires a server-side access token resolver.');
            if (opts.cutoverDate && !validDate(opts.cutoverDate)) throw new Error('Plaid sync cutover date is invalid.');
            const existingSourceIdentities = new Set(Array.from(opts.existingSourceIdentities || [], value => text(value)).filter(Boolean));
            const originalCursor = text(opts.cursor);
            for (let restart = 0; restart <= this.maxMutationRestarts; restart += 1) {
                this.assertSyncActive(opts);
                const pages = [];
                let rawObservations = 0;
                let skippedObservations = 0;
                let cutoffExcluded = 0;
                let cursor = originalCursor;
                let hasMore = true;
                for (let page = 0; hasMore; page += 1) {
                    this.assertSyncActive(opts);
                    if (page >= this.maxPages) throw new Error('Plaid sync exceeded the page limit.');
                    let response;
                    try {
                        // Plaid's documented transactions/sync body contains
                        // only these fields. deadlineAt/signal are internal
                        // controls and travel as the second client argument.
                        const request = { access_token: opts.accessToken, cursor, count: 500 };
                        response = await this.call(request, { deadlineAt: opts.deadlineAt, signal: opts.signal });
                    } catch (error) {
                        if (!this.isMutation(error)) throw error;
                        if (restart >= this.maxMutationRestarts) throw new Error('Plaid sync changed during pagination too many times.');
                        hasMore = false;
                        pages.length = 0;
                        break;
                    }
                    if (this.isMutation(response)) {
                        if (restart >= this.maxMutationRestarts) throw new Error('Plaid sync changed during pagination too many times.');
                        hasMore = false;
                        pages.length = 0;
                        break;
                    }
                    const initialEmpty = !text(cursor)
                        && Array.isArray(response.added) && response.added.length === 0
                        && Array.isArray(response.modified) && response.modified.length === 0
                        && Array.isArray(response.removed) && response.removed.length === 0
                        && response.has_more === false && response.next_cursor === '';
                    if (initialEmpty) throw initialSyncPendingError();
                    if (!Array.isArray(response.added) || !Array.isArray(response.modified) || !Array.isArray(response.removed) || typeof response.has_more !== 'boolean' || typeof response.next_cursor !== 'string' || !text(response.next_cursor)) throw new Error('Plaid sync returned an incomplete page.');
                    rawObservations += response.added.length + response.modified.length + response.removed.length;
                    const records = [];
                    for (const [index, item] of response.added.entries()) {
                        const record = await this.normalizeTransaction(item, 'added', index, cursor, opts.connectionKey);
                        if (record) records.push(record); else skippedObservations += 1;
                    }
                    for (const [index, item] of response.modified.entries()) {
                        const record = await this.normalizeTransaction(item, 'modified', index, cursor, opts.connectionKey);
                        if (record) records.push(record); else skippedObservations += 1;
                    }
                    for (const [index, item] of response.removed.entries()) {
                        const record = await this.normalizeTransaction(item, 'removed', index, cursor, opts.connectionKey);
                        if (record) records.push(record); else skippedObservations += 1;
                    }
                    pages.push({ records });
                    const nextCursor = text(response.next_cursor);
                    if (hasMore && nextCursor === cursor) throw new Error('Plaid sync cursor did not advance.');
                    cursor = nextCursor;
                    hasMore = response.has_more === true;
                    if (opts.cutoverDate) {
                        // The initial cutover applies to new observations only.
                        // A modified or removed observation whose stable source
                        // The cutover gates new observations. An older
                        // amendment/removal remains reviewable only when its
                        // stable source identity is already accepted or
                        // pending, so an unknown historical change cannot be
                        // misread as a new purchase.
                        const beforeCutover = pages[pages.length - 1].records.length;
                        pages[pages.length - 1].records = pages[pages.length - 1].records.filter(record =>
                            record.date >= text(opts.cutoverDate) ||
                            (record.amendment !== 'added' && existingSourceIdentities.has(text(record.sourceIdentity)))
                        );
                        cutoffExcluded += beforeCutover - pages[pages.length - 1].records.length;
                    }
                    if (!hasMore) return {
                        pages,
                        cursor,
                        counts: {
                            rawObservations,
                            skippedObservations,
                            cutoffExcluded,
                            resultingRecords: pages.reduce((count, page) => count + page.records.length, 0)
                        }
                    };
                }
            }
            throw new Error('Plaid sync did not complete.');
        }
    }

    class OnOpenSyncService {
        constructor(options) {
            const opts = options || {};
            this.enabled = opts.enabled === true;
            this.provider = opts.provider || new review.DisabledProviderAdapter('Provider retrieval is disabled until live setup is authorized.');
            this.cutoverDate = text(opts.cutoverDate);
            this.accountAliases = Object.freeze(opts.accountAliases && typeof opts.accountAliases === 'object' && !Array.isArray(opts.accountAliases) ? { ...opts.accountAliases } : {});
            this.clock = typeof opts.clock === 'function' ? opts.clock : () => Date.now();
            this.cooldownMs = opts.cooldownMs;
            this.coordinator = opts.coordinator || null;
            this.coordinators = new Map();
            this.repository = opts.repository || new review.InMemorySyncRepository({ cooldownMs: this.cooldownMs });
            this.reviewBackend = opts.reviewBackend || null;
            this.connectionResolver = typeof opts.connectionResolver === 'function' ? opts.connectionResolver : null;
            this.authorize = typeof opts.authorize === 'function' ? opts.authorize : async auth => {
                if (!auth || auth.tokenVerified !== true || !text(auth.uid) || !text(auth.email)) throw new Error('Authenticated server authorization is required.');
                return auth;
            };
            this.connectionOwner = typeof opts.connectionOwner === 'function' ? opts.connectionOwner : null;
            this.connectionOwners = opts.connectionOwners || {};
            this.connectionEnabled = typeof opts.connectionEnabled === 'function' ? opts.connectionEnabled : null;
            this.connectionDisabled = opts.connectionDisabled || {};
            this.syncReadiness = typeof opts.syncReadiness === 'function' ? opts.syncReadiness : null;
            this.maxDurationMs = Number.isSafeInteger(opts.maxDurationMs) && opts.maxDurationMs > 0 ? opts.maxDurationMs : null;
        }

        coordinatorFor(connection) {
            if (this.coordinator) return this.coordinator;
            const key = text(connection);
            if (!this.coordinators.has(key)) this.coordinators.set(key, new review.SyncCoordinator({ cooldownMs: this.cooldownMs, now: this.clock }));
            return this.coordinators.get(key);
        }

        async knownProviderSourceIdentities(user) {
            if (!this.reviewBackend || typeof this.reviewBackend.exportState !== 'function') return [];
            const snapshot = await this.reviewBackend.exportState(user);
            const entries = Array.isArray(snapshot && snapshot.transactions)
                ? snapshot.transactions
                : Array.isArray(snapshot && snapshot.accepted)
                    ? snapshot.accepted.map(entry => Array.isArray(entry) ? entry[1] : entry)
                    : [];
            const pending = Array.isArray(snapshot && snapshot.pending)
                ? snapshot.pending.map(entry => Array.isArray(entry) ? entry[1] : entry)
                : [];
            return [...entries, ...pending].map(item => text(item && item.sourceIdentity)).filter(Boolean);
        }

        async runOnOpen(auth, connectionKey, options) {
            if (!this.enabled || !validDate(this.cutoverDate)) throw new Error('On-open sync is fail-closed until provider, cutover and security setup are configured.');
            const user = await this.authorize(auth);
            const opts = options || {};
            const connection = text(connectionKey);
            if (!connection) throw new Error('Sync connection key is required.');
            let thisRunCutoverDate = this.cutoverDate;
            let thisRunCutoverRevision = null;
            if (this.syncReadiness) {
                const readiness = await this.syncReadiness(user, connection);
                if (!readiness || readiness.ready !== true || !validDate(readiness.cutoffDate)) throw new Error('Sync activation is not ready.');
                // Pin the authenticated runtime setting for this run. A later
                // settings update applies only to the next run and cannot
                // change the provider request or cursor fence in flight.
                thisRunCutoverDate = text(readiness.cutoffDate);
                thisRunCutoverRevision = Number.isSafeInteger(readiness.cutoffRevision) ? readiness.cutoffRevision : readiness.revision;
            }
            const runId = text(opts.runId || uniqueRunId(connection, this.clock));
            const now = Date.now();
            const requestedDeadline = Number.isSafeInteger(opts.deadlineAt) ? opts.deadlineAt : null;
            const boundedDeadline = this.maxDurationMs ? now + this.maxDurationMs : null;
            const deadlineAt = boundedDeadline === null ? requestedDeadline : requestedDeadline === null ? boundedDeadline : Math.min(requestedDeadline, boundedDeadline);
            const enabled = this.connectionEnabled ? await this.connectionEnabled(connection, user) : this.connectionDisabled[connection] !== true;
            if (!enabled) throw new Error('Provider connection is disabled by server configuration.');
            const owner = this.connectionOwner ? await this.connectionOwner(connection) : this.connectionOwners[connection];
            if (!owner) throw new Error('Provider connection ownership is not configured.');
            if (text(owner) !== text(user.uid) && text(owner).toLowerCase() !== text(user.email).toLowerCase()) throw new Error('User is not authorized for this provider connection.');
            const coordinator = this.coordinatorFor(connection);
            coordinator.begin(runId);
            let lease;
            try {
                lease = await this.repository.acquireLease(connection, runId, { now: this.clock(), ttlMs: opts.leaseMs });
                const storedCursor = await this.repository.getCursor(connection);
                const cursor = storedCursor && storedCursor.cursor ? storedCursor.cursor : null;
                const connectionAuth = this.connectionResolver ? await this.connectionResolver(connection, clone(user)) : {};
                const existingSourceIdentities = thisRunCutoverDate ? await this.knownProviderSourceIdentities(user) : [];
                const result = await this.provider.fetchDelta({ connectionKey: connection, cursor, cutoverDate: thisRunCutoverDate, cutoffRevision: thisRunCutoverRevision, existingSourceIdentities, user: clone(user), ...(deadlineAt === null ? {} : { deadlineAt }), ...(connectionAuth || {}) });
                if (!result || !Array.isArray(result.pages) || !text(result.cursor)) throw new Error('Provider returned an incomplete paginated delta.');
                const expectedIds = [];
                for (const [index, page] of result.pages.entries()) {
                    if (!page || !Array.isArray(page.records)) throw new Error(`Provider page ${index + 1} is invalid.`);
                    await this.repository.stagePage(runId, page.records);
                    page.records.forEach(record => { if (record && record.id) expectedIds.push(record.id); });
                }
                if (this.reviewBackend && expectedIds.length) {
                    const providerRecords = result.pages.flatMap(page => page.records || []).map(record => ({ ...record, source: 'bank-provider' }));
                    await this.reviewBackend.stage(user, providerRecords, { source: 'bank-provider', serverIngest: true, batchId: runId, batchMeta: { syncRunId: runId, connectionKey: connection, ids: expectedIds } });
                }
                const published = await this.repository.publishCursor(runId, result.cursor, expectedIds, connection, { now: this.clock() });
                coordinator.finish(runId, true);
                return { runId, lease, cursor: published.cursor, staged: expectedIds.length, cutoffDate: thisRunCutoverDate, cutoffRevision: thisRunCutoverRevision };
            } catch (error) {
                try { coordinator.finish(runId, false); } catch (_) { /* Preserve the provider error. */ }
                throw error;
            } finally {
                if (lease) {
                    try { await this.repository.releaseLease(connection, runId); } catch (_) { /* Expired leases are recoverable. */ }
                }
            }
        }
    }

    const api = Object.freeze({
        KeyedMutex,
        ProtectedReviewBackend,
        DurableProtectedReviewBackend,
        FirestoreReviewRepository,
        FirestoreSyncRepository,
        BrowserApprovalClient,
        PlaidTransactionsSyncAdapter,
        createProtectedSyncSettings,
        verifyFirebaseAuthorization,
        createHttpHandler,
        OnOpenSyncService
    });
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.TransactionBackend = api;
})(typeof globalThis === 'undefined' ? this : globalThis);

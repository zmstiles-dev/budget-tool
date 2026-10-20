/*
 * Local composition entry point for the Firebase-adjacent approval service.
 * It accepts injected Firestore/Admin/provider dependencies so tests can run
 * without credentials or a live bank connection.
 */
'use strict';

const backendApi = require('./transaction-backend.js');
const reviewApi = require('./transaction-review.js');
const appConfig = require('./transaction-config.js');

function createBudgetService(options) {
    const opts = options || {};
    const hasCutoverOverride = Object.prototype.hasOwnProperty.call(opts, 'cutoverDate');
    // A caller-supplied null, undefined, or malformed value remains visible to
    // OnOpenSyncService and therefore fails closed. Only omission uses the
    // recorded first-sync date.
    const cutoverDate = hasCutoverOverride ? opts.cutoverDate : appConfig.FIRST_SYNC_CUTOVER_DATE;
    const accountAliases = opts.accountAliases && typeof opts.accountAliases === 'object' && !Array.isArray(opts.accountAliases)
        ? { ...opts.accountAliases }
        : { ...appConfig.legacyAccountAliases };
    let backend = opts.backend;
    if (!backend) {
        const repository = opts.repository || (opts.db ? new backendApi.FirestoreReviewRepository({
            db: opts.db,
            householdId: opts.householdId,
            collection: opts.reviewCollection,
            acceptedCollection: opts.acceptedCollection,
            acceptedDocumentId: opts.acceptedDocumentId || 'data'
        }) : null);
        backend = repository ? new backendApi.DurableProtectedReviewBackend({
            repository,
            householdId: opts.householdId,
            allowedUsers: opts.allowedUsers,
            allowedUserIds: opts.allowedUserIds,
            allowExistingAppUserClaim: opts.allowExistingAppUserClaim,
            clock: opts.clock,
            initialState: opts.initialState
        }) : new backendApi.ProtectedReviewBackend({
            householdId: opts.householdId,
            allowedUsers: opts.allowedUsers,
            allowedUserIds: opts.allowedUserIds,
            allowExistingAppUserClaim: opts.allowExistingAppUserClaim,
            clock: opts.clock,
            initialState: opts.initialState
        });
    }
    const syncRepository = opts.syncRepository || (opts.db ? new backendApi.FirestoreSyncRepository({ db: opts.db, cooldownMs: opts.cooldownMs }) : new reviewApi.InMemorySyncRepository({ cooldownMs: opts.cooldownMs }));
    const syncService = opts.syncService || new backendApi.OnOpenSyncService({
        enabled: opts.syncEnabled === true,
        cutoverDate,
        accountAliases,
        provider: opts.provider || new reviewApi.DisabledProviderAdapter('Provider retrieval is disabled until an injected adapter is configured.'),
        repository: syncRepository,
        reviewBackend: backend,
        // The backend policy validates the raw Admin-verified context and
        // returns a reduced actor object. Preserve the trusted verification
        // marker for the subsequent provider-stage/export calls in one sync
        // request; never add it before the policy check.
        authorize: opts.authorize || (auth => {
            const authorized = backend.authorize(auth);
            return { ...authorized, tokenVerified: auth && auth.tokenVerified === true, existingAppUser: auth && auth.existingAppUser === true };
        }),
        connectionOwner: opts.connectionOwner,
        connectionOwners: opts.connectionOwners,
        connectionResolver: opts.connectionResolver,
        connectionEnabled: opts.connectionEnabled,
        connectionDisabled: opts.connectionDisabled,
        syncReadiness: opts.syncReadiness,
        maxDurationMs: opts.maxDurationMs,
        cooldownMs: opts.cooldownMs,
        clock: opts.clock
    });
    const syncSettings = opts.syncSettings || (opts.db && typeof backendApi.createProtectedSyncSettings === 'function' ? backendApi.createProtectedSyncSettings({
        db: opts.db,
        householdId: opts.householdId,
        requiredConnectionKeys: opts.syncConnectionKeys,
        configCollection: opts.syncConfigCollection,
        configDocument: opts.syncConfigDocument,
        connectionsCollection: opts.syncConnectionsCollection,
        fallbackCutoverDate: appConfig.FIRST_SYNC_CUTOVER_DATE,
        syncReadiness: opts.syncReadiness,
        clock: opts.clock,
        authorize: opts.authorize || (auth => backend.authorize(auth))
    }) : null);
    const handler = opts.handler || backendApi.createHttpHandler({
        backend,
        syncService,
        authenticate: opts.authenticate,
        admin: opts.admin,
        allowedUsers: opts.allowedUsers,
        householdId: opts.householdId,
        householdForUser: opts.householdForUser,
        syncReadiness: opts.syncReadiness,
        syncSettings,
        allowedOrigins: opts.allowedOrigins,
        maxBodyBytes: opts.maxBodyBytes,
        errorDiagnostic: opts.errorDiagnostic
    });
    return { backend, syncRepository, syncService, syncSettings, handler, accountAliases, cutoverDate };
}

module.exports = { createBudgetService };

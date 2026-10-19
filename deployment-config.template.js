/*
 * Non-secret frontend deployment defaults. This file is loaded before the app
 * bootstraps Firebase. Every value is only a default so the local bridge,
 * emulator harnesses, or an explicitly injected test endpoint remain the
 * authority for their own run.
 *
 * Link and sync stay disabled until the separately reviewed backend rollout
 * applies the matching server gates and protected membership configuration.
 */
(function applyBudgetDeploymentDefaults(global) {
    if (!global) return;
    const defaults = {
        // The Netlify site URL and site ID are assigned only during the approved
        // backend/frontend cutover. An unknown endpoint must fail closed.
        TRANSACTION_APPROVAL_ENDPOINT: 'https://stiles-budget-tool.netlify.app/.netlify/functions/budgetTransactions',
        TRANSACTION_LINK_ENABLED: false,
        TRANSACTION_SYNC_ENABLED: false,
        TRANSACTION_LINK_CONNECTIONS: [],
        TRANSACTION_SYNC_CONNECTIONS: []
    };
    Object.keys(defaults).forEach(key => {
        if (global[key] === undefined) global[key] = defaults[key];
    });
    global.__BUDGET_TOOL_DEPLOYMENT_CONFIG__ = Object.freeze({
        endpoint: String(global.TRANSACTION_APPROVAL_ENDPOINT || ''),
        linkEnabled: global.TRANSACTION_LINK_ENABLED === true,
        syncEnabled: global.TRANSACTION_SYNC_ENABLED === true
    });
    if (typeof module === 'object' && module.exports) module.exports = defaults;
})(typeof window !== 'undefined' ? window : globalThis);

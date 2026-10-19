/*
 * Non-secret frontend deployment defaults. This file is loaded before the app
 * bootstraps Firebase. Every value is only a default so the local bridge,
 * emulator harnesses, or an explicitly injected test endpoint remain the
 * authority for their own run.
 *
 * The reviewed Link-only frontend candidate enables the two explicit connection
 * keys. Sync stays disabled until its separate backend activation approval.
 */
(function applyBudgetDeploymentDefaults(global) {
    if (!global) return;
    const defaults = {
        // The Netlify site URL and site ID are assigned only during the approved
        // backend/frontend cutover. An unknown endpoint must fail closed.
        TRANSACTION_APPROVAL_ENDPOINT: 'https://stiles-budget-tool.netlify.app/.netlify/functions/budgetTransactions',
        TRANSACTION_LINK_ENABLED: true,
        TRANSACTION_SYNC_ENABLED: false,
        TRANSACTION_LINK_CONNECTIONS: ['chase', 'capital-one'],
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

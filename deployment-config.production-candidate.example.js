/*
 * Reviewed frontend cutover candidate. This file is intentionally not loaded
 * by index.html and must not replace deployment-config.template.js until the
 * backend, rules, site visibility, and authenticated review checks have been
 * approved together.
 *
 * It only exposes a namespaced candidate object when loaded in a browser; it
 * never assigns TRANSACTION_* globals, so copying this file into the checkout
 * cannot activate the endpoint by accident.
 */
(function exposeProductionCutoverCandidate(global) {
    const candidate = Object.freeze({
        siteId: 'a429bdf1-47c9-4bb0-9e9d-7f5cdf8d416d',
        siteHost: 'stiles-budget-tool.netlify.app',
        endpoint: 'https://stiles-budget-tool.netlify.app/.netlify/functions/budgetTransactions',
        origin: 'https://zmstiles-dev.github.io',
        TRANSACTION_APPROVAL_ENDPOINT: 'https://stiles-budget-tool.netlify.app/.netlify/functions/budgetTransactions',
        TRANSACTION_LINK_ENABLED: false,
        TRANSACTION_SYNC_ENABLED: false,
        TRANSACTION_LINK_CONNECTIONS: Object.freeze([]),
        TRANSACTION_SYNC_CONNECTIONS: Object.freeze([])
    });
    if (typeof module === 'object' && module.exports) module.exports = candidate;
    else if (global) global.__BUDGET_TOOL_PRODUCTION_CUTOVER_CANDIDATE__ = candidate;
})(typeof window !== 'undefined' ? window : null);

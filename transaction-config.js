/*
 * Non-secret application configuration shared by the browser and the
 * Firebase-adjacent service composition. Provider account IDs are deliberately
 * absent: the aliases below are the existing CSV/display mappings only.
 */
(function (root, factory) {
    'use strict';
    const config = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = config;
    else root.TransactionConfig = config;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
    'use strict';

    const legacyAccountAliases = Object.freeze({
        '4720': 'CFF',
        '4004': 'CFU',
        '9981': 'CSP',
        '1963': 'CSP',
        '0071': 'Ven X',
        '71': 'Ven X',
        '7418': 'Ven X',
        '0820': 'Checking Account'
    });
    const accountDisplayNames = Object.freeze([...new Set(Object.values(legacyAccountAliases))]);
    return Object.freeze({
        FIRST_SYNC_CUTOVER_DATE: '2026-10-09',
        DEFAULT_SYNC_ENABLED: false,
        legacyAccountAliases,
        accountDisplayNames
    });
});

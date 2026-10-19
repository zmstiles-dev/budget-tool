'use strict';

const config = require('../deployment-config.template.js');
const expectedEndpoint = 'https://stiles-budget-tool.netlify.app/.netlify/functions/budgetTransactions';
if (config.TRANSACTION_APPROVAL_ENDPOINT !== expectedEndpoint) throw new Error('Deployment endpoint template drifted from the approved target.');
if (config.TRANSACTION_LINK_ENABLED !== true || config.TRANSACTION_SYNC_ENABLED !== false) throw new Error('Deployment config preview must enable approved Link-only mode while keeping sync disabled.');
if (JSON.stringify(config.TRANSACTION_LINK_CONNECTIONS) !== JSON.stringify(['chase', 'capital-one']) || config.TRANSACTION_SYNC_CONNECTIONS.length !== 0) throw new Error('Deployment config preview has unexpected connection allowlists.');
process.stdout.write(`${JSON.stringify({
    endpoint: config.TRANSACTION_APPROVAL_ENDPOINT,
    linkEnabled: config.TRANSACTION_LINK_ENABLED,
    syncEnabled: config.TRANSACTION_SYNC_ENABLED,
    linkConnections: config.TRANSACTION_LINK_CONNECTIONS,
    syncConnections: config.TRANSACTION_SYNC_CONNECTIONS
}, null, 2)}\n`);

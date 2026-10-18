'use strict';

const config = require('../deployment-config.template.js');
const expectedEndpoint = '';
if (config.TRANSACTION_APPROVAL_ENDPOINT !== expectedEndpoint) throw new Error('Deployment endpoint template drifted from the approved target.');
if (config.TRANSACTION_LINK_ENABLED !== false || config.TRANSACTION_SYNC_ENABLED !== false) throw new Error('Deployment config preview must keep provider gates disabled.');
process.stdout.write(`${JSON.stringify({
    endpoint: config.TRANSACTION_APPROVAL_ENDPOINT,
    linkEnabled: config.TRANSACTION_LINK_ENABLED,
    syncEnabled: config.TRANSACTION_SYNC_ENABLED,
    linkConnections: config.TRANSACTION_LINK_CONNECTIONS,
    syncConnections: config.TRANSACTION_SYNC_CONNECTIONS
}, null, 2)}\n`);

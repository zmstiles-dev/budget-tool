'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const candidatePath = path.join(root, 'deployment-config.production-candidate.example.js');
const templatePath = path.join(root, 'deployment-config.template.js');
const indexSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const candidate = require(candidatePath);
const template = require(templatePath);

assert.equal(candidate.siteId, 'a429bdf1-47c9-4bb0-9e9d-7f5cdf8d416d');
assert.equal(candidate.siteHost, 'stiles-budget-tool.netlify.app');
assert.equal(candidate.endpoint, 'https://stiles-budget-tool.netlify.app/.netlify/functions/budgetTransactions');
assert.equal(candidate.origin, 'https://zmstiles-dev.github.io');
assert.equal(candidate.TRANSACTION_APPROVAL_ENDPOINT, candidate.endpoint);
assert.equal(candidate.TRANSACTION_LINK_ENABLED, false);
assert.equal(candidate.TRANSACTION_SYNC_ENABLED, false);
assert.deepEqual(candidate.TRANSACTION_LINK_CONNECTIONS, []);
assert.deepEqual(candidate.TRANSACTION_SYNC_CONNECTIONS, []);

assert.equal(template.TRANSACTION_APPROVAL_ENDPOINT, candidate.endpoint);
assert.equal(template.TRANSACTION_LINK_ENABLED, false);
assert.equal(template.TRANSACTION_SYNC_ENABLED, false);
assert.deepEqual(template.TRANSACTION_LINK_CONNECTIONS, []);
assert.deepEqual(template.TRANSACTION_SYNC_CONNECTIONS, []);
assert.match(indexSource, /deployment-config\.template\.js/);
assert.doesNotMatch(indexSource, /deployment-config\.production-candidate\.example\.js/);

const activeBrowser = {};
vm.runInNewContext(fs.readFileSync(templatePath, 'utf8'), { window: activeBrowser });
assert.equal(activeBrowser.TRANSACTION_APPROVAL_ENDPOINT, candidate.endpoint);
assert.equal(activeBrowser.TRANSACTION_LINK_ENABLED, false);
assert.equal(activeBrowser.TRANSACTION_SYNC_ENABLED, false);
assert.deepEqual(Array.from(activeBrowser.TRANSACTION_LINK_CONNECTIONS), []);
assert.deepEqual(Array.from(activeBrowser.TRANSACTION_SYNC_CONNECTIONS), []);
assert.equal(activeBrowser.__BUDGET_TOOL_DEPLOYMENT_CONFIG__.endpoint, candidate.endpoint);
assert.equal(activeBrowser.__BUDGET_TOOL_DEPLOYMENT_CONFIG__.linkEnabled, false);
assert.equal(activeBrowser.__BUDGET_TOOL_DEPLOYMENT_CONFIG__.syncEnabled, false);

const browser = { TRANSACTION_APPROVAL_ENDPOINT: '', TRANSACTION_LINK_ENABLED: false, TRANSACTION_SYNC_ENABLED: false };
vm.runInNewContext(fs.readFileSync(candidatePath, 'utf8'), { window: browser });
assert.equal(browser.TRANSACTION_APPROVAL_ENDPOINT, '', 'candidate must not activate the endpoint');
assert.equal(browser.TRANSACTION_LINK_ENABLED, false);
assert.equal(browser.TRANSACTION_SYNC_ENABLED, false);
assert.equal(browser.__BUDGET_TOOL_PRODUCTION_CUTOVER_CANDIDATE__.endpoint, candidate.endpoint);

console.log('PASS: production endpoint candidate is exact, namespaced, disabled, and excluded from frontend bootstrap.');

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
// Single-attempt official file-digest API transport. The SDK retries mutations
// on some network failures; use it only as the CLI's credential bootstrap.
function transport(settings, token, fetchImpl = globalThis.fetch) {
    if (typeof token !== 'string' || !token) throw new Error('Approved private CLI authentication is required.');
    const site = `/api/v1/sites/${settings.siteId}`, id = value => /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value);
    async function request(method, route, body) {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
        try {
            const response = await fetchImpl(`https://api.netlify.com${route}`, { method, redirect: 'error', signal: controller.signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' } : {}) }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
            let value; try { value = await response.json(); } catch (_) { value = {}; }
            if (!response.ok) { const error = new Error('Netlify returned a non-success response.'); error.httpStatus = response.status; if (method === 'POST' && id(value.id)) error.deployId = value.id; throw error; }
            return value;
        } finally { clearTimeout(timer); }
    }
    return Object.freeze({
        getSite: () => request('GET', site),
        getDeploy: deployId => { if (!id(deployId)) throw new Error('Invalid bound deployment ID.'); return request('GET', `/api/v1/deploys/${deployId}`); },
        functions: () => request('GET', `${site}/functions`), files: () => request('GET', `${site}/files`),
        create: body => request('POST', `${site}/deploys`, body),
        upload: (deployId, bytes, contract) => { if (!id(deployId) || contract.runtime !== settings.runtime || contract.invocationMode !== settings.invocationMode) throw new Error('Invalid bound function upload.'); return request('PUT', `/api/v1/deploys/${deployId}/functions/${settings.functionName}?runtime=${settings.runtime}&invocation_mode=${settings.invocationMode}`, bytes); }
    });
}
async function fromApprovedCli(settings) {
    for (const name of ['NETLIFY_AUTH_TOKEN', 'NETLIFY_API_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NODE_PATH', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED']) if (process.env[name]) throw new Error('Use a sanitized approved operator process.');
    const cliRoot = process.env.BUDGET_NETLIFY_CLI_ROOT, authHome = process.env.BUDGET_NETLIFY_AUTH_HOME;
    if (!cliRoot || !authHome || process.platform === 'win32' && (!/^D:[\\/]/i.test(cliRoot) || !/^D:[\\/]/i.test(authHome))) throw new Error('Explicit private D: CLI and auth roots are required.');
    if (JSON.parse(fs.readFileSync(path.join(cliRoot, 'node_modules/netlify-cli/package.json'))).version !== settings.officialCliVersion) throw new Error('Netlify CLI version differs from reviewed policy.');
    if (!fs.existsSync(path.join(authHome, 'appdata/netlify/Config/config.json'))) throw new Error('Approved private CLI auth store is unavailable; connect it separately.');
    process.env.APPDATA = path.join(authHome, 'appdata'); process.env.LOCALAPPDATA = path.join(authHome, 'localappdata');
    for (const name of ['TEMP', 'TMP', 'TMPDIR']) process.env[name] = path.join(authHome, 'temp');
    const helpers = await import(pathToFileURL(path.join(cliRoot, 'node_modules/netlify-cli/dist/utils/command-helpers.js')).href);
    const pair = await helpers.getToken(), token = Array.isArray(pair) ? pair[0] : pair;
    return transport(settings, token);
}
module.exports = { transport, fromApprovedCli };

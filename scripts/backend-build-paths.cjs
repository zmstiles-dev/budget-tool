'use strict';
const fs = require('node:fs');
const path = require('node:path');
function buildPaths(root, environment = process.env) {
    const temp = path.resolve(environment.BUDGET_BUILD_TEMP || path.join(root, '.local', 'temp'));
    const cache = path.resolve(environment.BUDGET_NPM_CACHE || path.join(root, '.local', 'npm-cache'));
    for (const target of [temp, cache]) {
        if (process.platform === 'win32' && path.parse(target).root.toLowerCase() !== 'd:\\') throw new Error('Backend build storage must be on D:.');
        fs.mkdirSync(target, { recursive: true });
        if (fs.lstatSync(target).isSymbolicLink() || fs.realpathSync(target) !== target) throw new Error('Unsafe backend build storage path.');
    }
    return { temp, cache };
}
module.exports = { buildPaths };

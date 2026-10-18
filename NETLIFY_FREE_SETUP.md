# Netlify Free setup guide

This guide is for a later authorized operator. The approved future site
display name is `Stiles-Budget-Tool`, with proposed normalized slug
`stiles-budget-tool`. No site currently exists; its ID and production
hostname must come from the approved site-creation response and must never be
guessed. The guide is intentionally written without actual user IDs, emails,
credentials, site IDs, provider secrets, or production values. The current
checkout is a local, disabled-by-default implementation.

## Before setup

The reviewed Netlify account dashboard shows the Free plan with 300 monthly
credits and zero existing projects. No site exists for this application. The
visible site-creation surface currently exposes AI, Git, or upload choices but
no empty-site creation control. Therefore the first-publish sequence below is
conditional on a separately approved private human operator API/CLI flow that
can create an empty site and configure it before publishing. This guide does
not grant, read, or use those credentials.

Confirm that the isolated Netlify site is the approved project and that the
current Free plan still provides the documented 300 monthly credits with hard
pause at exhaustion and no automatic paid overage. Current published rates are
15 credits per successful production deploy, 10 per GB-hour compute, 20 per GB
bandwidth, and 2 per 10,000 requests. Failed deploys have no deploy-credit
charge. Preview and branch deploys have no deploy-credit charge, but their
traffic, compute, and bandwidth still consume credits, so this path does not
use them. The current public plan page does not establish a card requirement;
stop the setup if signup or site configuration requests payment. Do not add a
billing account to the Firebase project.

Credit use includes authenticated review, CORS preflight, Link, and sync
requests. The published compute expression is
`10 * allocated_GB * total_request_seconds / 3600`, plus 20 credits per GB of
response data, 2 credits per 10,000 requests, and 15 credits per production
release. For example, 1,000 five-second calls with 1 GB allocated compute and 1 GB of
response data, plus one release, are about 49 credits (13.89 compute + 20
bandwidth + 0.2 request + 15 release). The same 1,000 calls at 60 seconds,
with the same 1 GB response total, are about 202 credits. These are arithmetic
examples rather than a quota or availability promise.
Deduplicate normal opens and use bounded cooldowns while preserving pending
state. Credit exhaustion must pause the project and never trigger a paid
upgrade.

Use a manual trusted artifact. Do not use the Netlify AI agent, connect Git,
enable automatic builds, allow fork/PR/preview deploys, add build plugins, or
place credentials in a preview. Free environment variables are not
Functions-only scoped. The runtime's production context guard is an
additional check, not a substitute for trusted artifact handling.

## Build the artifact locally

From a fresh checkout, use Node 24 and prime the reviewed production
dependency lock before running the packaging scripts. Keep npm temporary files
on D: for this process:

```powershell
$env:TEMP = 'D:\Documents\Codex\.assistant-storage\temp'
$env:TMP = 'D:\Documents\Codex\.assistant-storage\temp'
$env:TMPDIR = 'D:\Documents\Codex\.assistant-storage\temp'
node --version  # must report Node 24.x
npm --prefix netlify ci --ignore-scripts --cache D:\Documents\Codex\.assistant-storage\npm-cache
node scripts/prepare-netlify.cjs
node scripts/bundle-netlify.cjs
```

The locked public package install primes the local offline production stage;
it does not install Netlify CLI, authenticate to Netlify, upload, or deploy.

The bundle script copies the checked-in `netlify/package.json` and
`netlify/package-lock.json` into a D: staging directory and runs
`npm ci --omit=dev --ignore-scripts --offline` against the approved D: npm
cache before invoking the pinned Netlify bundler. The artifact manifest records
the resulting production lock hash; do not substitute an unlocked install.

Review the generated `netlify/functions/_runtime/manifest.json` and
`netlify/.artifact/manifest.json`. The runtime manifest must list only the five
allowlisted source files plus its local CommonJS boundary `package.json`. The artifact manifest must name the Admin14.5,
Plaid38.1, esbuild, and zip-it-and-ship-it versions and record the complete ZIP
inventory. The deployable upload is `netlify/.artifact/budgetTransactions.zip`;
the sibling `netlify/.artifact/functions/` files are inspection copies. The
public directory must contain only `.gitkeep`. The generated runtime and
artifact are ignored by Git and must be included only in the manually assembled
deployment artifact. Do not copy the private roster, exports, statements,
backups, environment files, budget data, or logs.

The checked-in `netlify/netlify.toml` has no hosted build command. It describes
the `netlify/public` and `netlify/functions` directories for a trusted manual
artifact. Netlify's default region and memory are used; no paid-only override
is configured. Node 24 is the selected runtime.

## Future manual function upload

The lowest-credit first real deployment sequence is conditional on the
separately approved private operator API/CLI flow: create the empty isolated
site as `Stiles-Budget-Tool` with proposed slug `stiles-budget-tool`, record
the returned site ID and production hostname, enter the approved nonsecret
runtime setting and private human-entered secrets, then publish the reviewed
function ZIP once. A successful production publish
costs 15 credits. A failed deploy costs no deploy credits. If site creation or
configuration requires a published placeholder first, that placeholder counts
as the first production deploy and a later configured publish would make two
successful deploys (30 credits). Do not use previews or branch deploys: they
have no deploy-credit charge but still consume traffic, compute, and bandwidth
credits. No site upload or deployment is performed by this guide. The current
plan references are [Netlify pricing](https://www.netlify.com/pricing/),
[credit-based pricing plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/),
and [How credits work](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/).

After a separate operator approval, upload the reviewed function ZIP through
Netlify's documented file-digest API. The operator first submits a deploy
manifest to `POST /api/v1/sites/{site_id}/deploys` with a `functions` entry
whose `budgetTransactions` value is the SHA-256 digest of
`budgetTransactions.zip`. After Netlify returns the deploy ID, upload the ZIP
bytes to
`PUT /api/v1/deploys/{deploy_id}/functions/budgetTransactions?runtime=nodejs24.x&invocation_mode=stream`.
The deploy manifest must also carry a `functions_config` entry for
`budgetTransactions` with `runtime: nodejs24.x`, `invocation_mode: stream`, and
`build_data` identifying the v2 API and bootstrap version. The reviewed
archive's generated function metadata records the same contract:
`runtimeAPIVersion=2`, `runtimeVersion=nodejs24.x`, `invocationMode=stream`,
`entryFilename=___netlify-entry-point.mjs`, and the ZISI v2 bootstrap version.
Verify those values in
`netlify/.artifact/manifest.json` before upload; do not substitute a legacy
named `handler` entry or a callback/event invocation contract.
Use a private approved API credential supplied by the operator; never put it in
this repository, chat, command arguments, logs, or a hosted build. The
whole-site ZIP endpoint is a static-site deployment method and is not the
function upload path described here. Do not run either request during local
readiness work. See Netlify's [file-digest deployment API guide](https://docs.netlify.com/api-and-cli-guides/api-guides/get-started-with-api/#file-digest-method)
for the current request authentication and response details.

## Enter approved configuration

The operator must first record the actual site ID and production hostname in
the approval record, then enter them as `BUDGET_NETLIFY_SITE_ID` and
`BUDGET_NETLIFY_SITE_HOST`. Unknown or guessed values must remain unset. The
function rejects missing, preview, unpublished, old-deploy, and wrong-site
contexts before reading credentials.

Before the first approved function upload, select the nonsecret Netlify site
environment setting `AWS_LAMBDA_JS_RUNTIME=nodejs24.x` in the site UI. This
runtime selection is a platform setting rather than a `netlify.toml` build
command; verify it on the approved site before uploading the prebuilt ZIP.
Do not execute that setting change during local readiness work.

Required nonsecret configuration is:

```text
BUDGET_NETLIFY_SITE_ID=<approved site ID>
BUDGET_NETLIFY_SITE_HOST=<approved production hostname>
BUDGET_FIREBASE_PROJECT_ID=budget-tool-sync
BUDGET_HOUSEHOLD_ID=<approved protected household ID>
BUDGET_CONNECTION_KEYS=chase,capital-one
BUDGET_ACTIVE_CONNECTION_KEYS=
BUDGET_LINK_ENABLED=false
BUDGET_SYNC_ENABLED=false
```

Provider values stay unset until their separate approval:

```text
BUDGET_EXPECTED_INSTITUTION_CHASE=<verified institution ID>
BUDGET_EXPECTED_INSTITUTION_CAPITAL_ONE=<verified institution ID>
BUDGET_PLAID_CLIENT_ID=<approved client ID>
PLAID_REDIRECT_URI=https://zmstiles-dev.github.io/<approved OAuth path>
```

Enter secret values only through the approved Netlify site mechanism, never in
chat, source, command arguments, logs, or build output:

```text
BUDGET_FIREBASE_CLIENT_EMAIL=<runtime credential value>
BUDGET_FIREBASE_PRIVATE_KEY=<runtime credential value>
BUDGET_TOKEN_CURRENT_KEY_ID=<active AES key ID>
BUDGET_TOKEN_KEYRING_JSON=<bounded JSON of base64url AES-256 keys>
BUDGET_PLAID_CLIENT_SECRET=<only after Link approval>
```

The runtime uses Firebase Admin14 with the existing project and requires the
approved dedicated runtime identity email. The application must later be
seeded through the fixed `protectedAppUsers/{uid}` and
`protectedAppConfig/transactionService` paths. Seed exactly the approved
existing app users after matching each exact UID, verified lowercase email,
and household. Do not auto-enroll the current Auth roster or create a signup
path. No client can write or read those protected documents.

## Activation order

1. Deploy the reviewed trusted artifact with Link and sync disabled.
2. Verify the site guard, exact origin
   `https://zmstiles-dev.github.io`, Firebase token verification, protected
   membership/config, and review/accepted server mutations.
3. Publish the frontend endpoint only after those checks. The checked-in
   template intentionally leaves it empty; endpoint publication is a
   coordinated cutover.
4. Approve Link separately after institution IDs, redirect URI, account
   coverage, and fixed slots are verified. Link stores encrypted durable token
   versions and never exposes credentials to the browser.
5. Keep sync disabled until its own live activation approval.

## Rollback and key rotation

To roll back, disable provider gates and restore the previous trusted artifact.
Preserve encrypted token versions, connection pointers, pending/reconciliation
records, cursors, and exchange ledger entries. Do not delete versions to make a
rollback appear clean. For rotation, pause Link and sync and drain bounded
requests; activate the new key while retaining the old key, then operator-only
rewrap every referenced version with a compare-and-set transaction that also
updates its exchange-reference metadata. Verify new-key-only reload and
reconciliation before retiring the old key. Missing old keys fail closed and
cannot create a new Item. There is no app-user key-management route.

## Local checks

Use the following commands before requesting an approval review:

```text
node tests/netlify-runtime.test.cjs
node --check netlify/functions/budgetTransactions.mjs
node --check scripts/prepare-netlify.cjs
node --check scripts/bundle-netlify.cjs
node scripts/prepare-netlify.cjs
node scripts/bundle-netlify.cjs
npm --prefix netlify audit --omit=dev
npm --prefix netlify audit
```

The observed online runtime-only audit is clean (`0` vulnerabilities). The
online full-tree audit currently reports four propagated high findings for
`GHSA-vfj7-8cjw-p6xm` (also listed as `CVE-2026-93687`, braces stack-exhaustion,
affected through `3.0.3`) in
`@netlify/zip-it-and-ship-it@16.3.1`'s `fast-glob` → `micromatch` → `braces`
chain; npm offers the incompatible major downgrade `9.28.0` as its fix. The
deployable ZIP is built from the locked production closure and contains none of
those build packages. Build inputs are fixed local allowlists, the artifact is
assembled manually, and hosted or untrusted builds are disabled. Do not report
the full development tree as vulnerability-free until Netlify publishes a
compatible patched bundler.
The earlier D: offline-cache audit returned zero for both trees, but the cache
does not contain the current online advisory data and is not used as the final
full-tree result.

The full browser, Auth/Firestore emulator, rules-first/local-E2E, core, and
27-case matrix checks remain part of the root agent's independent review.

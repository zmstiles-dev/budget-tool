# Production readiness

> Status: local frontend release delta, October 19, 2026. The reviewed Netlify
> backend environment is configured and its single approved production
> redeploy was confirmed by read-only reconciliation. This checkout performs
> no cloud writes; the frontend Pages publication and a live Link API/Item test
> remain pending.

The project is `budget-tool-sync`. The approved future Netlify site display
name is `Stiles-Budget-Tool`, with proposed normalized slug
`stiles-budget-tool` is the approved existing Netlify site with the reviewed ID and production hostname; runtime checks still reject any different binding. The
existing Firebase Auth and Firestore services remain the identity and data
stores; Firestore is in `nam5`, and the project currently has Spark billing
with no billing account linked. Firebase
Functions and Secret Manager code remains in this repository as a tested
reference path. It is not the selected launch transport because Functions
requires Blaze. The active Netlify implementation has been configured and
deployed once under the approved operator flow. Its Link API path has not yet
been exercised and no provider Item has been created.

The Free plan decision is based on Netlify's current credit plan: 300 monthly
credits, with hard project pausing when the credit balance is exhausted and no
automatic paid overage. The documented rates are 15 credits per successful
production deploy, 10 per GB-hour of compute, 20 per GB of bandwidth, and 2
per 10,000 requests. A failed deploy has no deploy-credit charge. Preview and
branch deploys have no deploy-credit charge, but their traffic, compute, and
bandwidth still consume credits; this release path does not use them. The
current public plan documentation does not establish a card requirement; setup
must stop if the account flow asks for payment. A manual, trusted artifact is
required because Free environment variables are not Functions-only scoped and
a runtime guard cannot defend against a malicious build artifact. No Netlify
AI agent, Git integration, hosted build, fork/PR build, or preview with
credentials is part of the approved path.

The reviewed Netlify account dashboard shows the Free plan with 300 monthly
credits. The approved private site exists and its separately approved one-use
environment redeploy is complete; this checkout does not grant, read, or use
operator credentials. Current plan references are
[Netlify pricing](https://www.netlify.com/pricing/),
[credit-based pricing plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/),
and [How credits work](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/).

## Runtime and authorization

`netlify/functions/budgetTransactions.mjs` is a modern Netlify Web
Request/Web Response adapter around the existing parsed/raw-body production
handler. It requires all of the following before reading Firebase credentials,
Plaid credentials, or token-vault keys:

* `context.deploy.context === 'production'`;
* `context.deploy.published === true`;
* `context.site.id` equals the pinned `BUDGET_NETLIFY_SITE_ID`; and
* the hostname in `context.site.url` equals the pinned
  `BUDGET_NETLIFY_SITE_HOST`.

Missing, preview, unpublished, malformed, old-deploy, or wrong-site context
fails closed. The source contains no credential values; the deployed site ID
and host are bound through the approved production environment. The function uses current Netlify defaults
for region and memory, and does not carry over Firebase-only region or memory
settings. Node 24 is the selected runtime. The modern Netlify function's
documented 60-second limit is bounded internally by the provider deadlines.

Firebase ID-token verification remains mandatory. The resolver is pinned to
`protectedAppUsers/{uid}` and `protectedAppConfig/transactionService`.
The membership document must contain the exact case-sensitive UID, a verified
lowercase email, `allowed: true`, and a bounded nonempty household ID. The
configuration document must contain `allowed: true` and the same household
ID. The runtime, server resolver, and [firestore.rules](firestore.rules) use
the same paths and normalization. Missing documents, wrong households,
whitespace, uppercase email, forged claims, and client enrollment all fail
closed. Only the four already registered and separately approved existing app
users may later be seeded; Firebase registration never enrolls a user.

Client reads and writes to membership, configuration, review, accepted,
connection, token-vault, and sync collections remain denied by rules. Review
and accepted mutations go through the authenticated server after the backend,
rules, membership, and frontend cutover are coordinated. There is no
administrator review role and no browser access to provider credentials.

The exact browser origin remains
`https://zmstiles-dev.github.io`. `deployment-config.template.js` now carries the reviewed Link-only endpoint
default, enables only the explicit Chase and US Capital One connection keys,
and keeps sync disabled with an empty sync connection list. The backend Link
gate is configured in the approved production environment; this frontend
change does not perform provider requests or create an Item.

## Encrypted token vault

The Netlify path uses `FirestoreEncryptedTokenStore` in
`production-service.js`, rather than paid Secret Manager storage. Every
successful exchange writes a durable version document before reporting
lifecycle success. The logical token version and plaintext identity remain
stable; an operator-only key rewrap may replace its ciphertext envelope in
place while retaining the same reference. The logical reference is shaped like
`projects/budget-tool-sync/secrets/{slot}/versions/{number}` so existing
connection records can retain a stable version reference without storing an
access token.

Each envelope uses AES-256-GCM with a random 12-byte nonce and AAD:
`project|household|slot|token-version|encryption-key-id|JSON([exchangeId,ownerUid,householdId,itemId])`.
The binding suffix is authenticated for exchange-bound versions; an empty
suffix is retained only for legacy unbound references. Ciphertext,
nonce, tag, key ID, schema, and bounded timestamps are stored; plaintext,
public tokens, and client secrets are not. The transaction allocates the next
version and pointer together, serializes concurrent writes, and retains all
versions up to the configured bound rather than deleting recovery state.
Tampered ciphertext, wrong slot/AAD, malformed references, a missing old
rotation key, and a version bound all fail closed. Rewrapping keeps the same
logical version and atomically updates every matching exchange-reference
`keyId`, so no stale reference can recover an envelope with the wrong key.
The old encryption key remains required until every referenced envelope has
been rewrapped and bounded recovery/reconciliation has drained. Rotation is
an operator-only setup operation; no four-user route can rotate keys.

The existing Firebase `SecretManagerTokenStore` and its exact numeric version
references remain available for the Firebase reference deployment. They are
not used by the Netlify runtime and are not read by local tests.

## Link and sync lifecycle

The checked-in frontend Link-only candidate enables the two explicit connection
keys, while sync remains disabled. The backend Link gate is configured and
deployed, but its provider API path remains untested; when exercised it uses
the existing durable lifecycle:

1. A transaction reserves a connection slot for the authenticated UID,
   household, session, mode, and short TTL before creating a Link token.
2. Exchange persists the provider Item token into the encrypted vault before
   account metadata or mapping work that can fail. A retry resumes the pinned
   token version and never blindly re-exchanges a one-time public token.
3. The server verifies the returned institution, account IDs, account type,
   subtype, currency, bounded mask, and explicit alias mapping. The browser
   never supplies provider IDs as authority.
4. Pending, reconciliation, and exchange ledger records are retained at a
   bounded capacity. A full ledger rejects a new unique exchange instead of
   pruning started or recoverable state.
5. Sync uses only the stored account map and token version. Unknown provider
   account IDs fail closed. It requests up to 500 rows per page, allows up to
   20 pages and 45 seconds, and publishes a new cursor only after complete
   pagination. An interrupted run preserves the prior cursor and pending
   state.

The configured future aliases are Chase: Checking Account, CFF, CFU, CSP; and
Capital One: Ven X. Account type/subtype checks distinguish the checking
account from credit cards. Institution IDs, OAuth redirect paths, slot
activation, and provider coverage remain unset until separately verified.
No automatic extra Item or slot is created.

The browser stores only short-lived Link session state needed for OAuth
resume. It never stores a public or access token. Auth UID, generation, slot,
session, and expiry guards reject stale callbacks and clear pending mapping UI
on identity changes. Server-verified account type and masked final four are
shown to distinguish duplicate display names; selecting a mask never creates
an implicit binding.

## Operator configuration record

The following records the approved production configuration without exposing
values. It is not an instruction to repeat or mutate the environment. Use the
approved site `stiles-budget-tool` at
`stiles-budget-tool.netlify.app` and enter values through the approved site
secret/configuration interface. Its public site ID is retained only in the
operator evidence; never guess or replace pinned site metadata. Never put
secret values in chat, source, CLI arguments, build logs, Git configuration,
previews, or pull requests.

Nonsecret values recorded by the approved operator:

```text
BUDGET_NETLIFY_SITE_ID=<approved isolated site ID>
BUDGET_NETLIFY_SITE_HOST=<approved production hostname>
BUDGET_FIREBASE_PROJECT_ID=budget-tool-sync
BUDGET_HOUSEHOLD_ID=<approved protected household ID>
BUDGET_CONNECTION_KEYS=chase,capital-one
BUDGET_ACTIVE_CONNECTION_KEYS=
BUDGET_EXPECTED_INSTITUTION_CHASE=ins_56
BUDGET_EXPECTED_INSTITUTION_CAPITAL_ONE=ins_128026
BUDGET_LINK_ENABLED=true
BUDGET_SYNC_ENABLED=false
BUDGET_PLAID_CLIENT_ID=<approved client ID>
PLAID_REDIRECT_URI=https://zmstiles-dev.github.io/budget-tool/
```

Secret values were entered only by the authorized operator through the
approved site mechanism and are intentionally omitted here:

```text
BUDGET_FIREBASE_CLIENT_EMAIL=<runtime credential value>
BUDGET_FIREBASE_PRIVATE_KEY=<runtime credential value>
BUDGET_TOKEN_CURRENT_KEY_ID=<active AES key ID>
BUDGET_TOKEN_KEYRING_JSON=<JSON of bounded base64url AES-256 keys>
BUDGET_PLAID_CLIENT_SECRET=<provider client secret, only for approved Link use>
```

The runtime does not create credentials, keys, sites, secrets, Items, or
membership documents. The four approved existing app users and protected
household configuration were seeded and independently re-read through the
fixed protected paths. No Item has been created and no provider API request
has been exercised.

The single reviewed production function redeploy was completed under the
approved one-use allowance. Its upload acknowledgment was ambiguous, so the
operator performed GET-only reconciliation and confirmed the resulting
production deploy; no upload retry was sent. Do not publish another function
artifact. Failed deploys cost no deploy credits, but no preview or branch
deployment should be used as a testing substitute because request, compute,
and bandwidth usage still consume credits.

## Artifact and source boundaries

The prebuilt artifact is assembled locally with
`node scripts/prepare-netlify.cjs` followed by
`node scripts/bundle-netlify.cjs`. The scripts use an explicit five-source-file
allowlist, remove the inactive legacy email fallback from the packaged copy,
bundle the inspection copy with the pinned local esbuild, create the uploadable
`netlify/.artifact/budgetTransactions.zip` with Netlify's pinned
`zip-it-and-ship-it`, and reject symlinks, junction-like output paths, and
unexpected generated entries. The generated
`_runtime` and `.artifact` directories are ignored and are not source
fallbacks. The Netlify public directory contains only `.gitkeep`; the
function source is outside it. Upload the ZIP only from a
trusted local build. Hosted build commands, automatic Git/fork/PR/preview
deploys, preview credentials, and build plugins are not part of this path.

Current local delta inventory:

* `netlify/functions/budgetTransactions.mjs` — Netlify runtime guard, Web
  adapter, Firebase/Admin14 composition, bounded Plaid adapter, disabled
  defaults, and local-only redacted startup-stage diagnostics that preserve
  the generic client error response.
* `production-service.js` — shared service plus encrypted Firestore token
  vault; the existing Secret Manager reference implementation remains in the
  same file.
* `netlify/package.json` and `netlify/package-lock.json` — pinned Admin14.5
  and Plaid38.1 runtime dependencies, with no Firebase Functions or Secret
  Manager dependency.
* `scripts/prepare-netlify.cjs`, `scripts/bundle-netlify.cjs`,
  `netlify/netlify.toml`, and
  `netlify/public/.gitkeep` — isolated manual artifact assembly.
* `deployment-config.template.js` — reviewed endpoint with Link-only Chase/Capital
  One defaults, sync disabled, and an empty sync connection list.
* `tests/netlify-runtime.test.cjs` — focused guard, adapter, vault, payload,
  rotation, tamper, concurrency, bundle import, SDK version, inventory, and
  redacted startup-stage/healthy-auth coverage, including extracted ZIP
  initialization outside checkout ancestors.
* `PRODUCTION_READINESS.md` and `NETLIFY_FREE_SETUP.md` — this local delta's
  setup, rollout, cost, and rollback record.

The pre-existing Firebase reference inventory remains `functions/index.js`,
`functions/package.json`, `functions/package-lock.json`, `functions/prepare.js`,
`firebase.json`, and the five generated source modules. Its ignored
`functions/lib/` and dependency directories are local build output only. No
`budget-data.json`, CSV export, statement, backup, environment file, secret,
credential, emulator log, or generated cache belongs in either artifact.

## Verification and rollout

The focused local command is:

```text
node tests/netlify-runtime.test.cjs
```

The final review command list also includes:

```text
node --check netlify/functions/budgetTransactions.mjs
node --check scripts/prepare-netlify.cjs
node --check scripts/bundle-netlify.cjs
node scripts/prepare-netlify.cjs
node scripts/bundle-netlify.cjs
npm --prefix netlify audit --omit=dev
npm --prefix netlify audit
```

The observed online runtime-only audit is clean. The online full-tree audit
reports four high build-only advisories in the pinned ZISI 16.3.1 dependency
chain (`fast-glob` → `micromatch` → `braces`); npm's suggested 9.28.0 downgrade
is an incompatible major. The production ZIP excludes that build closure and
uses fixed local source patterns with manual artifact upload. An earlier D:
offline-cache audit returned zero for both trees, but its advisory data is not
current and is not the final full-tree result.

The broader repository suites, browser smoke, Auth/Firestore emulator run,
rules-first/local-E2E isolation, and the 27-case matrix remain required before
any release verdict. Emulator tests use injected Plaid and key material only.
Ports 8787, 9099, 8088, 4400, 4500, and 9150 must be free after every run.

Rollout order after separate approval is backend artifact first with both
provider gates false, then protected membership/config and matching rules,
then authenticated review smoke tests, then the coordinated frontend endpoint
publication. Link activation requires a separate review of institution IDs,
redirect URI, slot roster, coverage, and token-vault key setup. Sync remains
disabled until a distinct live activation decision.

For rollback, stop accepting the Netlify revision or restore the previous
trusted artifact, disable provider gates, and preserve the vault versions,
connection documents, cursors, pending records, and exchange ledger. Do not
delete encrypted versions or recovery state during an application rollback.
An operator may revoke a provider Item or rotate keys only through a separately
approved process that retains every version still referenced. Review the
protected membership, household, origin, site guard, and artifact hash before
restoring service.

## Actual release status — 2026-10-18

The earlier milestone authorization text above records the pre-release state.
Subsequent explicit operator approvals produced one private production deploy:
deploy `6ad55f9563cfe446098f255b`, from commit `c56d2a9` and the reviewed ZIP
SHA256
`6c9548ff5844f531966983a55bb8e687c84e8c5a6f256b0143a84cf970c96265`.
That publish consumed 15 of the 300 current Free-plan credits, leaving 285.
The protected household configuration and four approved existing memberships
were seeded and independently re-read; no accepted budget records were
modified. The temporary Netlify CLI grant was revoked afterward.

The earlier private published route returned the generic service-unavailable
response. That historical revision predates the local-only redacted diagnostic
and the later approved Link-only redeploy recorded below. The diagnostic and
Link-only environment changes were subsequently reviewed; the live Link API
path still has not been exercised. No additional publish, upload, redeploy,
Link or sync activation, frontend endpoint change, visibility change, bank
operation, or migration is authorized without a separate review.

## Current Link-only status — 2026-10-19

The approved frontend candidate enables Link for `chase` and `capital-one`, with
server-verified institution markers `ins_56` and `ins_128026`. The production
backend environment is Link-enabled; sync and active connection state remain
empty/disabled. The single redeploy (`6ad6462cbe96255113bf6364`) was confirmed
by GET-only reconciliation after an ambiguous upload acknowledgment. The
frontend Pages publication and live Link API/Item test remain pending; this
checkout does not expose provider credentials or create an Item.

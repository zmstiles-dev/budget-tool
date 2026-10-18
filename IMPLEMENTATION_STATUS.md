# Transaction review implementation status

> October 18, 2026 decision update: Zach rejected Blaze and requires a genuinely
> free backend with no automatic paid overages. The Firebase Functions/Secret
> Manager deployment described below is retained as tested reference work, not
> the launch path. Netlify's current credit-based Free plan is the selected
> replacement path; its modern Node adapter, isolated bundle, and integrated
> encrypted token vault are implemented locally and still require independent
> release review. Existing Firebase
> Auth/Firestore must remain on Spark. All four currently registered project
> accounts are approved; future signups are not. Exact proposed UID/email entries
> are private local provisioning material, not client configuration. No account,
> credential, membership, IAM, billing or deployment action is authorized here.

Status: local release candidate on `feat/transaction-review-foundation`. The
checkout contains the transaction review foundation, a loopback Auth/Firestore
verification harness, and a deployable server adapter. The current readiness
delta is local and unpublished; it performs no new deployment, live Firebase
mutation, live bank connection, or PR update.

`PRODUCTION_READINESS.md` and `NETLIFY_FREE_SETUP.md` are the authoritative
current launch and operator documents. The Firebase Functions and Secret
Manager sections below describe retained reference work from the earlier
milestone; they do not authorize a Blaze upgrade or supersede the Netlify
artifact path.

## Current product and configuration decisions

- The first-sync cutover is the inclusive app date `2026-10-09`; this
  supersedes the earlier October 16 value.
- Provider sync remains disabled by default. Enabling it requires an explicit
  server provider, connection ownership resolver, stable provider-account map,
  protected service endpoint, and `syncEnabled: true`.
- Existing display/account aliases remain `CFF`, `CFU`, `CSP`, `Ven X`,
  and `Checking Account`. They are not provider account IDs. Unknown provider
  IDs fail closed.
- Bank CSV imports require an explicit source and existing account. Historical
  and bank candidates enter one review surface; rejected and deferred markers,
  overlap flags, edits, splits, and explicit selected approval are preserved.
- Pending provider rows stay outside accepted totals until approval. Provider
  modifications and removals require the source revision they target and are
  applied atomically. Their staged target digest covers the accepted row or
  split children; an ordinary accepted-state edit invalidates stale review and
  requires the provider observation to be staged again.
- Legacy accepted rows that cannot satisfy strict review dates remain in
  canonical history byte-for-byte but are omitted from review metadata. No
  date is fabricated, and new/review/provider rows remain strict. Explicit
  accepted-history exports carry a bounded schema-1 compatibility marker when
  they contain opaque date strings; restore preserves those strings exactly,
  including for unversioned four-field migration and repeated round trips,
  then strips the marker before canonical persistence.
- Ordinary accepted-state saves preserve review receipts and amendment
  history. A deleted receipt-bound row is retained only in protected review
  history so the receipt remains valid; explicit restore and reset invalidate
  prior receipts. A browser approval retry may recover a committed stage only
  when its reviewed IDs, revisions, and bounded fields match the server row.
- Firebase rules deny browser writes to protected pending, accepted-review,
  receipt, audit, connection, and sync-run documents. The existing app may
  update settings in `shared/data` only through a revision increment while
  transaction-array changes remain service-owned.
- The local HTTP composition verifies the Firebase Admin ID token, sealed UID
  membership, fixed household configuration, connection ownership, expected revisions,
  CORS origin, and a bounded JSON body before any mutation. Approval receipts
  are compact and idempotent.
- The provider adapter requires an explicit USD account map, preserves provider
  signs, links pending and posted observations, paginates before publishing a
  cursor, and uses bounded retry, mutation restart, and deadline controls.
- Sandbox client ID, secret, public token, access token, and account mapping
  remain process-memory-only in the server scaffold. The browser never receives
  provider credentials or raw provider payloads.

## Verification evidence

The lead independently ran the actual PowerShell launcher through the
supervisor, loopback HTTP bridge, real browser, Auth emulator, Firestore
emulator, and approved harness. The final credential-free matrix had 27/27
scenarios pass with exit code 0. It covered HTTP and browser diagnostics,
malformed and stalled responses, bounded readiness/transient recovery, fatal
schema and authentication precedence, exact sanitized response-shape
propagation, same-token recovery, one setup call, staging failure retention,
explicit approval, persistence, and reload.

The single approved isolated Sandbox run also completed successfully:

- setup calls: 1
- raw observations: 48
- skipped observations: 30
- cutoff-excluded observations: 16
- staged records: 2
- approved, persisted, and reloaded records: 2

Those records were written only to the isolated `demo-budget-tool`
Auth/Firestore emulators. This proves the local Sandbox-to-review-to-emulator
path for that run; it does not prove deployed Firebase, production IAM,
hosting, live-bank operation, or production data access. No additional
Sandbox request, Item creation, credential read, or remote mutation is planned
for this milestone.

The ignored local backup remains byte-for-byte unchanged. Its SHA-256 is
`6023380f4cb74a88c8bd60e4a2cf4e1cdb673670d099849080af562ff82f91aa`. The
backup contains private budget history and is excluded from publication; only
the integrity hash is recorded here.

The five core Node suites pass:

```text
node tests/transaction-validation.test.cjs
node tests/review-core.test.cjs
node tests/transaction-backend.test.cjs
node tests/transaction-service.integration.test.cjs
node tests/plaid-sandbox.test.cjs
```

The lead also recorded passing browser smoke, local emulator/rules, PowerShell
5/7 launcher, OS spawn-safety, all top-level JavaScript/CJS syntax, and
`git diff --check` checks. The lead repeated browser smoke after the final diagnostic change; it passed without dependency installation or external download.

## Production boundary implemented locally

The checkout now contains a Firebase Functions 2nd-gen HTTPS adapter for the
existing `budget-tool-sync` project in `us-central1`, matching the verified
Firestore `nam5` location. Keep the current GitHub Pages frontend and allow
only the exact deployed origin `https://zmstiles-dev.github.io`. The adapter
uses the Node.js 22 runtime, the managed runtime identity, and Firebase Admin
SDK; it does not use service-account keys.

The deployed adapter should retain the existing protected pending inbox,
accepted-state document, revision-bound approval receipts, connection
ownership, provider cursor/run state, and on-open delta/cooldown behavior. It
should not add forced refreshes, webhooks, or scheduled jobs. The browser Link
path is explicit-gated and sends only the public token and reviewed account
mapping. Production secrets belong in Secret Manager: the Plaid client
secret and per-Item access-token values must be server-only. Protected
Firestore metadata should hold only ownership, non-secret connection
references, stable provider-account mappings, and other non-secret metadata.

`production-service.js` and `functions/index.js` implement the local
production wrapper contract: parsed/raw body adaptation, exact CORS, existing
app-user and household authorization, Secret Manager access-token storage and
resolution, durable Link reservation and create/exchange/update lifecycle,
stable provider account binding, bounded provider transport, and safe error
output. Link is server-gated by `BUDGET_LINK_ENABLED`, sync is separately
gated by `BUDGET_SYNC_ENABLED` plus active stored connection state, and the
browser Link card remains hidden without explicit injected configuration. The
wrapper is locally testable but still requires separately approved deployment
configuration, IAM, secret resources, account mapping, and deployed security
review.

Current official cost and eligibility constraints, checked 2026-10-18 UTC:

- Firebase Functions requires the Blaze pay-as-you-go plan. Free allowances
  cover some invocation, compute, and network usage, but deployment/container
  storage, Firestore, logging, build, egress, and existing project usage can
  still create charges. A small `minInstances=0`, `maxInstances=1`
  starting policy controls capacity; it is not a cost guarantee.
- Secret Manager documents six active secret versions and 10,000 monthly
  secret-access operations without charge; use of additional versions or
  accesses is billable. Keep secrets few and bind each only to the function
  that needs it.
- Firebase service spend caps are currently Preview, service-specific, and
  not hard caps because reporting latency can create billed overage. Budget
  alerts notify but do not stop services. They do not cover every Firebase or
  Google Cloud charge.
- The verified Firebase console state on 2026-10-18 showed Spark billing at
  $0 with no billing account linked and no existing billing accounts listed
  for this project. Blaze and a future billing-account link or creation still
  require separate human approval; no billing settings were changed.
- A $0 covered-workload estimate may be plausible for low local-scale traffic
  under the published allowances, but it is not a guaranteed $0 total or hard
  cap; no production workload usage was inspected.
- For scale planning only, three users opening four times per day across two
  connections would be about 720 delta starts per 30-day month; at an assumed
  five seconds each that is about 3,600 CPU-seconds before pagination or other
  requests. This is a conditional allowance comparison, not an all-in quote.
- The Plaid dashboard showed this team on the free trial with Transactions
  marked as a Trial product on 2026-10-18. The remaining Production Item
  quota, institution coverage, and eventual pricing remain unverified.
  Official Trial terms describe up to 10 Production Items for eligible teams;
  removing an Item does not restore a Trial slot. Sandbox usage remains free,
  and no paid fallback is approved.

Sources: [Firebase Functions quotas](https://firebase.google.com/docs/functions/quotas),
[Firebase Functions configuration and Secret Manager](https://firebase.google.com/docs/functions/config-env),
[Firebase Functions runtime management](https://firebase.google.com/docs/functions/manage-functions),
[Firebase spend caps](https://firebase.google.com/docs/projects/billing/spend-caps),
[Firebase pricing plans](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans),
[Firebase pricing](https://firebase.google.com/pricing),
and [Plaid account billing and Trial plans](https://plaid.com/docs/account/billing/).

## Publication inventory

The earlier baseline inventory described the transaction-review foundation. The
current local delta is smaller and is the authoritative file list for this
production-readiness work; it is review material, not publication approval.
The checkout currently has these eleven modified tracked files:

- `IMPLEMENTATION_STATUS.md`, `TRANSACTION_SERVICE.md`, `firestore.rules`,
  `index.html`, `local-demo-bridge.js`, `transaction-backend.js`, and
  `transaction-service.js`.
- `tests/browser-smoke.test.cjs`, `tests/firestore-rules.emulator.test.cjs`,
  `tests/local-demo-bridge.test.cjs`, and `tests/local-emulator-e2e.test.cjs`.

The current local additions are:

- `PRODUCTION_READINESS.md`, `firebase.json`, `production-service.js`, and
  `deployment-config.template.js`.
- `scripts/preview-deployment-config.cjs`,
  `tests/production-emulator-e2e.test.cjs`, and
  `tests/production-readiness.test.cjs` provide the disabled frontend endpoint
  preview, installed Admin 14 emulator persistence check, and injected
  production lifecycle suite.
- `functions/index.js`, `functions/package.json`,
  `functions/package-lock.json`, `functions/prepare.js`, and
  `functions/.gitignore`.

The ignored `functions/lib/` build output and `functions/node_modules/` are
local verification artifacts. The explicit five-file deployment allowlist and
package manifest are regenerated by `functions/prepare.js`; neither generated
output nor dependencies belong in the source change list.

The following remain local exclusions and must not be published: `.codex/`
machine scratch files, `budget-data.json`, any private CSV/statement
directories or CSV exports regardless of filename, generated Firebase or Firestore logs, `.env` and
`.env.*` files, credentials, tokens, exported provider responses, and
machine-local dependency or browser caches. Existing tracked files such as
`budgets.csv`, `categories.csv`, `transactions.csv`, `PLAN.md`,
`MOBILE_ACCESS_PLAN.md`, and `CATEGORIES_PAGE.md` are unchanged by this
feature and are not part of the feature diff.

## Remaining release gates

Before any production activation, independently approve the target region,
billing exposure and thresholds, exact provider link/connection behavior,
persistent secret storage, deployment identity/IAM, deployed rules and hosting,
and the production account map. Verify the actual Plaid team Trial/paid
eligibility and institution coverage in its dashboard. Keep the browser
provider path and on-open sync disabled until those gates and a separate
deployed security review are complete.

The current readiness assignment performs no new publication, deployment,
migration, or live-data mutation. Earlier user-authorized publication and
rollback history is preserved below.

## Proposed readiness delta summary (not published)

Title: Add protected transaction review and review-first bank sync foundation

Incoming CSV and provider transactions now stage for explicit review instead of changing accepted budget history immediately. The Import screen supports edits, splits, selection, rejection and deferred review; accepted state changes only after acknowledged persistence. A separate authenticated service owns the protected inbox, revision-bound approvals, idempotency receipts and provider cursor/cooldown state while retaining the existing accepted-data shape and CSV paths.

Local review corrected missing accepted-state revision guards, unchanged legacy-history compatibility, safe accepted-history backup round trips for opaque dates, unsafe budget dictionary keys, stale provider amendment targets, inline approval recovery after lost staging responses, receipt lifecycle failures, and premature success messages. Existing unknown dates are not repaired or made reviewable. The successful isolated real Sandbox evidence above is retained; later release fixes are verified with local synthetic/emulator checks, with no further real provider run.

The current local delta above is the proposed review scope. No data export,
secret, machine-local scratch state or generated log belongs in it. This
milestone creates no commit, push, PR or deployment. Final independent
acceptance is recorded separately after all affected checks pass.

## Minimal later authorizations

1. Approve the recommended existing-project Functions target and acceptable billing exposure/alert and service-pause thresholds. A strict guaranteed-zero-spend requirement blocks this proposed Blaze deployment; free allowances are not such a guarantee.
2. Authorize protected deployment, managed runtime IAM and persistent secret/token storage after reviewing the implementation and rollout/rollback plan. Registration and app access must remain unchanged.
3. After account-specific Plaid eligibility and coverage checks, authorize only the intended real bank Link connections and stable account bindings, then activation of on-open, review-first delta sync with the already-decided inclusive October 9 cutoff. No paid Plaid fallback or forced refresh is approved.

PR #10 is already open in draft. Publishing this newer local readiness delta remains a separate action. Existing Sandbox environment configuration requires no repetition.

## Local validation record

The prior root verification baseline passed the five core suites, browser
smoke, rules-first/local emulator suites, production Admin 14 persistence,
the 27-case matrix, and package checks. This compatibility delta specifically
passes `node tests/review-core.test.cjs`,
`node tests/transaction-backend.test.cjs`,
`node tests/transaction-service.integration.test.cjs`,
`node tests/transaction-validation.test.cjs`,
`node tests/production-readiness.test.cjs`,
`node tests/netlify-runtime.test.cjs`, and the browser smoke suite with the
bundled Playwright runtime. It also passes top-level syntax and `git diff
--check`. Root-owned independent review must rerun the full acceptance matrix
after this source change.

Final focused independent review confirmed the account-switch UI and async render-tail fixes, and found no remaining confirmed blocker in the reviewed authorization boundary. Root independently passed the six core/readiness suites, browser regression, final 27/27 synthetic matrix, rules matrix, production Admin14 persistence, and local authenticated persistence/reload. The deployable package hashes and Gen2 configuration match the source; production runtime dependency audit reports zero vulnerabilities. This is local acceptance only, not deployed end-to-end completion. Deployment IAM, preprovisioned secrets, deployed verification, and account-specific Plaid eligibility remain outstanding. The private historical backup remains byte-for-byte unchanged; its opaque dates are supported only through the marked accepted-history backup path and are not repaired or made reviewable. The previously approved real Sandbox run predates these later fixes and was not repeated.

The current local delta matches the tracked and untracked source files listed
above. The private backup hash is unchanged. No new commit, staging, push, PR update,
deployment, persistent credential creation or live data mutation was performed
for the current readiness assignment.

## Preserved publication and rollback history

PR9 was merged by the user as `c395738a89690e88b76b19f1aafc2ab4874d1189`.
At the user's request, revert `875321f100b33c33499d8c09bcf9918c3aa10465`
restored main to the tree of `2109ff159ebbb3b0f941a7f0ba41fcb88f1e5ccb`;
the Pages rollback was verified successful. The user then requested another
MR. Feature-only reapplication `06d80ad8fa151572ad3053a087e3d1e97eff8ad4`
restored reviewed tree `0fcb6f490443a039f41553edf649e8471832f7fa` and is
the published head of [draft PR10](https://github.com/zmstiles-dev/budget-tool/pull/10).
The readiness assignment began with a clean checkout. Its current dirty delta
is unpublished; historical user changes and private ignored files are preserved.

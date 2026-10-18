# Transaction review implementation status

Status: local release candidate on `feat/transaction-review-foundation`. The
checkout contains the transaction review foundation, a loopback Auth/Firestore
verification harness, and a server-only Plaid Sandbox scaffold. No production
deployment, live Firebase mutation, live bank connection, or PR publication is
part of this checkout.

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
  date is fabricated, and strict backup restore still rejects those rows.
- Ordinary accepted-state saves preserve review receipts and amendment
  history. A deleted receipt-bound row is retained only in protected review
  history so the receipt remains valid; explicit restore and reset invalidate
  prior receipts. A browser approval retry may recover a committed stage only
  when its reviewed IDs, revisions, and bounded fields match the server row.
- Firebase rules deny browser writes to protected pending, accepted-review,
  receipt, audit, connection, and sync-run documents. The existing app may
  update settings in `shared/data` only through a revision increment while
  transaction-array changes remain service-owned.
- The local HTTP composition verifies the Firebase Admin ID token, app
  allowlist, household membership, connection ownership, expected revisions,
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

## Proposed production boundary

The recommended production shape is a Firebase Functions 2nd-gen HTTPS
adapter in the existing `budget-tool-sync` project, with the region selected
after a separately authorized check of the existing Firestore location. Keep
the current GitHub Pages frontend and allow only the exact deployed origin
`https://zmstiles-dev.github.io`. Select the currently supported Node.js 22
runtime when that future wrapper is implemented. Use the managed runtime identity and
Firebase Admin SDK; do not download service-account keys.

The deployed adapter should retain the existing protected pending inbox,
accepted-state document, revision-bound approval receipts, connection
ownership, provider cursor/run state, and on-open delta/cooldown behavior. It
should not add forced refreshes, webhooks, scheduled jobs, or a browser-side
provider path. Production secrets belong in Secret Manager: the Plaid client
secret and per-Item access-token values must be server-only. Protected
Firestore metadata should hold only ownership, non-secret connection
references, stable provider-account mappings, and other non-secret metadata.

A production wrapper still must be implemented and reviewed. It needs a
platform-compatible request adapter for the host's already-parsed body or raw
body stream, a Secret Manager-backed resolver, production Plaid transport,
deployed configuration and IAM, exact CORS, structured safe error output,
rate/deadline controls, and operational monitoring. The current local handler
and emulator composition are not a deployment by changing a flag.

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
- A $0 covered-workload estimate may be plausible for low local-scale traffic
  under the published allowances, but it is not a guaranteed $0 total or hard
  cap; current project billing and usage were not inspected.
- For scale planning only, three users opening four times per day across two
  connections would be about 720 delta starts per 30-day month; at an assumed
  five seconds each that is about 3,600 CPU-seconds before pagination or other
  requests. This is a conditional allowance comparison, not an all-in quote.
- Plaid's current US/Canada Trial eligibility is limited to new teams created
  on or after April 15, 2026, with up to 10 Production Items; removing an Item
  does not restore a Trial slot. Transactions is listed as a Trial product,
  but this account's eligibility, remaining quota, institution coverage, and
  eventual pricing are unverified. Sandbox usage remains free, and no paid
  fallback is approved.

Sources: [Firebase Functions quotas](https://firebase.google.com/docs/functions/quotas),
[Firebase Functions configuration and Secret Manager](https://firebase.google.com/docs/functions/config-env),
[Firebase Functions runtime management](https://firebase.google.com/docs/functions/manage-functions),
[Firebase spend caps](https://firebase.google.com/docs/projects/billing/spend-caps),
[Firebase pricing plans](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans),
[Firebase pricing](https://firebase.google.com/pricing),
and [Plaid account billing and Trial plans](https://plaid.com/docs/account/billing/).

## Publication inventory

The intended feature publication contains these changed or newly added files:
This allowlist contains 31 files total.

- Changed tracked files: `.gitignore`, `index.html`.
- Application and local-service files: `firebase.test.json`,
  `firestore.rules`, `local-demo-bridge-emulator-launcher.js`,
  `local-demo-bridge-runner.js`, `local-demo-bridge.js`,
  `local-demo-bridge.ps1`, `plaid-sandbox-runner.js`,
  `plaid-sandbox.js`, `transaction-backend.js`,
  `transaction-config.js`, `transaction-review.js`,
  `transaction-service.js`, `transaction-service.package.json`,
  `transaction-validation.js`.
- Status and setup docs: `IMPLEMENTATION_STATUS.md`,
  `TRANSACTION_SERVICE.md`.
- Tests (13 files): `tests/approved-sandbox-e2e.cjs`,
  `tests/approved-sandbox-synthetic-e2e.cjs`, `tests/browser-smoke.test.cjs`,
  `tests/firestore-rules.emulator.test.cjs`,
  `tests/local-demo-bridge-emulator-launcher.test.cjs`,
  `tests/local-demo-bridge-launcher.test.ps1`, `tests/local-demo-bridge.test.cjs`,
  `tests/local-emulator-e2e.test.cjs`, `tests/plaid-sandbox.test.cjs`,
  `tests/review-core.test.cjs`, `tests/transaction-backend.test.cjs`,
  `tests/transaction-service.integration.test.cjs`, and
  `tests/transaction-validation.test.cjs`.

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
provider path disabled until those gates, the production wrapper, and a
separate deployed security review are complete.

No PR, deployment, migration, or live-data mutation has been performed by this
checkout.

## Proposed draft PR summary (not published)

Title: Add protected transaction review and review-first bank sync foundation

Incoming CSV and provider transactions now stage for explicit review instead of changing accepted budget history immediately. The Import screen supports edits, splits, selection, rejection and deferred review; accepted state changes only after acknowledged persistence. A separate authenticated service owns the protected inbox, revision-bound approvals, idempotency receipts and provider cursor/cooldown state while retaining the existing accepted-data shape and CSV paths.

Local review corrected missing accepted-state revision guards, unchanged legacy-history compatibility, unsafe budget dictionary keys, stale provider amendment targets, inline approval recovery after lost staging responses, receipt lifecycle failures, and premature success messages. Strict backup restore remains strict and existing unknown dates are not repaired. The successful isolated real Sandbox evidence above is retained; later release fixes are verified with local synthetic/emulator checks, with no further real provider run.

The complete proposed publication is the 31-file allowlist above. No data export, secret, machine-local scratch state or generated log belongs in it. This milestone creates no commit, push, PR or deployment. Final independent acceptance is recorded separately after all affected checks pass.

## Minimal later authorizations

1. Approve the recommended existing-project Functions target and acceptable billing exposure/alert and service-pause thresholds. A strict guaranteed-zero-spend requirement blocks this proposed Blaze deployment; free allowances are not such a guarantee.
2. Authorize protected deployment, managed runtime IAM and persistent secret/token storage after reviewing the implementation and rollout/rollback plan. Registration and app access must remain unchanged.
3. After account-specific Plaid eligibility and coverage checks, authorize only the intended real bank Link connections and stable account bindings, then activation of on-open, review-first delta sync with the already-decided inclusive October 9 cutoff. No paid Plaid fallback or forced refresh is approved.

Draft PR publication is a separate future action and remains unapproved for this milestone. Existing Sandbox environment configuration requires no repetition.

## Final independent local acceptance

The lead independently reran all five core suites, browser smoke, all top-level JS/test CJS syntax checks, and git diff whitespace checks after the final changes. The actual PowerShell synthetic launcher matrix passed all 27 scenarios with exit 0. A separate sanitized supervisor run passed the Firestore rules matrix followed by the browser/Auth/Admin/Firestore integration suite, including unchanged legacy-history carry-forward and strict restore rejection. Initial sequence failures exposed a missing local `/accepted-state` route and diagnostic shape loss after a successful background save; both were fixed and the complete matrix rerun. Earlier fixture-order/queue races were corrected without weakening production revision guards.

Read-only independent review found no remaining confirmed scoped blocker, including the final bridge route and bounded diagnostic projection. The lead accepts this as a local draft-review milestone only. Production adapter/secret resolver/IAM/deployed verification and account-specific Plaid eligibility remain outstanding. Strict backup export/restore can still reject existing invalid legacy dates; no date remediation or backup-schema change was performed. The previously approved real Sandbox run predates these later fixes and was not repeated.

The complete 31-file allowlist matches current tracked and untracked changes. The private backup hash is unchanged. No commit, staging, push, PR, deployment, persistent credential creation or live data mutation was performed.

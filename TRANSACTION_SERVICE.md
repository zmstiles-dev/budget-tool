# Transaction service local setup

This checkout is a local release candidate for the transaction review foundation.
`transaction-service.js` composes the authenticated review backend, protected
pending inbox, canonical `shared/data` repository, and fail-closed on-open
sync route. It has no credentials or provider dependency. Tests inject an Admin
verifier, Firestore-shaped transaction client, and provider adapter.

## Local contract

Pass `backend` or `householdId`, an injected `authenticate` callback, and
`allowedOrigins` to `createBudgetService`. A Firestore-backed instance
requires `db`, `householdId`, and server-side Admin verification. The browser
sends only a fresh Firebase ID token; connection ownership and provider access
tokens are resolved on the server.

`transaction-config.js` records the inclusive first-sync cutover
`2026-10-09`, the existing CSV/display aliases
(`CFF`, `CFU`, `CSP`, `Ven X`, and `Checking Account`), and
`DEFAULT_SYNC_ENABLED: false`. The aliases are not Plaid account IDs. A
provider integration must bind stable provider account IDs explicitly and
reject unmapped IDs. Enabling `/sync` requires a provider, owner mapping,
connection resolver, protected endpoint, and `syncEnabled: true`.

The protected backend verifies the Firebase Admin ID token, existing app
allowlist, household membership, connection ownership, and expected revisions
before every mutation. Pending inbox state is separate from accepted history.
Approval writes the canonical `shared/data` shape once and stores pending
review metadata, receipts, and audit state separately. Browser writes to
protected collections are denied by `firestore.rules`; settings updates in
`shared/data` require a revision increment and cannot change the transaction
array. Provider amendments carry a bounded server-created digest of their
accepted target row or split children; changing that target while review is
pending rejects the stale approval and requires a fresh staging/review pass.
Legacy accepted rows that fail strict review dates remain in canonical history
but are omitted from review metadata without date repair.
Ordinary accepted-state saves preserve receipts and amendment history; a
receipt-bound deletion is archived only in protected review history. Explicit
restore and reset invalidate prior receipts. If a browser loses a committed
stage response, approval may recover the server-pending row only when the
reviewed IDs, revisions, and bounded fields match exactly.

The HTTP handler allows only configured CORS origins, reads at most 2 MiB by
default, validates JSON before routing, and returns bounded diagnostics. The
2 MiB request limit accommodates existing backups larger than 512 KiB; the
Firestore per-document limit remains a separate history-size constraint.
`PlaidTransactionsSyncAdapter` enforces explicit USD account mapping, signed
amounts, pending/posted linkage, complete pagination before cursor publication,
bounded retries, mutation restarts, and a deadline.

The browser's protected restore route intentionally validates every transaction
date. The private historical backup contains four pre-existing date anomalies
that are preserved byte-for-byte and therefore cannot be submitted through
strict restore until a separately approved migration decision is made. This is
a known release gate; do not weaken validation or silently rewrite those dates.

## Server-only Sandbox scaffold

`plaid-sandbox.js` and `plaid-sandbox-runner.js` are server-only. They accept
user-entered values through hidden interactive prompts and keep client ID,
secret, public token, access token, and account mapping in process memory. They
do not read credential values from files, browser storage, command-line secret
arguments, or arbitrary environment variables. JSON export and ordinary object
logging omit those values.

Validation mode makes no network request:

```powershell
node plaid-sandbox-runner.js
```

Passing `--sync` explicitly performs a bounded, possibly paginated read from
the fixed Transactions Sync Sandbox endpoint. Passing `--create-item`
explicitly performs the documented Sandbox setup sequence, maps discovered
accounts to existing display names, and never persists setup output. Setup
creation and exchange are not retried automatically because an ambiguous
failure may have created an upstream Item. Transactions Sync retries preserve
safe stage/status/type/code/request-ID diagnostics, use the same in-memory
config/token, and never stage records from an incomplete or malformed response.

The default runner remains network-free. No repository test or local synthetic
run creates a Sandbox Item or reads a credential. A user-run real mode may
leave its upstream Sandbox Item when the process exits; this local code does
not inspect or delete it.

## Local verification

Install emulator dependencies and the browser runtime in the dedicated D:
verification cache, then use the checked-in `firebase.test.json` and
`demo-budget-tool` project. Keep `NODE_PATH`, emulator cache, temporary
directories, and browser cache under the D: verification directory. The
PowerShell wrapper `local-demo-bridge.ps1` starts only loopback Auth and
Firestore emulators, passes a non-secret environment allowlist to Firebase,
and selects one of these modes:

```powershell
& '.\local-demo-bridge.ps1' -Mode mock
& '.\local-demo-bridge.ps1' -Mode verify-mock-e2e
& '.\local-demo-bridge.ps1' -Mode verify-synthetic-e2e
```

The synthetic mode drives the same approved harness through injected setup,
provider, bridge, HTTP, and browser hooks. Its final 27-case matrix passed with
exit code 0. It covers readiness and transient recovery, permanent
auth/input/schema failures, malformed JSON and response shapes, body timeouts,
backend staging failures, browser disconnect/recovery, same-token reuse, one
setup call, terminal diagnostics, explicit approval, persistence, and reload.
No external provider request is made.

The separate local emulator E2E
(`tests/local-emulator-e2e.test.cjs`) exercises real Firebase Auth tokens,
Admin verification, the HTTP `BrowserApprovalClient`, durable Firestore
repositories, browser approval, reload, failed-commit retention, idempotent
replay, and direct-write denial with an injected provider. It uses loopback
emulators only.

The approved isolated Sandbox run completed through the same local path with
one setup call and these aggregate results: 48 raw observations, 30 skipped,
16 cutoff-excluded, 2 staged, and 2 approved/persisted/reloaded. The resulting
records were written only to the local emulator. This is local emulator
evidence and does not verify deployed Firebase, production IAM, hosting, or a
live-bank workflow.

The five core suites are:

```powershell
node tests/transaction-validation.test.cjs
node tests/review-core.test.cjs
node tests/transaction-backend.test.cjs
node tests/transaction-service.integration.test.cjs
node tests/plaid-sandbox.test.cjs
```

The browser smoke test additionally requires the configured Playwright module
and browser cache. Launcher argument checks run without starting emulators:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File '.\tests\local-demo-bridge-launcher.test.ps1'
```

## Proposed production implementation

The recommended target is a Firebase Functions 2nd-gen HTTPS adapter in the
existing `budget-tool-sync` project, after a separately authorized check of
the existing Firestore location. Keep the existing GitHub Pages frontend and
allow only `https://zmstiles-dev.github.io`. Select Node.js 22, currently
supported for Functions 2nd gen, when that future wrapper is implemented. Use
the managed runtime identity and Firebase Admin SDK; do not download
service-account keys.

The adapter should preserve the protected pending inbox, accepted-state
document, revision-bound receipts, connection ownership, provider cursor/run
state, and on-open delta/cooldown behavior. It should not add forced refreshes,
webhooks, scheduled jobs, or a browser-side provider path. Store the Plaid
client secret and per-Item access-token values in Secret Manager. Store only
ownership, non-secret connection references, stable account mappings, and
other non-secret provider metadata in protected Firestore documents.

Before deployment, implement and review a production transport, Secret
Manager resolver, deployed wrapper, exact CORS, configuration/IAM, safe error
serialization, rate/deadline controls, and monitoring. The platform wrapper
must adapt either its already-parsed body or its raw request stream to the
current handler; it must not blindly attach the current Node stream reader to a
platform request that has already been consumed.

Current official constraints checked 2026-10-18 UTC:

- Functions requires Blaze. Free allowances cover some compute and network
  usage, while build/container storage, Firestore, logs, egress, and existing
  project usage can still bill. Start with `minInstances=0`,
  `maxInstances=1` as capacity controls, not a cost guarantee.
- Secret Manager documents six active versions and 10,000 monthly accesses
  without charge; additional versions/accesses are billable.
- Firebase service spend caps are Preview, service-specific, and not hard caps
  because reporting latency can produce billed overage. Budget alerts notify
  but do not stop services.
- A $0 covered-workload estimate may be plausible for low local-scale traffic
  under the published allowances, but it is not a guaranteed $0 total or hard
  cap; current project billing and usage were not inspected.
- For scale planning only, three users opening four times per day across two
  connections would be about 720 delta starts per 30-day month; at an assumed
  five seconds each that is about 3,600 CPU-seconds before pagination or other
  requests. This is a conditional allowance comparison, not an all-in quote.
- Plaid Trial eligibility is limited to new US/Canada teams created on or after
  April 15, 2026, with up to 10 Production Items. Transactions is listed as a
  Trial product; removing an Item does not restore a Trial slot. This account's
  eligibility, remaining quota, institution coverage, and eventual pricing
  remain unverified. Sandbox usage is free, and no paid fallback is approved.

Sources: [Firebase Functions quotas](https://firebase.google.com/docs/functions/quotas),
[Firebase Functions configuration and Secret Manager](https://firebase.google.com/docs/functions/config-env),
[Firebase Functions runtime management](https://firebase.google.com/docs/functions/manage-functions),
[Firebase spend caps](https://firebase.google.com/docs/projects/billing/spend-caps),
[Firebase pricing plans](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans),
[Firebase pricing](https://firebase.google.com/pricing),
and [Plaid account billing](https://plaid.com/docs/account/billing/).

No production deployment, live data mutation, credential persistence, or PR
publication has occurred in this checkout.

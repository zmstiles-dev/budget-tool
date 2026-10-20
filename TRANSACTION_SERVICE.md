# Transaction service local setup

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

The current launch and operator documents are
[PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) and
[NETLIFY_FREE_SETUP.md](NETLIFY_FREE_SETUP.md). Firebase Functions and Secret
Manager material later in this file is retained reference work from the prior
milestone; it does not authorize Blaze billing or a Firebase deployment.

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

The October 9 date is the immutable activation baseline. Once activation is
ready, authenticated `/sync-settings` GET/POST can persist a valid runtime
cutoff through today with a strict connection-owner UID check and expected
settings revision. The setting affects the next sync only: that run pins its
cutoff and revision, keeps its incremental cursor, and never backfills,
deletes, or purges earlier inbox/history rows. Invalid, stale, backward, or
future updates fail closed. This runtime setting is local and unpublished with
the current release candidate.

The production Link metadata guard requires Chase `ins_56` and US Capital One
`ins_128026` before exchanging a public token. This is defense in depth; the
server's Item verification remains authoritative. On-open sync has a separate
durable activation gate at `protectedAppConfig/transactionService`: the
trusted operator keeps `syncActivation.enabled` false until both finalized
connection records are independently verified. Activation binds exactly
`chase` and `capital-one`, the inclusive cutoff `2026-10-09`, owner and
household, Item IDs, vault references, mapping policy revision, expected
institutions, and stable mapping hashes. Hashes cover account IDs, type,
subtype, currency, and explicit aliases while excluding cursor, lease,
last-sync, and other volatile sync fields. Every `/sync` request fresh-reads
the activation and both connection records, and rejects disabled, unresolved,
owner-mismatched, household-mismatched, or mapping-mismatched state. The
authenticated metadata-only `/sync-readiness` route performs the same check
without provider calls or writes; the frontend checks it before any on-open
provider request. A disabled or not-yet-activated configuration returns a
bounded `ready:false` response, so an inactive sync gate is a normal state and
does not become a provider call or a generic server failure. The local
synthetic dry-run packet is under
`D:\Documents\Codex\.assistant-storage\budget-tool-verification\free-backend-research\sync-activation-operator-20261019-r1`;
it performs no activation write.

The protected disconnect path is an explicit authenticated `POST` for the
configured unfinished target slot. Its immutable plan pins the target owner,
household, Item, institution, exchange receipt, encrypted-vault reference,
final mapping hash, replacement owner, and final connection. The transaction
rechecks those pins immediately before and after provider removal. A started
or ambiguous disconnect ledger blocks every create, exchange, status, and
finalize path until an operator performs read-only reconciliation. After a
successful removal, only the designated replacement owner may claim the
retired slot; a failed Link-token request may resume the same session, while a
different session or owner remains blocked.

The protected backend verifies the Firebase Admin ID token, operator-seeded UID
membership, fixed household configuration, connection ownership, and expected revisions
before every mutation. Pending inbox state is separate from accepted history.
Approval writes the canonical `shared/data` shape once and stores pending
review metadata, receipts, and audit state separately. Browser writes to
protected collections are denied by `firestore.rules`; settings updates in
`shared/data` require a revision increment and cannot change the transaction
array. Provider amendments carry a bounded server-created digest of their
accepted target row or split children; changing that target while review is
pending rejects the stale approval and requires a fresh staging/review pass.
Possible overlaps compare signed amount, normalized account, and a real date
within three days, then require matching merchant/description evidence. The
inbox recomputes warnings for existing pending rows and shows matched date,
description, merchant, amount, account, and reason. A warning remains a
reviewable candidate; accepted or jointly selected matches require an explicit
overlap override. The familiar CSV category popup is reused for pending rows
with date, description, merchant, amount, type, account, and category edits;
Save & Next only updates the revision-bound pending row, while Add selected is
the only approval path. These changes are local and unpublished.
Legacy accepted rows that fail strict review dates remain in canonical history
but are omitted from review metadata without date repair. A backup explicitly
exported from accepted history records a schema-1 compatibility marker when it
contains an opaque date string. Restore honors that marker only for the
accepted-history transaction array, preserves each string byte-for-byte, and
strips the transport marker before canonical persistence. Unversioned
four-field backups receive the same marker during migration, so export and
restore can be repeated without changing historical dates. New exports that
are not marked as accepted history, versioned backups without the marker,
review snapshots, CSV candidates, and provider observations retain strict real
date validation.
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
For the exact mapped `Checking Account` alias, an explicit provider `income`
classification or `INCOME`/`PAYROLL` category is stored as a positive income
amount. Checking reimbursements remain negative expenses, ordinary checking
expenses retain their provider sign, and other account aliases are unchanged.
Legacy untouched pending checking payroll rows are derived to the same positive
income form on hydration with a candidate revision bump; their signed provider
amount remains in `sourceOriginal`, accepted history is never rewritten, and a
reviewer changing the type back to expense restores that preserved negative
sign.

The production Functions wrapper is in `production-service.js` and
`functions/index.js`; its rollout, Secret Manager roles, exact origin, Link
create/exchange/update routes, and rollback procedure are documented in
`PRODUCTION_READINESS.md`. The wrapper remains sync-disabled until a separate
live activation decision.

The browser's protected restore route treats an explicitly marked accepted
history backup as a historical import. The private historical backup contains
four pre-existing date anomalies; they remain unchanged and are not made
reviewable or provider-syncable. The compatibility marker does not authorize
new or edited candidates, and no date is inferred or rewritten.

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

## Production implementation

The local target is a Firebase Functions 2nd-gen HTTPS adapter in the
existing `budget-tool-sync` project, targeting `us-central1` for the verified
`nam5` Firestore location. Keep the existing GitHub Pages frontend and allow
only `https://zmstiles-dev.github.io`. The wrapper targets Node.js 22 and
uses the managed runtime identity and Firebase Admin SDK; it does not
download service-account keys.

The adapter should preserve the protected pending inbox, accepted-state
document, revision-bound receipts, connection ownership, provider cursor/run
state, and on-open delta/cooldown behavior. It should not add forced refreshes,
webhooks, or scheduled jobs. The browser Link card is explicit-gated and sends
only a public token and reviewed account mapping. Store the Plaid
client secret and per-Item access-token values in Secret Manager. Store only
ownership, non-secret connection references, stable account mappings, and
other non-secret provider metadata in protected Firestore documents.

Before deployment, review the implemented production transport, Secret
Manager resolver, exact CORS, configuration/IAM, safe error serialization,
rate/deadline controls, and monitoring. The wrapper adapts either an already
parsed body or a raw request stream; it does not attach a second reader to a
platform request that has already been consumed. See
`PRODUCTION_READINESS.md` for rollout and rollback checks.

Current official constraints checked 2026-10-18 UTC:

- Functions requires Blaze. Free allowances cover some compute and network
  usage, while build/container storage, Firestore, logs, egress, and existing
  project usage can still bill. Start with `minInstances=0`,
  `maxInstances=1`, and request concurrency four as capacity controls, not a
  cost guarantee.
- Secret Manager documents six active versions and 10,000 monthly accesses
  without charge; additional versions/accesses are billable.
- Firebase service spend caps are Preview, service-specific, and not hard caps
  because reporting latency can produce billed overage. Budget alerts notify
  but do not stop services.
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
  marked as a Trial product on 2026-10-18. The remaining Production Item quota,
  institution coverage, and eventual pricing remain unverified. Official
  Trial terms describe up to 10 Production Items for eligible teams and do not
  restore a slot when an Item is removed. Sandbox usage is free, and no paid
  fallback is approved.

Sources: [Firebase Functions quotas](https://firebase.google.com/docs/functions/quotas),
[Firebase Functions configuration and Secret Manager](https://firebase.google.com/docs/functions/config-env),
[Firebase Functions runtime management](https://firebase.google.com/docs/functions/manage-functions),
[Firebase spend caps](https://firebase.google.com/docs/projects/billing/spend-caps),
[Firebase pricing plans](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans),
[Firebase pricing](https://firebase.google.com/pricing),
and [Plaid account billing](https://plaid.com/docs/account/billing/).

No production deployment, live data mutation, credential persistence, or PR
publication has occurred in this checkout.

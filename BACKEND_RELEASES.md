# Backend releases

The canonical command is `node scripts/backend-release.cjs`. It uses the
official Netlify file-digest API with single-attempt mutations. It does not
change account, environment, billing, GitHub Pages, or deployment settings.
Manual Netlify/API access remains a possible bypass; preventing that requires
separate account permissions and is outside these repository safeguards.

## Source and private retention

Backend source must be committed first. `prepare` requires an explicit current
commit and a completely clean checkout, including untracked nonignored files.
The manifest binds Git blob IDs and SHA256 values for the reviewed source
closure, the exact ZIP digest/size, every archive entry, the previous verified
deployment receipt, and its retained rollback artifact. No manifest contains
its own commit: manifests and postdeployment receipts are external records.

The default store is `D:/Documents/Codex/budget-tool-releases`:

```text
sha256/<zip-sha256>/budgetTransactions.zip
sha256/<zip-sha256>/inventory.json
releases/<release-id>/manifest.json[.sha256]
releases/<release-id>/journal.json
receipts/<deploy-id>.json[.sha256]
adoption-evidence/<deploy-id>/original-{proof,manifest}.json
locks/<site-id>.lock
claims/<site-id>.json
```

Initialize the external D: root before first use; commands fail if it is missing,
unsafe, or on C:. There is no C: fallback. `--store` can select an existing
ignored task-local directory for offline commands/tests. Real preflight,
apply and reconcile commands always require the policy's canonical store,
including when an environment override is supplied, so two stores cannot
split the site's production lock. Retention cannot be under Netlify or
public output. Descendant symlinks/reparse paths are rejected. Do not commit
ZIPs, inventories, original evidence, credentials, logs, statements, backups,
financial CSVs, or node_modules. The pre-existing tracked CSVs are outside the
backend release closure and must not be copied into archives or CI checkouts.

Git/runtime text uses LF. Source verification compares committed blobs and
checkouts after CRLF-to-LF normalization. The production runtime additionally
replaces the standalone legacy email fallback with an empty array. Historical
raw archive/source hashes are retained unchanged. ZIP byte reproducibility is
not promised: the bundler embeds a staging path/PID comment and ZIP metadata
can vary. Rollback always uses the retained exact verified ZIP.

## Adopt an already deployed archive

This is an explicit historical import, not a claim that the archive was built
from a later commit. The adoption command checks exact archive identity,
canonical runtime equivalence, the original source's raw manifest hashes,
normalized function entry/dependency files, supplied verified deployment
metadata, and a retained rollback ZIP. It does not authenticate or contact
Netlify. Existing evidence is an operator trust input, not a cryptographic
signature; its original bytes and checksum are retained.

```powershell
node scripts/backend-release.cjs adopt --commit <clean-current-commit> --store D:\Documents\Codex\budget-tool-releases --archive <verified-current-zip> --rollback-archive <verified-rollback-zip> --historical-source <original-source-root> --historical-manifest <original-manifest.json> --proof <verified-existing-proof.json>
node scripts/backend-release.cjs export-summary --store D:\Documents\Codex\budget-tool-releases --deploy <current-deploy-id>
```

`export-summary` writes only `backend-release.current.json`: deployment/source
commit, archive/rollback identities, normalized runtime hashes, and the private
receipt checksum. Review and commit that sanitized public association in a
later commit. `verify-public` checks the association against its historical Git
source commit. It does not require private artifacts or imply a fresh live API
check; CI cannot prove private retention availability or current production.

Proof schema: version 1, `verified: true`, fixed site ID/host, `deployId`,
`published: true`, a `function` object containing name/SHA256/size/runtime/API
version/bootstrap/invocation/memory/region/`schedule: null`, and
`rollback: { deployId, artifact: { sha256, size } }`. Original proof and source
manifest must come from independent authenticated verification. A handwritten
`verified: true` alone is not independent deployment evidence.

## Prepare and review a future release

Use Node 24. Install dependencies only from the pinned Netlify lock using the
approved public-package process. Builds default to `.local/temp` and
`.local/npm-cache`, or explicit `BUDGET_BUILD_TEMP`/`BUDGET_NPM_CACHE` D: paths.
Production staging runs offline and uses the production dependency lock.

```powershell
git status --porcelain
node --test --test-concurrency=1 tests/review-core.test.cjs tests/transaction-backend.test.cjs tests/transaction-service.integration.test.cjs tests/provider-import-exclusions.test.cjs tests/merchant-defaults-regression.test.cjs
node --test --test-concurrency=1 tests/backend-release-guard.test.cjs
node scripts/backend-release.cjs prepare --commit <clean-current-commit> --release <unique-release-id> --baseline <last-verified-deploy-id>
node scripts/backend-release.cjs verify --manifest <retained-manifest.json>
```

Preparation always invokes the canonical builder. Verification rejects dirty
source, changed pins, missing/unretained archives, inventory/record tampering,
source/runtime mismatch, and changed baseline/rollback bindings. Checksums
detect corruption and unintended changes; they are not signatures against an
attacker able to rewrite all local evidence. Functional acceptance of the
actual package remains an independent review requirement; integrity checks do
not substitute for business regression testing.

## Authorized operator only

Before preflight/apply/reconcile, the pinned source must be an ancestor of the
locally fetched `origin/main` ref. Fetching that ref freshly and reviewing the
commit is a procedural requirement; a local ref alone does not authenticate
the remote. Publishing/merging main may trigger Pages and needs its own
authorization. This change does not merge, push, deploy, or modify settings.

The operator sets `BUDGET_NETLIFY_CLI_ROOT` to the reviewed private installation
of Netlify CLI 27.13.0 and `BUDGET_NETLIFY_AUTH_HOME` to its separately approved
D: auth root with appdata/localappdata/temp children. Never put credentials in
arguments, source, manifests, output, or a CI environment. Local provenance
verification runs before importing the CLI authentication bootstrap.

If an independently reviewed checkout was created under another Windows user,
an operator may need a process-scoped Git `safe.directory` entry for that exact
checkout (using `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0`). Do not
add universal trust or change global Git configuration. This addresses Git's
ownership check and does not authorize a deployment.

```powershell
node scripts/backend-release.cjs preflight --manifest <retained-manifest.json>
node scripts/backend-release.cjs apply --manifest <retained-manifest.json> --confirm <exact-release-id>
node scripts/backend-release.cjs reconcile --manifest <retained-manifest.json>
node scripts/backend-release.cjs receipt --deploy <verified-deploy-id>
```

Preflight freshly verifies the current published site/deploy, exactly one
function, zero static files/schedules, digest/size, Node24, API2, bootstrap2.24.0,
streaming, 1024 MB and us-east-2. Creation uses the known accepted minimal
`draft/functions/build_data` body. Memory/region are inherited, with effective
pre/post checks, because this site's Free plan rejects region overrides.

The canonical store's site lock and hash-chained journal prevent concurrent or
repeated writes. A persistent site claim is written before POST and binds the
site, release ID and manifest checksum. It survives ambiguity, blocks other
release IDs before authentication, and is cleared only after exact verified
publication/GET reconciliation. Changing the release ID cannot bypass a failed
or unresolved attempt.
One POST can be followed by at most one exact-byte PUT. Any failure or missing
proof is terminal for mutation attempts; no automatic mutation retry occurs.
GET-only reconciliation can finish a bound upload only after fresh publication
and configuration proof. A successful receipt is a separate immutable record
binding source commit, manifest checksum, exact ZIP, new deployment ID, and
rollback. An interrupted lock is never automatically stolen. Investigate it
and the journal before an authorized operator removes it; never reset a
consumed journal to obtain another attempt.

A known rejected create (including HTTP 422) still requires read-only operator
verification and an explicit reviewed recovery action. There is no automatic
claim reset or new-release retry, even when a failed deployment ID is known.

## CI and limits

The backend-provenance workflow runs offline source/guard tests and validates
the sanitized public association. It does not install credentials, deploy,
upload artifacts, read live financial data, or change settings. It becomes
effective only after the reviewed workflow is merged/enabled. Branch
protection/account permissions are not configured by this work. Retention
backups and disaster recovery beyond the verified D: store are operational
responsibilities.

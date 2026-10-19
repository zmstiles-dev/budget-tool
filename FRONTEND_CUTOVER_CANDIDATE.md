# Frontend cutover candidate

This is a local review artifact for the coordinated frontend/backend rollout.
The candidate file is not loaded by `index.html`. The checked-in template now
assigns the reviewed production request path while Link, sync, and active
connections remain disabled.

The reviewed nonsecret candidate targets the existing Netlify site, with the
current visibility setting making production public and Deploy Previews private:

```text
site ID: a429bdf1-47c9-4bb0-9e9d-7f5cdf8d416d
site host: stiles-budget-tool.netlify.app
function endpoint: https://stiles-budget-tool.netlify.app/.netlify/functions/budgetTransactions
browser origin: https://zmstiles-dev.github.io
Link: false
sync: false
active connections: empty
```

The candidate is in
[`deployment-config.production-candidate.example.js`](deployment-config.production-candidate.example.js).
The shipped [`deployment-config.template.js`](deployment-config.template.js)
now carries this exact endpoint. The browser obtains a
Firebase ID token through its existing signed-in Firebase user; no token or
Netlify cookie is copied into configuration.

The reviewed endpoint-only edit is preserved outside the checkout at
`D:\Documents\Codex\.assistant-storage\budget-tool-verification\free-backend-research\endpoint-activation.patch`
(SHA-256
`c10d9c7d810fcb1585978d96a534a339eae6a7a0a985ee9b471264f577f067b8`). It
changes only the template endpoint; the provider gates and connection
allowlists remain disabled and empty. The patch is now applied to the checked-in
template and covered by `tests/frontend-cutover-candidate.test.cjs`.

The current private accepted-history checkpoint supplied for this cutover is
`D:\Documents\Codex\private\budget-tool\cutover-checkpoint-20261019T150028Z`.
Its reviewed metadata records 2,807 transactions, 4 opaque legacy dates, and
SHA-256
`83f130c2bdbbec3e1345c4f065df397f8ff3c4d59acad61346a8f0bde8887826`.
Keep the checkpoint private and preserve all opaque date strings byte-for-byte;
it is a rollback/recovery artifact, not a migration input.

The current cutover record is:

1. The private accepted-history checkpoint above is the current backup-first
   artifact. Preserve its 2,807 transactions and 4 opaque dates byte-for-byte;
   do not normalize dates, overwrite `shared/data`, export secrets, or treat
   the ignored `budget-data.json` as a new backup. The code rollback baseline is
   `b807c5dc052a601916dc536238df4e5ec77a93c2`, and the main rollback baseline
   is `875321f100b33c33499d8c09bcf9918c3aa10465`. Before opening the normal app
   for validation, a private manifest must record the checkpoint path/count/hash,
   deployed-rules bytes/hash, and served frontend commit/file hash. Missing or
   mismatched `shared/data` count/hash is a hard stop because the app's missing
   document branch can migrate local state and issue an automatic save.
2. The strict Firestore rules for project `budget-tool-sync` have been deployed
   by the root operator. The fixed protected household configuration and four
   approved existing memberships were verified separately. Preserve the prior
   rules snapshot for rollback; no provider operation or accepted-state
   migration is part of this candidate.
3. Netlify currently has production public and Deploy Previews private, using
   **Private** with **Applies to: Previews only**. The function artifact is
   unchanged. Link and sync remain disabled and active connections remain empty.
4. GitHub Pages is configured as **Deploy from a branch**, branch `main`, path
   `/`. Merging the reviewed frontend change to `main` is the endpoint
   publication event and is still pending. No Netlify function redeploy is
   required.
5. After that Pages deployment is published, fetch
   `https://zmstiles-dev.github.io/budget-tool/` and verify the served page
   origin is exactly `https://zmstiles-dev.github.io` and the served
   `deployment-config.template.js` contains the approved endpoint, disabled
   Link/sync gates, and empty active-connection list. Verify the Pages commit is
   the approved `main` revision; a local checkout is insufficient.
6. A signed-in, review-only browser check with an existing approved user remains
   pending. Run it only after the served-config check and the `shared/data`
   backup precondition pass. The auth flow obtains pending review before normal
   layout rendering, then loads `shared/data` and refreshes protected review
   state. This remains review-only: it may read the backed-up `shared/data`
   document after the precondition passes, but it must not persist, migrate, or
   delete production budget data.

Rollback first restores Netlify **Private** with **Applies to: Production and
Deploy Previews**, then restores the prior trusted frontend revision or returns
the endpoint to the empty template, and restores the preserved prior rules
snapshot. Leave backend provider gates disabled. Preserve the protected review
inbox, accepted history, sync cursors, exchange ledger, and encrypted vault
versions while rolling back application code. Do not automatically restore or
rewrite budget history; use the separately approved private snapshot only for
recovery after checking its count/hash and opaque-date evidence. Existing
opaque legacy dates remain byte-for-byte unchanged and are handled only by the
marked accepted-history restore path; no production backup export, restore, or
history migration is authorized here.

The local persistence proof remains emulator-only. Use
`tests/production-emulator-e2e.test.cjs` with project `demo-budget-tool` and
loopback Auth/Firestore (`127.0.0.1:9099` / `127.0.0.1:8088`). Its accepted
fixture is `shared/production-integration-accepted`, with synthetic protected
review/config/membership documents that are removed in cleanup. Do not use the
   production `shared/data` document for live persistence, migration, or
   deletion. A signed-in verification may read it only after the private
   backup/count/hash precondition passes.

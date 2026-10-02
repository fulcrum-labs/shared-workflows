# Forgejo cutover inventory — fulcrum-labs/shared-workflows

Prepared 2026-09-29 for the GitHub → Forgejo cutover (batch 4, class D — the
last repository to move). This is a preparation branch: nothing is flipped here
and `.github/workflows/` is untouched.

**Inventory only.** This repository's six files under `.github/workflows/` are
reusable workflows, not CI. They have no `push`, no `pull_request` and no
`workflow_dispatch` — only `workflow_call` — so nothing in them runs until
another repository calls them. The lane brief is explicit that they are not to be
translated here, and this branch does not add a `.forgejo/workflows/` directory.
What follows is the inventory, and the shape of the translation the lead will
need.

The one genuinely good piece of news in this inventory is at the bottom: at
`origin/main` there is **no GitHub storage and no cache anywhere in these six
files**. The estate's own work already got there.

## The six files

| File | Lines | `on:` | Jobs | `runs-on` |
|---|---|---|---|---|
| `ci-gate.yml` | 647 | `workflow_call` | `quality`, `docs-lint`, `gitleaks`, `semgrep`, `grype`, `trigger-cf-build` | `[self-hosted, Linux, X64]` × 6 |
| `d1-migrations-apply.yml` | 152 | `workflow_call` | `apply` | × 1 |
| `deploy-gate.yml` | 1136 | `workflow_call` | `deploy` | × 1 |
| `go-cold-cache.yml` | 121 | `workflow_call` | `cold-build` | × 1 |
| `preview-gate.yml` | 279 | `workflow_call` | `build` | × 1 |
| `worker-rollback.yml` | 194 | `workflow_call` | `rollback` | × 1 |

**Eleven `runs-on: [self-hosted, Linux, X64]` across six files.** Every job in
this repository. On Forgejo no `go` / `node` / `light` slot matches that label,
so not one of these reusable workflows can schedule. This is the single blocker
for the whole class-A and class-B estate, because so many repositories' CI is a
one-line call to `ci-gate`.

Six of the eleven also carry the comment `# break-glass: swap runs-on back to
ubuntu-24.04 if self-hosted fleet unavailable`. `ubuntu-24.04` is a GitHub-hosted
label, so the documented break-glass is a fallback back onto GitHub. On Forgejo
there is no such thing, and the "break glass" has to become something else or be
deleted.

## Triggers

Every one of the six is `on: workflow_call:` and nothing else. Consequences:

- No `push`, no `pull_request`, no `workflow_dispatch`, no `schedule`, no
  `merge_group`, no `workflow_run`, no `pull_request_target` — in any of the six.
  (The one exception to check: `go-cold-cache.yml`'s `concurrency` block reads
  `cancel-in-progress: ${{ github.event_name != 'schedule' }}`, which implies a
  scheduled caller somewhere in the estate. That is a caller's trigger, not this
  repository's.)
- Because there is no `workflow_dispatch`, **there is no way to exercise any of
  these on Forgejo without a caller.** A test repository calling each one is the
  only way to prove them. `grant-phillips/ledger-qualify` is the existing
  writable practice copy and lane 1 is already proving `ci-gate` and
  `d1-migrations-apply` there.
- A reusable workflow's `runs-on` is evaluated in the *caller's* context, so the
  label change here is the whole of the runner work — there is no caller-side
  label to coordinate.

## `uses:` pins

| `uses:` | Pin | Files | On Forgejo? |
|---|---|---|---|
| `actions/checkout` | `@d23441a48e516b6c34aea4fa41551a30e30af803` (v5, commit) | `go-cold-cache` | Yes |
| `actions/checkout` | `@v5` (major tag) | `ci-gate` ×4, `d1-migrations-apply` ×2, `deploy-gate`, `preview-gate` | Yes |
| `pnpm/action-setup` | `@v6.0.8` (semver tag) | `ci-gate` ×2, `deploy-gate`, `preview-gate` | Yes |
| `actions/setup-node` | `@v5` (major tag) | `ci-gate` ×2, `deploy-gate`, `preview-gate` | Yes — **no `cache:` input at this pin** |
| `anchore/scan-action` | `@v7.4.0` (semver tag) | `ci-gate` (`grype`) | Yes — allow-listed, `cache-db: false` |
| `actions/github-script` | `@v8` (floating major tag) | `deploy-gate`, `preview-gate` | Yes — allow-listed, but floating |
| `actions/setup-go` | `@924ae3a1cded613372ab5595356fb5720e22ba16` (v6, commit), `cache: false` | `go-cold-cache` | **No** — removed |
| `fulcrum-labs/shared-workflows/.github/actions/go-private-modules` | — | not used here | — |

Two pins are floating major tags (`checkout@v5`, `setup-node@v5`,
`github-script@v8`, `setup-python` is not used). The mirrored actions were built
for the versions the estate pins and the mirrors preserve tags, so `v5` and
`v6.0.8` resolve; that is a reason to leave them, not a reason to pin them
differently in a cutover.

FINDING: `go-cold-cache.yml`'s first input is `go-version`, described as "Go
toolchain version for `actions/setup-go` (the caller pins it, as its CI does)",
and it feeds that step directly. Removing `setup-go` — required, it is not
allow-listed and Go is in the image — makes the input's stated purpose false.
Every caller that passes `go-version:` (fulcrum-projects' `cold-cache.yml` is
one) has to stop passing it, or the input has to be renamed to something honest
like `expected-go-version` and turned into an assertion.

## Secrets

| Secret | Declared in | Used for |
|---|---|---|
| `CF_BUILDS_TOKEN` | `ci-gate` (`workflow_call.secrets`, optional) | `trigger-cf-build` only |
| `TURBO_CACHE_TOKEN` | `ci-gate` (optional) | the signed Turbo remote cache, `quality` |
| `TURBO_CACHE_SIGNATURE_KEY` | `ci-gate` (optional) | ditto |
| `CF_API_TOKEN` | `d1-migrations-apply` | `wrangler d1 migrations apply` |
| `CF_DEPLOY_API_TOKEN` | `deploy-gate`, `worker-rollback` | the deploy, preview-adjacent reads, the rollback |
| `CF_PREVIEW_API_TOKEN` | `preview-gate` | `wrangler versions upload` |

All are optional or caller-supplied; this repository holds none of them itself and
names no `secrets.*` at the repository level. Nothing was read, listed, written
or minted in preparing this branch.

For class B and C repositories these are the secrets the lead has to declare as
Forgejo secrets through the vault → Forgejo sync (infra #417/#431) before those
repositories flip. Listing them here is the inventory's job; loading them is not.

## Artifacts

**None at `origin/main`.** No `actions/upload-artifact` and no
`actions/download-artifact` in any of the six files.

This is worth stating precisely, because the estate's own record shows the work
is already done: `ci-gate.yml`'s `grype` job carries the comment "The SARIF pass
was dropped: nothing read its output once Actions artifact storage stopped being
used (operator ruling 2026-09-27)", and the job that remains is a single
`anchore/scan-action@v7.4.0` pass with `output-format: table`, `fail-build: true`,
`severity-cutoff: high`, `grype-version: v0.117.0` and `cache-db: false`. The
table output goes to the job log, which is what actually fails the job — the file
explains that before this step existed, GHSA-26w7-cxv4-gfx2 (astro RCE) went
unnamed across the fleet for two days because the SARIF went to an unretained
temp file and code scanning is off on most repositories.

So the shared gate needs no release-store put and no drop. The gate that is
already closed, per the no-GitHub-storage plan.

## Caches

**None at `origin/main`, either.** No `actions/cache` in any of the six files.

- `ci-gate.yml`: `actions/setup-node@v5` carries **no** `cache:` input at this
  pin, and the `grype` job passes `cache-db: false` with the comment "Fresh DB
  per job, never the Actions cache: a restored copy went stale on the self-hosted
  fleet and grype aborted on its max-age check (invoice-portal run 32390381477,
  forge-7, 2026-08-20)".
- `go-cold-cache.yml` passes `cache: false` to `setup-go` and then points
  `GOCACHE`, `GOMODCACHE` and `GOTMPDIR` at an empty `$RUNNER_TEMP/go-cold-cache`
  for the job. That workflow's entire purpose is proving a build from cold
  caches, so this is the estate's cache policy expressed as a job.
- `ci-gate.yml`'s pnpm handling is a `Guard pnpm runner isolation` step that
  exports both `npm_config_store_dir` and `pnpm_config_store_dir` to
  `$RUNNER_TEMP/pnpm-store` — a per-run directory under the ephemeral workspace,
  not a cache. The comment records why: on 2026-09-25/26 every job on a host
  silently shared the runner unit's `/var/cache/ci/pnpm` and their installs raced
  one store (`ERR_PNPM_ENOENT copyfile` / `READ_FROM_STORE`). That isolation
  step must be preserved verbatim in any translation, and it is a good precedent:
  ephemeral slots need less cache hygiene than persistent runners, not more.

The one optional cache-shaped thing left is the **signed Turbo remote cache**
(`turbo-cache-enabled`, `turbo-cache-api`, `turbo-cache-team`,
`TURBO_CACHE_TOKEN`, `TURBO_CACHE_SIGNATURE_KEY`, and a
`steps.turbo-cache.outputs.eligible` gate that keeps fork pull requests
uncached). It is a remote cache with its own signed protocol, not
`actions/cache`, and it is opt-in per caller. FINDING: nobody should assume it
works on Forgejo. The Forgejo job would have to reach the Turbo remote cache API
from the executor container, and the signature key would be a new Forgejo secret
in every repository that opts in. It is off by default
(`turbo-cache-enabled` defaults to `false`), so nothing breaks — but any caller
that turns it on has a Forgejo answer to find first.

## GitHub API calls

- `deploy-gate.yml` and `preview-gate.yml` use `actions/github-script@v8`.
  Both need to be read: the deploy gate's job is Cloudflare-facing (it diffs a
  built wrangler config against a live Worker's settings — the file's own words),
  so the question is whether the script calls `api.github.com` or only
  `api.cloudflare.com`. **UNVERIFIED here**: this is a 1136-line file and reading
  every script body was out of scope for an inventory pass. It is the one thing
  in this repository that could be a hidden GitHub dependency, and the plan's
  own class-B entry says "UNVERIFIED: that every site's deploy-gate call is
  wrangler-only with no `gh` call inside". **The lead already knows. This
  inventory confirms the question is still open and is scoped to `deploy-gate`
  (1136 lines) and `preview-gate` (279 lines).**
- `ci-gate.yml`'s `trigger-cf-build` posts to
  `https://api.cloudflare.com/client/v4` (Workers Builds manual trigger), not to
  GitHub. No `gh` anywhere in these six files.
- `d1-migrations-apply.yml` calls `wrangler d1 migrations apply`; `deploy-gate`
  and `preview-gate` call `wrangler deploy` and `wrangler versions upload`;
  `worker-rollback` calls `wrangler rollback` and `wrangler deployments status`.
  All Cloudflare, all via the pinned `wrangler` the jobs install.

## macOS

None. No `macOS` label, no Xcode, no Apple secrets, in any of the six files.

The macOS work in this cutover belongs to the repositories that *call* these
workflows with a macOS job of their own: `fulcrum-labs/foundry-shell` and
`fulcrum-labs/golem-ios`, and `fulcrum-labs/fulcrum-projects`' `ios-testflight`
and `ios` workflows. This repository has no part in it, which is one reason it is
last.

## Deploy path

Four of the six are deploy paths, all Cloudflare, all through `wrangler` on the
runner — which is the shape the cutover plan wants:

| File | What it does | Mutating? |
|---|---|---|
| `deploy-gate.yml` | `wrangler deploy` behind an `environment:` input, with a generated minimal `--config`, a config-vs-live-Worker diff, and a migration pre-check against every `migrations_dir` | Yes — production |
| `preview-gate.yml` | `wrangler versions upload`, reading a `preview_urls/workers_dev` URL if the Worker has one and warning when it does not | Yes — a version, not production traffic |
| `worker-rollback.yml` | `wrangler rollback <version-id>`, requires a recorded reason, `wrangler deployments status --json` before and after | Yes — production |
| `d1-migrations-apply.yml` | `wrangler d1 migrations apply`; the header records that a 5xx from this path "5xx'd for ~14 minutes" once | Yes — a database |

`deploy-gate` and `worker-rollback` both declare `environment:
${{ inputs.environment }}`, so the caller's environment string is the gate. On
Forgejo, environments exist and secrets bind to them, so the shape survives; what
has to be re-declared is every `CF_*_API_TOKEN` in each calling repository.

`ci-gate.yml`'s `trigger-cf-build` is the one path the plan retires: it is
Cloudflare Workers Builds' GitHub integration, and the plan replaces it with the
wrangler path in `deploy-gate`. The job is already opt-in and already skippable
(it exits 0 with a warning when `CF_BUILDS_TOKEN` is absent), so retiring it is a
deletion rather than a rewrite — **after** every caller's site has a working
`deploy-gate` path, which is lane 3's Batch 3 work.

## Dependabot

No `.github/dependabot.yml` and no `.github/dependabot.yaml` in this repository,
so there is nothing for Renovate to replace. There is no root `renovate.json`
either.

This is the one repository in the estate where that matters most: the pins that
every other repository's CI depends on — `actions/checkout@v5`,
`pnpm/action-setup@v6.0.8`, `actions/setup-node@v5`, `anchore/scan-action@v7.4.0`,
`actions/setup-go@924ae3a…`, and the mirrored `actions/github-script` — all live
here. Nothing currently keeps them current, and `actions/setup-go@924ae3a…` is
about to be removed by this cutover. **Renovate on shared-workflows is not
housekeeping; it is how the estate finds out that a pinned action stops
resolving.**

## What the translation needs

Not done here, by instruction. Recorded so the lead has the list:

1. `runs-on: [self-hosted, Linux, X64]` → `go` / `node` / `light` per job, and
   the six `# break-glass: swap runs-on back to ubuntu-24.04` comments dealt
   with.
2. `go-cold-cache.yml`: drop `actions/setup-go`, and either drop the `go-version`
   input or rename it and turn it into an assertion against the image's Go.
3. `ci-gate.yml`'s `trigger-cf-build`: delete, once every caller has a
   `deploy-gate` path.
4. Nothing else needs removing. That is the finding, and it is a good one.

## FINDINGS

1. **Eleven `[self-hosted, Linux, X64]` labels across six files, and no Forgejo
   slot matches them.** Not one job in this repository can schedule on Forgejo
   today. Because so many repositories' entire CI is a one-line call to
   `ci-gate`, this is the highest-leverage single fix in the whole cutover: until
   shared-workflows is translated, every class-A and class-B repository with a
   generated or `shared-workflows` gate has a Forgejo workflow that cannot start.
   **shared-workflows is on the critical path for Batch 3 and Batch 4, not
   merely "last".**
2. **Six jobs carry `# break-glass: swap runs-on back to ubuntu-24.04 if
   self-hosted fleet unavailable`.** `ubuntu-24.04` is a GitHub-hosted label, so
   the documented escape hatch from a broken self-hosted pool is a fallback back
   onto GitHub. On Forgejo that fallback does not exist and the comment is
   actively misleading. Either it becomes a different fallback or it is deleted.
3. **`go-cold-cache.yml`'s `go-version` input becomes false.** It is described as
   "Go toolchain version for `actions/setup-go`" and feeds that step directly.
   `setup-go` must go. Callers that pass it (fulcrum-projects' `cold-cache.yml`
   is one) have to stop, or the input has to be renamed and turned into an
   assertion. A reusable workflow whose input documentation lies is worse than
   one that has lost the input.
4. **No release-store work is needed here, and that is already true.** No
   `upload-artifact` and no `download-artifact` in any of the six files at
   `origin/main`. `ci-gate`'s `grype` job already dropped its SARIF pass under
   the 2026-09-27 operator ruling precisely because nothing read it once Actions
   artifact storage stopped being used. The shared gate is the one part of the
   estate that has already satisfied the no-GitHub-storage rule.
5. **No cache work is needed here either.** No `actions/cache` in any of the six
   files; `setup-node@v5` carries no `cache:` input at this pin; `grype` passes
   `cache-db: false`; `go-cold-cache` points every Go cache at an empty
   `$RUNNER_TEMP` and then proves a cold build, which is the policy expressed as
   a job. The pnpm store is already isolated to `$RUNNER_TEMP` by a dedicated
   step, and that step must be preserved verbatim — the comment records the
   2026-09-25/26 incident where every job on a host silently shared
   `/var/cache/ci/pnpm` and their installs raced one store.
6. **The signed Turbo remote cache is the one unresolved cache-shaped thing.**
   `turbo-cache-enabled` defaults to `false`, so nothing breaks, but any caller
   that turns it on needs the executor container to reach the remote cache API
   and needs `TURBO_CACHE_TOKEN` and `TURBO_CACHE_SIGNATURE_KEY` as Forgejo
   secrets. Nobody should assume it works.
7. **`deploy-gate.yml` and `preview-gate.yml`'s `actions/github-script@v8` bodies
   are UNVERIFIED for GitHub API calls.** This is the plan's own open class-B
   question ("UNVERIFIED: that every site's deploy-gate call is wrangler-only
   with no `gh` call inside"), scoped to 1136 + 279 lines. Reading every script
   body was out of scope for an inventory pass and it is the one place in this
   repository that could hide a GitHub dependency. **The lead already knows this
   is open; this inventory confirms the scope and that it is still unanswered.**
8. **`actions/github-script@v8` is a floating major tag** on the action the
   mirror was built for, and so are `checkout@v5` and `setup-node@v5`. The
   mirrors preserve tags, so they resolve. Not a cutover problem; a Renovate
   problem, and shared-workflows is the repository where that matters most.
9. **There is no `workflow_dispatch` on any of the six**, so nothing here can be
   exercised on Forgejo without a caller. `grant-phillips/ledger-qualify` is the
   existing writable practice copy and lane 1 is already proving `ci-gate` and
   `d1-migrations-apply` there. Four more reusable workflows
   (`deploy-gate`, `preview-gate`, `go-cold-cache`, `worker-rollback`) have no
   such proving ground yet, and `deploy-gate` and `worker-rollback` mutate
   production.
10. **Renovate on this repository is not housekeeping.** The pins every other
    repository's CI depends on all live here, nothing keeps them current, and
    `actions/setup-go@924ae3a…` is about to be removed by this cutover. This is
    how the estate finds out that a pinned action stops resolving.
11. `deploy-gate.yml` is 1136 lines and `worker-rollback.yml` mutates production
    behind an `environment:` input. Both need the same security review the lane
    brief reserves for "auth, secret and grant code" before they run on a new
    forge with new secret declarations.

## Reuse

Inventory only. This repository's reusable workflows are not translated by this
branch, per the lane brief; the "what the translation needs" list above is the
hand-off.

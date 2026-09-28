# publish-build: storing and verifying main-branch builds

Operator ruling 2026-09-27: nothing in the estate is stored in GitHub Actions
artifact storage. A build that an installer downloads is published by the
composite action `.github/actions/publish-build` as an asset on a rolling
prerelease in the producing repo (tag `ci-builds` by default). The asset is
not the source of trust. The trust anchor is a single log line printed by the
main push run that built it:

```
FULCRUM-BUILD-DIGEST <name>.tar.gz sha256=<64 hex> run=<run id> attempt=<n> sha=<40-hex commit>
```

Only code that is already on `main` runs in a main push run, and only that run
writes its own log. So a consumer trusts an asset only when the asset's sha256
equals the digest printed by the main push run of the producing workflow for
that commit. The asset is uploaded with `--clobber`, so anyone who can write
releases can replace it. The protocol below still refuses a replaced asset,
because the replacement's sha256 will not match the digest in the log.

## Producer

```yaml
jobs:
  publish:
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: [self-hosted, Linux, X64]
    permissions:
      contents: write
    concurrency:
      group: publish-build-${{ github.repository }}
      cancel-in-progress: false
    steps:
      # ... build dist/foundryd ...
      - uses: fulcrum-labs/shared-workflows/.github/actions/publish-build@<sha>
        with:
          name: foundry-linux-amd64-${{ github.sha }}
          files: |
            dist/foundryd
```

- `name` is `<prefix>-<GITHUB_SHA>`. The action refuses any other commit, a
  short sha, or characters outside `A-Z a-z 0-9 . _ -`.
- The action fails, and publishes nothing, on any event other than `push` to
  `refs/heads/main`.
- Packing is deterministic: GNU tar with `--sort=name --mtime=@0 --owner=0
  --group=0 --numeric-owner --format=gnu`, then `gzip -n`. File modes are kept.
  Paths must be relative and contain no `..`. On macOS the runner needs `gtar`.
- The release keeps the newest `keep` (default 30) assets named exactly
  `<prefix>-<40hex>.tar.gz`. Assets with other prefixes are never pruned.
- Outputs: `asset` (`<name>.tar.gz`) and `sha256`.

## Consumer protocol

Inputs: the producing repo `R`, its producing workflow file `W` (for example
`.github/workflows/ci.yml`), the commit `S` (full 40 hex), the build `N`
(`<prefix>-S`), and the release tag `T` (default `ci-builds`). The consumer's
token needs `actions:read` (to read run logs) and `contents:read` on `R`.

Do every step in order. If any step fails, **refuse**: install nothing and
exit non-zero with a message that names the step. Never fall back to trusting
the asset without the digest.

1. **Resolve the main push runs of `W` for `S`.**
   `gh api "repos/R/actions/runs?head_sha=S&event=push&branch=main&per_page=100"`.
   The query parameters only filter, so check each returned run yourself and
   keep a run only if all of these hold: `event == "push"`,
   `head_branch == "main"`, `head_sha == S`, `path == W`, and
   `head_repository.full_name == R`. If no run is left, refuse.
2. **Find the digest.** For each kept run, list its jobs for the latest attempt:
   `gh api --paginate "repos/R/actions/runs/<run id>/jobs?filter=latest&per_page=100"`.
   For each job with `status == "completed"` and `conclusion == "success"`,
   fetch its log with `gh api repos/R/actions/jobs/<job id>/logs`. Every raw log
   line starts with an ISO-8601 timestamp and one space. Strip that prefix,
   then match the whole line against:

   ```
   ^FULCRUM-BUILD-DIGEST N\.tar\.gz sha256=([0-9a-f]{64}) run=<that run id> attempt=([0-9]+) sha=S$
   ```

   Here `run=` must equal the id of the run the log came from. A line that
   fails the anchored match does not count, even if it contains the text.
   Collect the distinct sha256 values across all kept runs and jobs. There
   must be **exactly one**. Refuse if there are none, and refuse if there are
   two or more.
3. **Download the asset** into a fresh, empty directory:
   `gh release download T -R R -p 'N.tar.gz' -D <dir>`. Refuse if the download
   fails or if the directory does not then hold exactly one file named
   `N.tar.gz`.
4. **Compare.** Compute the file's sha256 with `sha256sum` (Linux) or
   `shasum -a 256` (macOS). Refuse unless it equals the digest from step 2.
5. **Only then unpack**, into a fresh directory. Refuse any archive member
   whose path is absolute or contains `..`. The producer never writes one, so
   such a member means the archive is not the one the producer made. Install
   from what was unpacked.

### What a consumer must refuse on

- No main push run of `W` for `S`. This covers a commit that is not on main,
  a build that never ran, and a run from another workflow, branch, fork, or
  event.
- A digest line from a `pull_request` run, a `workflow_dispatch` run, or any
  other non-push or non-main run. **Such a line never counts.** A pull request
  runs its author's code, which can print any line it likes. A PR's head sha
  can also equal the commit that later lands on main (fast-forward or rebase
  merges), so matching on the commit alone is not enough.
- A digest from a job that is not `completed` with conclusion `success`, or
  from an attempt other than the latest.
- Run logs that cannot be read. This includes a token without `actions:read`
  and logs past the repo's retention period (90 days unless the repo sets a
  shorter one). Once the log has expired, that build can no longer be
  verified and must not be installed.
- No matching digest line, or more than one distinct digest for `N`.
- A line whose `run=` or `sha=` does not match the run it was read from.
- The asset is absent (pruned past `keep`, or never uploaded), the download
  fails, or it yields anything other than exactly `N.tar.gz`.
- The asset's sha256 differs from the digest. One way this happens is a job
  that was re-run and is uploading while you download. Refuse, and let the
  next scheduled check try again. Do not retry in a loop.
- An archive member with an absolute path or a `..` component.

### Re-runs

Re-running the publishing job builds and uploads the asset again, replacing
the old one (`--clobber`). With `filter=latest`, step 2 reads only the latest
attempt of each job, so its digest describes the asset that attempt uploaded.
If a build is not reproducible, a re-run gives a new digest, and the new asset
matches the new log line. Earlier attempts' lines are not read.

### Reference sketch (bash)

```bash
set -euo pipefail
R=fulcrum-labs/foundry W=.github/workflows/ci.yml T=ci-builds
S=<40-hex commit>; N=foundry-linux-amd64-$S
refuse() { echo "refusing $N: $*" >&2; exit 1; }

runs=$(gh api "repos/$R/actions/runs?head_sha=$S&event=push&branch=main&per_page=100" \
  --jq ".workflow_runs[] | select(.event==\"push\" and .head_branch==\"main\" and .head_sha==\"$S\"
        and .path==\"$W\" and .head_repository.full_name==\"$R\") | .id") || refuse "cannot list runs"
[ -n "$runs" ] || refuse "no main push run of $W for $S"

digests=""
for run in $runs; do
  jobs=$(gh api --paginate "repos/$R/actions/runs/$run/jobs?filter=latest&per_page=100" \
    --jq '.jobs[] | select(.status=="completed" and .conclusion=="success") | .id') || refuse "cannot list jobs of run $run"
  for job in $jobs; do
    log=$(gh api "repos/$R/actions/jobs/$job/logs") || refuse "cannot read log of job $job"
    digests+=$(printf '%s\n' "$log" | sed -E 's/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[^ ]+ //' |
      grep -E "^FULCRUM-BUILD-DIGEST ${N//./\\.}\\.tar\\.gz sha256=[0-9a-f]{64} run=$run attempt=[0-9]+ sha=$S\$" |
      sed -E 's/.* sha256=([0-9a-f]{64}) .*/\1/' || true)$'\n'
  done
done
distinct=$({ printf '%s' "$digests" | grep -E '^[0-9a-f]{64}$' || true; } | sort -u)
[ "$(printf '%s' "$distinct" | grep -c .)" -eq 1 ] || refuse "expected exactly one digest, found: ${distinct:-none}"

dir=$(mktemp -d)
gh release download "$T" -R "$R" -p "$N.tar.gz" -D "$dir" || refuse "asset not downloadable"
[ "$(ls -A "$dir")" = "$N.tar.gz" ] || refuse "unexpected download contents"
[ "$(sha256sum "$dir/$N.tar.gz" | cut -d' ' -f1)" = "$distinct" ] || refuse "sha256 mismatch"
tar -tzf "$dir/$N.tar.gz" | grep -qE '^/|(^|/)\.\.(/|$)' && refuse "unsafe archive member"
mkdir "$dir/out" && tar -xzf "$dir/$N.tar.gz" -C "$dir/out" --no-same-owner
```

The sketch is a model for the steps above, not a shared helper. Each consumer
implements the protocol in its own installer and keeps every refusal.

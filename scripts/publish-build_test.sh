#!/usr/bin/env bash
# bash scripts/publish-build_test.sh
# Self-test for .github/actions/publish-build (no network): the push-to-main
# guard, name validation, deterministic packing, the FULCRUM-BUILD-DIGEST line,
# and prune selection on a fixture asset list.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
action_dir="${root}/.github/actions/publish-build"
helper="${action_dir}/publish-build.sh"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok   - $1"; }
bad() { fail=$((fail + 1)); echo "FAIL - $1" >&2; }
expect_eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1: expected [$3], got [$2]"; fi; }
expect_fail() { # <label> <stderr-substring> <cmd...>
  local label="$1" needle="$2"; shift 2
  local err
  if err="$("$@" 2>&1 >/dev/null)"; then bad "${label}: expected failure, command succeeded"
  elif [[ "${err}" == *"${needle}"* ]]; then ok "${label}"
  else bad "${label}: failed without '${needle}': ${err}"; fi
}

sha="0123456789abcdef0123456789abcdef01234567"
other="fedcba9876543210fedcba9876543210fedcba98"
name="foundry-linux-amd64-${sha}"
export GITHUB_RUN_ID=987654321 GITHUB_RUN_ATTEMPT=2 GITHUB_SHA="${sha}"

# --- guard step, run from action.yml itself -------------------------------
guard="${work}/guard.sh"
awk '/- name: Refuse anything but a push to main/{f=1} f&&/run: \|/{r=1; next} r&&/^    - name:/{exit} r{sub(/^        /,""); print}' \
  "${action_dir}/action.yml" > "${guard}"
grep -q 'refs/heads/main' "${guard}" || { echo "could not extract the guard step from action.yml" >&2; exit 1; }
run_guard() { GITHUB_ACTION_PATH="${action_dir}" EVENT_NAME="$1" REF="$2" NAME="$3" KEEP="${4:-30}" RELEASE_TAG="${5:-ci-builds}" bash "${guard}"; }
expect_fail "guard refuses pull_request" "event 'pull_request' on ref 'refs/pull/7/merge'" run_guard pull_request refs/pull/7/merge "${name}"
expect_fail "guard refuses push to a branch" "event 'push' on ref 'refs/heads/feat/x'" run_guard push refs/heads/feat/x "${name}"
expect_fail "guard refuses workflow_dispatch on main" "event 'workflow_dispatch' on ref 'refs/heads/main'" run_guard workflow_dispatch refs/heads/main "${name}"
expect_fail "guard refuses keep 0" "keep '0'" run_guard push refs/heads/main "${name}" 0
if run_guard push refs/heads/main "${name}" >/dev/null 2>&1; then ok "guard allows push to main"; else bad "guard allows push to main"; fi

# --- name validation --------------------------------------------------------
expect_eq "check-name prints the prefix" "$("${helper}" check-name "${name}" "${sha}")" "foundry-linux-amd64"
expect_fail "check-name refuses another commit" "carries commit ${other}" "${helper}" check-name "foundry-linux-amd64-${other}" "${sha}"
expect_fail "check-name refuses a short sha" "must be <prefix>-<40-hex commit>" "${helper}" check-name "foundry-linux-amd64-${sha:0:12}" "${sha}"
expect_fail "check-name refuses a space" "must be <prefix>-<40-hex commit>" "${helper}" check-name "foundry linux-${sha}" "${sha}"

# --- deterministic packing --------------------------------------------------
src="${work}/src"
mkdir -p "${src}/dist/sub"
printf 'binary-one\n' > "${src}/dist/foundryd"
printf 'binary-two\n' > "${src}/dist/foundry"
printf 'nested\n' > "${src}/dist/sub/config.json"
chmod 0755 "${src}/dist/foundryd" "${src}/dist/foundry"
chmod 0644 "${src}/dist/sub/config.json"
chmod 0755 "${src}/dist/sub"

line1="$(cd "${src}" && printf 'dist/foundryd\ndist/foundry\n\ndist/sub\n' | "${helper}" pack "${name}" "${work}/out1")"
touch -d '2001-02-03 04:05:06' "${src}/dist/foundryd" "${src}/dist/sub/config.json" "${src}/dist/sub"
line2="$(cd "${src}" && printf '  dist/sub\ndist/foundry\ndist/foundryd\ndist/foundry' | "${helper}" pack "${name}" "${work}/out2")"
expect_eq "same inputs give the same digest line (order, blanks, mtimes ignored)" "${line1}" "${line2}"
if cmp -s "${work}/out1/${name}.tar.gz" "${work}/out2/${name}.tar.gz"; then ok "archives are byte-identical"; else bad "archives are byte-identical"; fi

expect_eq "pack prints exactly one line" "$(printf '%s\n' "${line1}" | wc -l | tr -d ' ')" "1"
re="^FULCRUM-BUILD-DIGEST ${name}\\.tar\\.gz sha256=[0-9a-f]{64} run=987654321 attempt=2 sha=${sha}\$"
if [[ "${line1}" =~ ${re} ]]; then ok "digest line has the exact format"; else bad "digest line format: ${line1}"; fi
actual="$(sha256sum "${work}/out1/${name}.tar.gz" | cut -d' ' -f1)"
expect_eq "digest line carries the archive's sha256" "$(sed 's/.* sha256=\([0-9a-f]*\) .*/\1/' <<< "${line1}")" "${actual}"

listing="$(tar -tvzf "${work}/out1/${name}.tar.gz" | awk '{print $1, $2, $6}')"
expected_listing="-rwxr-xr-x 0/0 dist/foundry
-rwxr-xr-x 0/0 dist/foundryd
drwxr-xr-x 0/0 dist/sub/
-rw-r--r-- 0/0 dist/sub/config.json"
expect_eq "archive is sorted, owner 0/0, modes kept" "${listing}" "${expected_listing}"
expect_eq "archive mtimes are the epoch" "$(tar -tvzf "${work}/out1/${name}.tar.gz" --utc | awk '{print $4}' | sort -u)" "1970-01-01"

expect_fail "pack refuses an absolute path" "is absolute" sh -c "cd '${src}' && echo /etc/hostname | '${helper}' pack '${name}' '${work}/o3'"
expect_fail "pack refuses a .. component" "contains a '..' component" sh -c "cd '${src}/dist' && echo ../dist/foundry | '${helper}' pack '${name}' '${work}/o3'"
expect_fail "pack refuses a missing file" "does not exist" sh -c "cd '${src}' && echo dist/nope | '${helper}' pack '${name}' '${work}/o3'"
expect_fail "pack refuses an empty file list" "no files to publish" sh -c "cd '${src}' && printf '\n  \n' | '${helper}' pack '${name}' '${work}/o3'"
expect_fail "pack refuses a name for another commit" "carries commit ${other}" sh -c "cd '${src}' && echo dist/foundry | '${helper}' pack 'foundry-linux-amd64-${other}' '${work}/o3'"

# --- prune selection ----------------------------------------------------------
h() { printf '%040d' "$1"; }  # 40 decimal digits are valid lowercase hex
assets="${work}/assets.tsv"
{
  printf '2026-09-01T10:00:00Z\tfoundry-linux-amd64-%s.tar.gz\n' "$(h 1)"
  printf '2026-09-05T10:00:00Z\tfoundry-linux-amd64-%s.tar.gz\n' "$(h 5)"
  printf '2026-09-03T10:00:00Z\tfoundry-linux-amd64-%s.tar.gz\n' "$(h 3)"
  printf '2026-09-04T10:00:00Z\tfoundry-linux-amd64-%s.tar.gz\n' "$(h 4)"
  printf '2026-09-02T10:00:00Z\tfoundry-linux-amd64-%s.tar.gz\n' "$(h 2)"
  printf '2026-08-01T10:00:00Z\tfoundry-linux-arm64-%s.tar.gz\n' "$(h 6)"
  printf '2026-08-02T10:00:00Z\tfoundry-linux-arm64-%s.tar.gz\n' "$(h 7)"
  printf '2026-07-01T10:00:00Z\tfoundry-linux-amd64-debug-%s.tar.gz\n' "$(h 8)"
  printf '2026-07-01T10:00:00Z\tfoundry-linux-amd64-%s.tar.gz.sig\n' "$(h 9)"
  printf '2026-07-01T10:00:00Z\tfoundry-linux-amd64-%s.tar.gz\n' "abc123"
  printf '2026-07-01T10:00:00Z\txfoundry-linux-amd64-%s.tar.gz\n' "$(h 10)"
  printf '2026-07-01T10:00:00Z\tfoundry-linux-amd64-%s.tar.gz\n' "ABCDEF0123456789ABCDEF0123456789ABCDEF01"
} > "${assets}"
cur="foundry-linux-amd64-$(h 5).tar.gz"
expect_eq "keeps the newest 2 of the prefix, deletes the rest oldest first" \
  "$("${helper}" prune-select foundry-linux-amd64 2 "${cur}" < "${assets}")" \
  "foundry-linux-amd64-$(h 1).tar.gz
foundry-linux-amd64-$(h 2).tar.gz
foundry-linux-amd64-$(h 3).tar.gz"
expect_eq "other prefixes are pruned only among themselves" \
  "$("${helper}" prune-select foundry-linux-arm64 1 "foundry-linux-arm64-$(h 7).tar.gz" < "${assets}")" \
  "foundry-linux-arm64-$(h 6).tar.gz"
expect_eq "nothing to delete when keep covers every asset" \
  "$("${helper}" prune-select foundry-linux-amd64 30 "${cur}" < "${assets}")" ""
expect_eq "the current asset is never selected, even when it sorts oldest" \
  "$("${helper}" prune-select foundry-linux-amd64 1 "foundry-linux-amd64-$(h 1).tar.gz" < "${assets}")" \
  "foundry-linux-amd64-$(h 2).tar.gz
foundry-linux-amd64-$(h 3).tar.gz
foundry-linux-amd64-$(h 4).tar.gz"
expect_eq "an empty release selects nothing" "$("${helper}" prune-select foundry-linux-amd64 2 "${cur}" < /dev/null)" ""
expect_fail "prune-select refuses keep 0" "keep '0'" sh -c "'${helper}' prune-select foundry-linux-amd64 0 '${cur}' < '${assets}'"

echo "publish-build self-test: ${pass} passed, ${fail} failed"
[ "${fail}" -eq 0 ]

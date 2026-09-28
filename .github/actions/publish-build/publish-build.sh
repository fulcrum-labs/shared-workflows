#!/usr/bin/env bash
# Helpers for the publish-build composite action (action.yml, same directory).
# Kept separate so the parts with no network -- name validation, deterministic
# packing, the digest line and prune selection -- run under
# scripts/publish-build_test.sh. Written for bash 3.2 (macOS runners) as well
# as Linux: no mapfile, no associative arrays.
#
#   publish-build.sh check-name <name> <sha>
#       exit 0 when <name> is <prefix>-<sha> with a 40-hex <sha>; prints <prefix>.
#   publish-build.sh pack <name> <outdir>      (file paths on stdin, one per line)
#       writes <outdir>/<name>.tar.gz deterministically and prints the digest
#       line: FULCRUM-BUILD-DIGEST <name>.tar.gz sha256=<hex> run=<id> attempt=<n> sha=<sha>
#       (run/attempt/sha from GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_SHA).
#   publish-build.sh prune-select <prefix> <keep> <current-asset>
#       reads "<created_at>\t<asset name>" lines on stdin; prints, oldest first,
#       the asset names to delete so that at most <keep> assets named
#       <prefix>-<40hex>.tar.gz remain. Never selects <current-asset> and never
#       selects any name outside that exact pattern.
set -euo pipefail

die() { echo "::error::publish-build: $*" >&2; exit 1; }

check_name() {
  local name="$1" sha="$2"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "commit sha '${sha}' is not a full 40-hex commit"
  [[ "$name" =~ ^([A-Za-z0-9._-]+)-([0-9a-f]{40})$ ]] ||
    die "name '${name}' must be <prefix>-<40-hex commit> using only A-Z a-z 0-9 . _ -"
  local prefix="${BASH_REMATCH[1]}" suffix="${BASH_REMATCH[2]}"
  [ "$suffix" = "$sha" ] || die "name '${name}' carries commit ${suffix}, but this run built ${sha}"
  printf '%s\n' "$prefix"
}

gnu_tar() {
  local t
  for t in tar gtar; do
    if command -v "$t" >/dev/null 2>&1 && "$t" --version 2>/dev/null | head -n1 | grep -q 'GNU tar'; then
      printf '%s\n' "$t"; return 0
    fi
  done
  die "GNU tar is required for a deterministic archive (found neither GNU 'tar' nor 'gtar'; on macOS install gnu-tar)"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else die "neither sha256sum nor shasum is available"; fi
}

pack() {
  local name="$1" outdir="$2"
  local run="${GITHUB_RUN_ID:?GITHUB_RUN_ID unset}" attempt="${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT unset}"
  local sha="${GITHUB_SHA:?GITHUB_SHA unset}"
  check_name "$name" "$sha" >/dev/null
  local tarbin list f count=0
  tarbin="$(gnu_tar)"
  mkdir -p "$outdir"
  list="$outdir/.${name}.files"
  : > "$list"
  while IFS= read -r f || [ -n "$f" ]; do
    f="${f%$'\r'}"
    # trim surrounding whitespace; blank lines are skipped
    f="${f#"${f%%[![:space:]]*}"}"; f="${f%"${f##*[![:space:]]}"}"
    [ -n "$f" ] || continue
    case "$f" in /*) die "file '${f}' is absolute; list paths relative to the working directory" ;; esac
    case "/$f/" in */../*) die "file '${f}' contains a '..' component" ;; esac
    [ -e "$f" ] || die "file '${f}' does not exist"
    printf '%s\0' "$f" >> "$list"
    count=$((count + 1))
  done
  [ "$count" -gt 0 ] || die "no files to publish (the files input is empty)"
  local archive="$outdir/${name}.tar.gz"
  LC_ALL=C sort -z -u "$list" |
    "$tarbin" --create --file=- --format=gnu --null --files-from=- \
      --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner |
    gzip -n > "$archive"
  rm -f "$list"
  local digest
  digest="$(sha256_of "$archive")"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || die "could not compute the sha256 of ${archive}"
  printf 'FULCRUM-BUILD-DIGEST %s.tar.gz sha256=%s run=%s attempt=%s sha=%s\n' \
    "$name" "$digest" "$run" "$attempt" "$sha"
}

prune_select() {
  local prefix="$1" keep="$2" current="$3"
  [[ "$keep" =~ ^[1-9][0-9]*$ ]] || die "keep '${keep}' must be a whole number of at least 1"
  [[ "$prefix" =~ ^[A-Za-z0-9._-]+$ ]] || die "prefix '${prefix}' is not a valid build prefix"
  local ours created name
  ours="$(
    while IFS=$'\t' read -r created name || [ -n "${name:-}" ]; do
      [ -n "${name:-}" ] || continue
      # exactly <prefix>-<40 hex>.tar.gz: "-" + 40 + ".tar.gz" is 48 characters
      [ "${#name}" -eq $(( ${#prefix} + 48 )) ] || continue
      [ "${name:0:${#prefix}}" = "$prefix" ] || continue
      [[ "${name:${#prefix}}" =~ ^-[0-9a-f]{40}\.tar\.gz$ ]] || continue
      printf '%s\t%s\n' "$created" "$name"
    done | LC_ALL=C sort -t $'\t' -k1,1r -k2,2r
  )"
  [ -n "$ours" ] || return 0
  # newest first: skip the newest <keep>, then print the rest oldest first
  printf '%s\n' "$ours" | tail -n +"$((keep + 1))" | LC_ALL=C sort -t $'\t' -k1,1 -k2,2 |
    cut -f2 | { grep -vxF -- "$current" || true; }
}

cmd="${1:-}"
[ $# -eq 0 ] || shift
case "$cmd" in
  check-name) [ $# -eq 2 ] || die "usage: check-name <name> <sha>"; check_name "$@" ;;
  pack) [ $# -eq 2 ] || die "usage: pack <name> <outdir> < files"; pack "$@" ;;
  prune-select) [ $# -eq 3 ] || die "usage: prune-select <prefix> <keep> <current-asset> < assets.tsv"; prune_select "$@" ;;
  *) die "unknown command '${cmd}' (check-name | pack | prune-select)" ;;
esac

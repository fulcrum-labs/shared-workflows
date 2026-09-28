# Shared Workflows

Reusable GitHub Actions workflows for Fulcrum-managed repositories.

Current workflows:

- `.github/workflows/ci-gate.yml`: shared CI gate for org-owned and personal repos

Composite actions:

- `.github/actions/publish-build`: publish a main-branch build as an asset on a rolling `ci-builds` prerelease (no Actions artifact storage); consumers verify it with the protocol in `docs/publish-build.md`

This repository is intentionally minimal so downstream repos can depend on one public workflow source without inheriting unrelated platform code.

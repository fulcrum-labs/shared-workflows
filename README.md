# Shared Workflows

Reusable GitHub Actions workflows for Fulcrum-managed repositories.

Current workflows:

- `.github/workflows/ci-gate.yml`: shared CI gate for org-owned and personal repos

This repository is intentionally minimal so downstream repos can depend on one public workflow source without inheriting unrelated platform code.

The CI, deploy, and preview gates accept an optional `runner-labels` string containing a JSON array. It defaults to `["self-hosted","Linux","X64"]`. A caller can set `runner-labels: '["self-hosted","Linux","X64","atlas"]'` to require Atlas for every job in that gate. GitHub matches every label in the array; omitting the input preserves the existing fleet selection.

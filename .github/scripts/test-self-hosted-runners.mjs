import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflows = new Map(
  [
    ['ci-gate.yml', ['quality', 'docs-lint', 'gitleaks', 'semgrep', 'grype', 'trigger-cf-build']],
    ['d1-migrations-apply.yml', ['apply']],
    ['preview-gate.yml', ['build']],
    ['deploy-gate.yml', ['deploy']],
  ].map(([file, jobs]) => [
    file,
    {
      jobs,
      source: readFileSync(new URL(`../workflows/${file}`, import.meta.url), 'utf8'),
    },
  ]),
);

function jobSource(source, jobName) {
  const starts = [...source.matchAll(/^  ([a-z][a-z0-9-]+):$/gm)];
  const matchIndex = starts.findIndex(match => match[1] === jobName);
  assert.notEqual(matchIndex, -1, `${jobName} job must exist`);
  const start = starts[matchIndex].index;
  const end = starts[matchIndex + 1]?.index ?? source.length;
  return source.slice(start, end);
}

test('all shared-workflow compute defaults to the self-hosted runner fleet', () => {
  for (const [file, { jobs, source }] of workflows) {
    for (const jobName of jobs) {
      const job = jobSource(source, jobName);
      assert.match(
        job,
        /^    runs-on: \[self-hosted, Linux, X64\]$/m,
        `${file}:${jobName} must default to the self-hosted fleet`,
      );
      assert.match(
        job,
        /break-glass: swap runs-on back to ubuntu-24\.04 if self-hosted fleet unavailable/i,
        `${file}:${jobName} must retain an explicit hosted break-glass path`,
      );
    }
  }
});

test('workflows that run in THIS public repo never target the self-hosted fleet', () => {
  // shared-workflows is a PUBLIC repo: any workflow triggered here (pull_request,
  // push, schedule) would let fork-PR code reach the self-hosted runner hosts.
  // Reusable workflow_call jobs (ci-gate, d1-migrations-apply) execute in the
  // PRIVATE caller repos and are exempt. See 2026-08-04 runner security finding.
  const validate = readFileSync(new URL('../workflows/validate.yml', import.meta.url), 'utf8');
  const contract = jobSource(validate, 'contract');
  assert.match(
    contract,
    /^    runs-on: ubuntu-24\.04$/m,
    'validate.yml:contract must run on GitHub-hosted compute (public repo)',
  );
  assert.doesNotMatch(
    contract,
    /^    runs-on:.*self-hosted/m,
    'validate.yml:contract must not target the self-hosted fleet',
  );
});


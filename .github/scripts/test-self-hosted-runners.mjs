import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflows = new Map(
  [
    ['ci-gate.yml', ['quality', 'docs-lint', 'gitleaks', 'semgrep', 'grype', 'trigger-cf-build']],
    ['d1-migrations-apply.yml', ['apply']],
    ['validate.yml', ['contract']],
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


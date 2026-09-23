import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const workflowsDir = fileURLToPath(new URL('../workflows/', import.meta.url));

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

// Every workflow file under .github/workflows/, independent of the
// hand-maintained job-name map above (which several tests below use for
// job-specific assertions and which does not list every file -- e.g.
// worker-rollback.yml). #50's ruling applies repo-wide, so these two tests
// enumerate the directory instead of trusting that map to be complete.
function allWorkflows(dir = workflowsDir) {
  return readdirSync(dir)
    .filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .map(name => [name, readFileSync(join(dir, name), 'utf8')]);
}

// Slices out a top-level (0-indent) "key:" block: everything strictly
// between its own header line and the next 0-indent key, or EOF. Line-
// anchored, like jobSource above -- not a whole-file regex.
function topLevelBlock(source, key) {
  const lines = source.split('\n');
  const startIndex = lines.findIndex(line => line === `${key}:`);
  if (startIndex === -1) return null;
  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    if (/^[A-Za-z_-]/.test(lines[i])) {
      endIndex = i;
      break;
    }
  }
  return lines.slice(startIndex + 1, endIndex).join('\n');
}

function triggerKeys(onBlock) {
  return [...onBlock.matchAll(/^  ([a-zA-Z_-]+):/gm)].map(match => match[1]);
}

function runsOnValues(source) {
  return [...source.matchAll(/^\s*runs-on:\s*(.+)$/gm)].map(match => match[1].trim());
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

// #50 (operator ruling 2026-09-19, Amendment 1): shared-workflows is a PUBLIC
// repo that stays public only because cross-org callers need its reusable
// workflows, so it keeps NO CI of its own -- validate.yml (the only workflow
// that ran here directly, on push/pull_request) was deleted rather than kept
// on hosted compute. These two tests enforce that ruling repo-wide instead of
// reading the deleted file: any workflow triggered directly in this repo
// (push, pull_request, pull_request_target, schedule, workflow_dispatch)
// would let fork-PR code reach a runner, self-hosted or not, so every file
// must be workflow_call-only; and no job anywhere may default to
// GitHub-hosted compute.
test('every workflow in this repo is triggered only by workflow_call', () => {
  for (const [file, source] of allWorkflows()) {
    const onBlock = topLevelBlock(source, 'on');
    assert.ok(onBlock, `${file} must declare an "on:" trigger block`);
    const triggers = triggerKeys(onBlock);
    assert.deepEqual(
      triggers,
      ['workflow_call'],
      `${file} must be triggered only by workflow_call (found: ${triggers.join(', ') || 'none'}) -- ` +
        'this public repo keeps no CI of its own (#50).',
    );
  }
});

test('no job anywhere in this repo may run on GitHub-hosted compute', () => {
  const hostedRunnerLabel = /\b(?:ubuntu|windows|macos)-/i;
  let runsOnCount = 0;
  for (const [file, source] of allWorkflows()) {
    for (const value of runsOnValues(source)) {
      runsOnCount += 1;
      assert.doesNotMatch(
        value,
        hostedRunnerLabel,
        `${file} has a job on GitHub-hosted compute (runs-on: ${value}) -- ` +
          'hosted runners are no longer allowed in this repo (#50).',
      );
    }
  }
  assert.ok(runsOnCount > 0, 'expected at least one runs-on: line under .github/workflows/');
});

test('every pnpm cache uses a store owned by the current runner job', () => {
  let cacheJobCount = 0;
  for (const [file, { jobs, source }] of workflows) {
    for (const jobName of jobs) {
      const job = jobSource(source, jobName);
      if (!/cache: 'pnpm'/.test(job)) continue;
      cacheJobCount += 1;
      const setupNodeStart = job.indexOf('      - uses: actions/setup-node@v5');
      const beforeSetupNode = job.slice(0, setupNodeStart);
      assert.ok(setupNodeStart >= 0, `${file}:${jobName} pnpm cache must use setup-node`);
      assert.match(
        beforeSetupNode,
        /echo "NPM_CONFIG_STORE_DIR=\$RUNNER_TEMP\/pnpm-store" >> "\$GITHUB_ENV"/,
        `${file}:${jobName} must isolate pnpm's store before setup-node cache discovery`,
      );
    }
  }
  assert.equal(cacheJobCount, 4, 'contract must cover every pnpm-cached reusable job');
});

test('preview gate rebuilds the upload artifact with the caller production command', () => {
  const source = workflows.get('preview-gate.yml').source;
  const build = jobSource(source, 'build');

  assert.match(
    source,
    /artifact-build-command:\n\s+type: string\n\s+default: ''/,
    'preview callers must be able to provide a distinct production artifact build',
  );

  const ciIndex = build.indexOf('run: ${{ inputs.check-command }}');
  const artifactIndex = build.indexOf('run: ${{ inputs.artifact-build-command }}');
  const uploadIndex = build.indexOf('name: Upload preview version');

  assert.ok(ciIndex >= 0, 'preview gate must retain the repository CI command');
  assert.ok(artifactIndex > ciIndex, 'production artifact build must run after CI');
  assert.ok(uploadIndex > artifactIndex, 'production artifact build must run immediately before upload');
});

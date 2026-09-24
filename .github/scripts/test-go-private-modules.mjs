// node --test .github/scripts/test-go-private-modules.mjs
// The go-private-modules composite action (execution-substrate ES-10): a
// per-job, packages-go-only read token, GOPRIVATE/GONOSUMDB, job-scoped git
// auth, and a token that never reaches a log or a global git config. The
// behavioural test runs the action's shell step with a fake $GITHUB_ENV and a
// real `git config` read of the environment it leaves behind.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(new URL('../actions/go-private-modules/action.yml', import.meta.url), 'utf8');

test('mints a per-job App token scoped to contents:read on packages-go only', () => {
  assert.match(source, /uses: actions\/create-github-app-token@[0-9a-f]{40} # v3\.2\.0/);
  assert.match(source, /owner: growth-labs\n\s+repositories: packages-go\n\s+permission-contents: read\n/);
  assert.doesNotMatch(source, /permission-(?!contents)[a-z-]+:/);
});

test('never writes a global git config and never echoes the token', () => {
  assert.doesNotMatch(source, /git config --global|git config --system/);
  const script = source.slice(source.indexOf('run: |'));
  for (const line of script.split('\n')) {
    if (/echo|printf/.test(line) && line.includes('PACKAGES_GO_TOKEN')) {
      assert.match(line, />>\s*"\$GITHUB_ENV"|GIT_CONFIG_KEY_/, `a line that prints the token must only feed $GITHUB_ENV: ${line.trim()}`);
    }
  }
  assert.match(source, /\} >> "\$GITHUB_ENV"/);
});

function runStep(env) {
  const script = source
    .slice(source.indexOf('run: |') + 'run: |'.length)
    .split('\n')
    .map((line) => line.replace(/^ {8}/, ''))
    .join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'go-private-modules-'));
  const githubEnv = join(dir, 'github_env');
  writeFileSync(githubEnv, '');
  try {
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, GITHUB_ENV: githubEnv, ...env },
    });
    const written = Object.fromEntries(
      readFileSync(githubEnv, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    return { result, written };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('sets GOPRIVATE/GONOSUMDB and a job-scoped insteadOf that git actually reads', () => {
  const { result, written } = runStep({ PACKAGES_GO_TOKEN: 'tok-123' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(written.GOPRIVATE, 'github.com/growth-labs/*');
  assert.equal(written.GONOSUMDB, 'github.com/growth-labs/*');
  assert.equal(written.GIT_CONFIG_COUNT, '1');
  assert.doesNotMatch(result.stdout + result.stderr, /tok-123/);
  // git itself reads the rewrite from the job's environment, with no config file.
  const seen = execFileSync('git', ['config', '--get-regexp', '^url\\..*\\.insteadof$'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: written.GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0: written.GIT_CONFIG_KEY_0, GIT_CONFIG_VALUE_0: written.GIT_CONFIG_VALUE_0 },
  }).trim();
  assert.equal(seen, 'url.https://x-access-token:tok-123@github.com/growth-labs/packages-go.insteadof https://github.com/growth-labs/packages-go');
  assert.equal(written.GIT_CONFIG_KEY_0, 'url.https://x-access-token:tok-123@github.com/growth-labs/packages-go.insteadOf');
});

test('appends to an existing GOPRIVATE and GIT_CONFIG_COUNT instead of clobbering them', () => {
  const { result, written } = runStep({ PACKAGES_GO_TOKEN: 't', GOPRIVATE: 'example.com/x', GIT_CONFIG_COUNT: '2' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(written.GOPRIVATE, 'example.com/x,github.com/growth-labs/*');
  assert.equal(written.GIT_CONFIG_COUNT, '3');
  assert.ok(written.GIT_CONFIG_KEY_2);
  assert.equal(written.GIT_CONFIG_KEY_0, undefined);
});

test('fails loudly on an empty token', () => {
  const { result } = runStep({ PACKAGES_GO_TOKEN: '' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /App token is empty/);
});

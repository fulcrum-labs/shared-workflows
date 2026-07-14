import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../workflows/ci-gate.yml', import.meta.url),
  'utf8',
);

test('the reusable gate exposes optional signed Turbo cache configuration', () => {
  for (const input of [
    'turbo-cache-enabled:',
    'turbo-cache-api:',
    'turbo-cache-team:',
  ]) {
    assert.match(workflow, new RegExp(`^      ${input}$`, 'm'));
  }

  for (const secret of [
    'TURBO_CACHE_TOKEN:',
    'TURBO_CACHE_SIGNATURE_KEY:',
  ]) {
    assert.match(workflow, new RegExp(`^      ${secret}$`, 'm'));
  }
});

test('the quality job fails closed for fork PR cache credentials', () => {
  const trustedCaller =
    "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository";
  const gateStart = workflow.indexOf('      - name: CI gate (typecheck + lint + test + build)');
  const gateEnd = workflow.indexOf('      - name: Lockfile integrity', gateStart);
  const gateStep = workflow.slice(gateStart, gateEnd);

  assert.ok(gateStart >= 0 && gateEnd > gateStart, 'CI gate step must be present');

  for (const variable of [
    'TURBO_API',
    'TURBO_TOKEN',
    'TURBO_TEAM',
    'TURBO_TEAMID',
    'TURBO_REMOTE_CACHE_SIGNATURE_KEY',
  ]) {
    const line = gateStep
      .split('\n')
      .find((candidate) => candidate.trimStart().startsWith(`${variable}:`));

    assert.ok(line, `${variable} must be configured on the quality job`);
    assert.match(line, /inputs\.turbo-cache-enabled/);
    assert.ok(
      line.includes(trustedCaller),
      `${variable} must require a trusted caller`,
    );
    assert.match(line, /\|\| ''/);
    assert.equal(
      workflow.slice(0, gateStart).includes(`${variable}:`),
      false,
      `${variable} must not be exposed to setup actions`,
    );
  }
});

test('remote cache network timeouts are bounded', () => {
  assert.match(workflow, /^\s+TURBO_REMOTE_CACHE_TIMEOUT: '10'$/m);
  assert.match(workflow, /^\s+TURBO_REMOTE_CACHE_UPLOAD_TIMEOUT: '10'$/m);
});

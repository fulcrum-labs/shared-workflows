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

test('cache eligibility is an event allowlist resolved in a single step', () => {
  const eligibilityStart = workflow.indexOf('      - name: Resolve Turbo cache eligibility');
  const enforcementStart = workflow.indexOf('      - name: Enforce signed-cache consumer contract');
  const gateStart = workflow.indexOf('      - name: CI gate (typecheck + lint + test + build)');

  assert.ok(eligibilityStart >= 0, 'eligibility step must be present');
  assert.ok(enforcementStart > eligibilityStart, 'signature enforcement must follow eligibility');
  assert.ok(gateStart > enforcementStart, 'the CI gate must run after eligibility + enforcement');

  const eligibilityStep = workflow.slice(eligibilityStart, enforcementStart);

  // The guard must be an allowlist: default false, explicit trusted events,
  // and same-repository comparison for pull_request. A denylist here is the
  // exact bug this test exists to prevent (pull_request_target leakage).
  assert.match(eligibilityStep, /eligible=false/);
  assert.match(eligibilityStep, /case "\$GITHUB_EVENT_NAME" in/);
  assert.match(eligibilityStep, /push\|merge_group\)/);
  assert.match(eligibilityStep, /\[ "\$HEAD_REPO" = "\$GITHUB_REPOSITORY" \]/);
  assert.equal(
    /pull_request_target\s*\)/.test(eligibilityStep),
    false,
    'pull_request_target must never be a cache-eligible case label',
  );
  assert.equal(
    /!=/.test(eligibilityStep),
    false,
    'the eligibility guard must not contain negated (denylist) comparisons',
  );
});

test('cache credentials are injected only via the eligibility gate', () => {
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
    const keyPattern = new RegExp(`^\\s+${variable}: (.*)$`, 'gm');
    const everywhere = [...workflow.matchAll(keyPattern)];
    assert.equal(
      everywhere.length,
      1,
      `${variable} must be assigned exactly once in the whole workflow (found ${everywhere.length})`,
    );

    const inGate = [...gateStep.matchAll(keyPattern)];
    assert.equal(inGate.length, 1, `${variable} must be configured on the CI gate step`);

    const value = inGate[0][1];
    assert.ok(
      value.includes("steps.turbo-cache.outputs.eligible == 'true'"),
      `${variable} must be gated on the eligibility step output`,
    );
    assert.match(value, /\|\| ''/, `${variable} must collapse to empty when ineligible`);
  }
});

test('eligible callers must verify artifact signatures (fail closed)', () => {
  const enforcementStart = workflow.indexOf('      - name: Enforce signed-cache consumer contract');
  const gateStart = workflow.indexOf('      - name: CI gate (typecheck + lint + test + build)');
  const enforcementStep = workflow.slice(enforcementStart, gateStart);

  assert.ok(enforcementStart >= 0, 'signature enforcement step must be present');
  assert.match(
    enforcementStep,
    /if: \$\{\{ steps\.turbo-cache\.outputs\.eligible == 'true' \}\}/,
    'enforcement must run exactly when credentials would be injected',
  );
  assert.match(enforcementStep, /remoteCache\?\.signature !== true/);
  assert.match(enforcementStep, /process\.exit\(1\)/);
});

test('remote cache network timeouts are bounded', () => {
  assert.match(workflow, /^\s+TURBO_REMOTE_CACHE_TIMEOUT: '10'$/m);
  assert.match(workflow, /^\s+TURBO_REMOTE_CACHE_UPLOAD_TIMEOUT: '10'$/m);
});

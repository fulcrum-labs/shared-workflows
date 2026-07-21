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

test('non-container scanner jobs use the self-hosted fleet safely', () => {
  const jobNames = ['docs-lint', 'gitleaks', 'grype'];
  const jobStarts = new Map(
    [...workflow.matchAll(/^  ([a-z][a-z0-9-]+):$/gm)]
      .map(match => [match[1], match.index]),
  );

  for (const jobName of jobNames) {
    const start = jobStarts.get(jobName);
    assert.notEqual(start, undefined, `${jobName} job must exist`);
    const nextStart = [...jobStarts.values()].find(index => index > start) ?? workflow.length;
    const job = workflow.slice(start, nextStart);
    assert.match(job, /^    runs-on: \[self-hosted, Linux, X64\]$/m, `${jobName} must be self-hosted`);
    assert.match(job, /break-glass: swap runs-on back to ubuntu-24\.04/);
  }

  const docsLint = workflow.slice(jobStarts.get('docs-lint'), jobStarts.get('gitleaks'));
  assert.match(docsLint, /dest: \$\{\{ runner\.temp \}\}\/setup-pnpm/);
  assert.match(docsLint, /PNPM_HOME must be under RUNNER_TEMP/);

  const gitleaks = workflow.slice(jobStarts.get('gitleaks'), jobStarts.get('semgrep'));
  assert.match(gitleaks, /mv \/tmp\/gitleaks "\$RUNNER_TEMP\/gitleaks"/);
  assert.match(gitleaks, /echo "\$RUNNER_TEMP" >> "\$GITHUB_PATH"/);
  assert.equal(gitleaks.includes('sudo '), false, 'gitleaks install must not require privileged mutation');
});

test('semgrep uses a pinned ephemeral pip install on the self-hosted fleet', () => {
  const semgrepStart = workflow.indexOf('  semgrep:');
  const grypeStart = workflow.indexOf('  grype:', semgrepStart);
  const semgrep = workflow.slice(semgrepStart, grypeStart);

  assert.ok(semgrepStart >= 0 && grypeStart > semgrepStart, 'semgrep job must exist');
  assert.match(semgrep, /^    runs-on: \[self-hosted, Linux, X64\]$/m);
  assert.match(semgrep, /break-glass: swap runs-on back to ubuntu-24\.04/);
  assert.equal(semgrep.includes('container:'), false, 'semgrep must not require Docker');
  assert.equal(semgrep.includes('returntocorp/semgrep'), false, 'legacy container image must be removed');
  assert.equal(
    (semgrep.match(/^        env:\n          PYTHONUSERBASE: \$\{\{ runner\.temp \}\}\/semgrep-user$/gm) ?? []).length,
    2,
    'install and scan must retain the same Python user base',
  );
  assert.match(
    semgrep,
    /python3 -m pip install --user --break-system-packages --quiet semgrep==1\.170\.0/,
  );
  assert.match(semgrep, /echo "\$PYTHONUSERBASE\/bin" >> "\$GITHUB_PATH"/);
  assert.equal(semgrep.includes('sudo '), false, 'semgrep install must not require privileged mutation');

  for (const config of ['p/security-audit', 'p/owasp-top-ten', 'p/typescript']) {
    assert.match(semgrep, new RegExp(`--config=${config.replace('/', '\\/')}`));
  }
  for (const flag of ['--error', '--severity=ERROR', '--quiet']) {
    assert.ok(semgrep.includes(flag), `semgrep scan must retain ${flag}`);
  }
});

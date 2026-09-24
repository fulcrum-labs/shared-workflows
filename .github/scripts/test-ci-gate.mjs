import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../workflows/ci-gate.yml', import.meta.url),
  'utf8',
);

test('the reusable gate pins its default Node patch without latest-cache drift', () => {
  assert.match(
    workflow,
    /node-version:\n        type: string\n        default: '24\.18\.0'/,
  );
  assert.doesNotMatch(workflow, /check-latest:/);
});

test('main push reruns keep a SHA-isolated concurrency group', () => {
  assert.match(
    workflow,
    /group: ci-gate-\$\{\{ github\.repository \}\}-\$\{\{ github\.ref == 'refs\/heads\/main' && github\.sha \|\| github\.ref \}\}/,
  );
  assert.match(
    workflow,
    /cancel-in-progress: \$\{\{ github\.ref != 'refs\/heads\/main' \}\}/,
  );
  assert.doesNotMatch(workflow, /group: ci-gate-\$\{\{ github\.repository \}\}-\$\{\{ github\.ref \}\}/);
});

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

test('pnpm cache discovery uses a store owned by the current runner job', () => {
  const guardStart = workflow.indexOf('      - name: Guard pnpm runner isolation');
  const setupNodeStart = workflow.indexOf('      - uses: actions/setup-node@v5', guardStart);
  const guardStep = workflow.slice(guardStart, setupNodeStart);

  assert.ok(guardStart >= 0 && setupNodeStart > guardStart, 'pnpm isolation guard must precede setup-node');
  assert.match(
    guardStep,
    /echo "NPM_CONFIG_STORE_DIR=\$RUNNER_TEMP\/pnpm-store" >> "\$GITHUB_ENV"/,
  );
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
  for (const flag of ['--error', '--severity=ERROR']) {
    assert.ok(semgrep.includes(flag), `semgrep scan must retain ${flag}`);
  }
  const scan = semgrep.slice(semgrep.indexOf('      - name: Semgrep scan'));
  assert.equal(
    scan.includes('--quiet'),
    false,
    'semgrep must preserve actionable scanner errors in the job log',
  );
});

test('the D1 LIKE/GLOB pattern length step rejects literals over 50 bytes in migrations', async () => {
  const stepStart = workflow.indexOf('      - name: D1 LIKE/GLOB pattern length');
  const stepEnd = workflow.indexOf('      - name: Accessibility (axe-core)', stepStart);
  assert.ok(stepStart >= 0 && stepEnd > stepStart, 'pattern-length step must precede the axe step');
  const step = workflow.slice(stepStart, stepEnd);
  const scriptMatch = step.match(/node - <<'D1_PATTERN_SCAN'\n([\s\S]*?)\n\s*D1_PATTERN_SCAN/);
  assert.ok(scriptMatch, 'the step must embed its scanner as a heredoc');
  const script = scriptMatch[1].replace(/^ {10}/gm, '');

  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const run = (files) => {
    const root = mkdtempSync(join(tmpdir(), 'd1-pattern-'));
    try {
      for (const [rel, body] of Object.entries(files)) {
        mkdirSync(join(root, rel, '..'), { recursive: true });
        writeFileSync(join(root, rel), body);
      }
      return spawnSync(process.execPath, ['-'], { cwd: root, input: script, encoding: 'utf8' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const long = `NEW.id GLOB '${'[0-9a-f]'.repeat(8)}'`;

  const clean = run({
    'migrations/0001.sql': "CREATE TABLE t (email TEXT CHECK (email NOT LIKE '% %'));",
    'src/notes.sql': `-- outside migrations: ${long}`,
    'node_modules/x/migrations/0001.sql': long,
  });
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /1 migration file\(s\) scanned/);

  const dirty = run({ 'migrations/0002.sql': `CREATE TRIGGER g BEFORE INSERT ON t WHEN NOT (${long}) BEGIN SELECT 1; END;` });
  assert.equal(dirty.status, 1);
  assert.match(dirty.stdout, /::error::D1 LIKE\/GLOB pattern too long — migrations\/0002.sql:1 pattern is 64 bytes/);

  const superseded = run({ 'migrations/0002.sql': `-- d1-like-pattern-limit: superseded\n${long}` });
  assert.equal(superseded.status, 0, superseded.stdout + superseded.stderr);

  const exactly50 = run({ 'migrations/0003.sql': `x LIKE '${'a'.repeat(50)}'` });
  assert.equal(exactly50.status, 0, exactly50.stdout + exactly50.stderr);
});

test('vitest workers are capped to the node class envelope in the gate step', () => {
  assert.match(workflow, /vitest-max-workers:\n        type: string\n        default: '2'/);
  const capStart = workflow.indexOf('      - name: Cap Vitest workers to the job class envelope');
  const gateStart = workflow.indexOf('      - name: CI gate (typecheck + lint + test + build)');
  const nextStep = workflow.indexOf('      - name: Lockfile integrity');
  assert.ok(capStart >= 0 && gateStart > capStart && nextStep > gateStart, 'the cap step must precede the gate step');
  const cap = workflow.slice(capStart, gateStart);
  assert.match(cap, /\*\[!0-9\]\*\|0\) echo "::error::vitest-max-workers must be a positive integer/);
  assert.match(cap, /vitest workers capped at \$VITEST_CAP/);
  const gate = workflow.slice(gateStart, nextStep);
  for (const variable of ['VITEST_MAX_WORKERS', 'VITEST_MAX_THREADS', 'VITEST_MAX_FORKS']) {
    assert.match(gate, new RegExp(`${variable}: \\$\\{\\{ steps\\.vitest-cap\\.outputs\\.workers \\}\\}`));
  }
});

test('the Go cold-cache leg proves its caches are empty scratch before building', () => {
  const cold = readFileSync(new URL('../workflows/go-cold-cache.yml', import.meta.url), 'utf8');
  assert.match(cold, /^  workflow_call:$/m);
  assert.match(cold, /cache: false/);
  for (const variable of ['GOCACHE', 'GOMODCACHE', 'GOTMPDIR', 'TMPDIR']) {
    assert.match(cold, new RegExp(`echo "${variable}=\\$cold/`));
  }
  const prove = cold.indexOf('      - name: Prove the caches are cold');
  const build = cold.indexOf('      - name: Build from cold caches');
  assert.ok(prove >= 0 && build > prove, 'the coldness proof must precede the build');
  assert.match(cold.slice(prove, build), /is not empty at the start of the cold leg/);
  assert.doesNotMatch(cold, /always\(\)/);
  // The job's budget is a literal; no caller can raise it.
  assert.match(cold, /^    timeout-minutes: 30$/m);
  assert.doesNotMatch(cold, /inputs\.timeout-minutes/);
  // Every action is SHA-pinned: this leg builds release packages.
  for (const use of cold.matchAll(/uses: ([^\s]+)/g)) {
    assert.match(use[1], /@[0-9a-f]{40}$/, `${use[1]} is not pinned to a commit`);
  }
  // The module cache is read-only on disk: every removal makes it writable
  // first (fulcrum-projects#424's first run failed its cleanup on exactly this).
  const removals = cold.match(/rm -rf "\$(cold|RUNNER_TEMP\/go-cold-cache)"/g) ?? [];
  const chmods = cold.match(/chmod -R u\+w "\$(cold|RUNNER_TEMP\/go-cold-cache)"/g) ?? [];
  assert.equal(removals.length, 2);
  assert.equal(chmods.length, removals.length);
});

test('a strict Turbo repo that runs vitest must pass the cap through, or the gate says so', async () => {
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const start = workflow.indexOf("          node - <<'VITEST_PASSTHROUGH'")
  const end = workflow.indexOf('          VITEST_PASSTHROUGH', start + 10)
  assert.ok(start > 0 && end > start, 'the pass-through check must be present')
  const script = workflow.slice(start, end).split('\n').slice(1).map(line => line.replace(/^ {10}/, '')).join('\n')
  const run = files => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vitest-passthrough-'))
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
      writeFileSync(path.join(dir, name), body)
    }
    try {
      execFileSync('node', ['-e', script], { cwd: dir, stdio: 'pipe' })
      return 'ok'
    } catch (error) {
      return String(error.stdout)
    }
  }
  const pkg = JSON.stringify({ devDependencies: { vitest: '4.0.0' } })
  const turbo = pass => `{\n  // growth-labs style\n  "envMode": "strict",\n  "globalPassThroughEnv": ${JSON.stringify(pass)},\n}`
  assert.match(run({ 'turbo.json': turbo(['CI']), 'packages/a/package.json': pkg }), /does not pass VITEST_MAX_WORKERS, VITEST_MAX_THREADS, VITEST_MAX_FORKS through/)
  assert.equal(run({ 'turbo.json': turbo(['CI', 'VITEST_MAX_WORKERS', 'VITEST_MAX_THREADS', 'VITEST_MAX_FORKS']), 'packages/a/package.json': pkg }), 'ok')
  assert.equal(run({ 'turbo.json': turbo(['CI']), 'package.json': JSON.stringify({}) }), 'ok', 'no vitest, nothing to strip')
  assert.equal(run({ 'package.json': pkg }), 'ok', 'no turbo, nothing strips the env')
})

test('the gate reports the vitest worker count it observed, not only the cap it set', () => {
  const gateStart = workflow.indexOf('      - name: CI gate (typecheck + lint + test + build)')
  const gate = workflow.slice(gateStart, workflow.indexOf('      - name: Lockfile integrity'))
  // Counted: node processes with vitest's fork-worker script anywhere in
  // argv, and only inside this step's own process tree (root=$$).
  assert.match(gate, /root=\$\$/)
  assert.match(gate, /for \(i = 4; i <= NF; i\+\+\) if \(\$i ~ \/vitest/)
  assert.match(gate, /\(ppid\[p\] in desc\)/)
  assert.match(gate, /vitest workers observed \(this step only\): at most \$per fork workers/)
  assert.match(gate, /exit "\$status"/)
})

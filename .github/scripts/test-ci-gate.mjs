import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    /echo "npm_config_store_dir=\$RUNNER_TEMP\/pnpm-store" >> "\$GITHUB_ENV"\s*\n\s*echo "pnpm_config_store_dir=\$RUNNER_TEMP\/pnpm-store" >> "\$GITHUB_ENV"/,
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
  // its own directory under RUNNER_TEMP and no move: Forgejo's RUNNER_TEMP is /tmp, where the old mv moved onto itself
  assert.match(gitleaks, /dir="\$\(mktemp -d "\$RUNNER_TEMP\/gitleaks\.XXXXXX"\)"/);
  assert.match(gitleaks, /tar -xzf "\$dir\/gitleaks\.tar\.gz" -C "\$dir" gitleaks/);
  assert.match(gitleaks, /echo "\$dir" >> "\$GITHUB_PATH"/);
  assert.doesNotMatch(gitleaks, /\bmv\b|\/tmp\//);
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
  // The caller's build command reaches the shell through the environment, never as an expression in the script.
  const buildStep = cold.slice(build, cold.indexOf('      - name: Cold-cache footprint'));
  assert.match(buildStep, /\n        env:\n          BUILD_COMMAND: \$\{\{ inputs\.build-command \}\}\n/);
  assert.match(buildStep, /\n          eval "\$BUILD_COMMAND"\n/);
  assert.doesNotMatch(buildStep.slice(buildStep.indexOf('run: |')), /\$\{\{/);
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

test('the Go cold-cache leg uses a Go already on PATH and runs setup-go only on GitHub when go is absent', () => {
  const cold = readFileSync(new URL('../workflows/go-cold-cache.yml', import.meta.url), 'utf8');
  assert.match(cold, /^      GOTOOLCHAIN: local$/m);
  const uses = [...cold.matchAll(/uses: actions\/setup-go@/g)];
  assert.equal(uses.length, 1, 'exactly one setup-go step');
  const setupAt = cold.indexOf('uses: actions/setup-go@');
  const stepStart = cold.lastIndexOf('\n      - ', setupAt);
  const stepEnd = cold.indexOf('\n      - ', setupAt);
  const step = cold.slice(stepStart, stepEnd);
  // Gated on both conditions, and on nothing that would let Forgejo through.
  assert.match(step, /if: \$\{\{ steps\.go-probe\.outputs\.present != 'true' && github\.server_url == 'https:\/\/github\.com' \}\}/);
  // The probe precedes setup-go and reads PATH.
  const probe = cold.indexOf('id: go-probe');
  assert.ok(probe >= 0 && probe < setupAt, 'the go probe must precede setup-go');
  assert.match(cold.slice(probe, setupAt), /command -v go/);
  assert.match(cold.slice(probe, setupAt), /present=true/);
  // A plain `go version` follows, unconditional, so Forgejo fails loudly with no go.
  const after = cold.slice(stepEnd, cold.indexOf('- name: Point every Go cache'));
  assert.match(after, /- name: Go toolchain\n(?:        #.*\n)*        run: go version\n/);
  assert.doesNotMatch(after, /\n        if:/);
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

test('the caller\'s check command reaches the gate through env, never spliced into the script', () => {
  const gateStart = workflow.indexOf('      - name: CI gate (typecheck + lint + test + build)')
  const gate = workflow.slice(gateStart, workflow.indexOf('      - name: Lockfile integrity', gateStart))
  const run = gate.slice(gate.indexOf('run: |'), gate.indexOf('        env:'))
  assert.doesNotMatch(run, /\$\{\{/, 'no ${{ }} expression inside the gate run script (run-shell-injection)')
  assert.match(run, /eval "\$CHECK_COMMAND"/)
  assert.match(gate, /CHECK_COMMAND: \$\{\{ inputs\.check-command \}\}/)
})

test('gitleaks scans the commits of the event, not every branch of the checkout', () => {
  const start = workflow.indexOf('      - name: Gitleaks scan')
  const step = workflow.slice(start, workflow.indexOf('\n  semgrep:', start))
  const run = step.slice(step.indexOf('run: |'))
  assert.doesNotMatch(run, /\$\{\{/, 'no ${{ }} expression inside the scan script (run-shell-injection)')
  for (const name of ['EVENT_NAME', 'PR_BASE', 'PR_HEAD', 'MG_BASE', 'MG_HEAD', 'PUSHED_SHA']) {
    assert.match(step, new RegExp(`${name}: \\$\\{\\{ github\\.`), `${name} is passed through env`)
  }

  // Run the step's own script with a gitleaks that records its argv.
  const dir = mkdtempSync(join(tmpdir(), 'gitleaks-scope-'))
  writeFileSync(join(dir, 'gitleaks'), '#!/bin/sh\necho "ARGS: $*"\n')
  chmodSync(join(dir, 'gitleaks'), 0o755)
  const script = run.split('\n').slice(1).map(line => line.replace(/^ {10}/, '')).join('\n')
  // A real repository, so that "is this SHA a commit here" is answered by git, not by the test.
  const repo = mkdtempSync(join(tmpdir(), 'gitleaks-scope-repo-'))
  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).stdout.trim()
  git('init', '-q', '-b', 'main')
  git('commit', '-q', '--allow-empty', '-m', 'one')
  const one = git('rev-parse', 'HEAD')
  git('commit', '-q', '--allow-empty', '-m', 'two')
  const two = git('rev-parse', 'HEAD')
  const runScan = (event, vars) => spawnSync('bash', ['-c', script], {
    cwd: repo,
    encoding: 'utf8',
    env: { PATH: `${dir}:${process.env.PATH}`, EVENT_NAME: event, ...vars },
  })
  const scan = (event, vars = { PR_BASE: one, PR_HEAD: two, MG_BASE: one, MG_HEAD: two, PUSHED_SHA: two }) => runScan(event, vars).stdout.trim()
  const common = 'detect --source . --no-banner --redact --verbose'
  assert.equal(scan('pull_request'), `ARGS: ${common} --log-opts=${one}..${two}`)
  assert.equal(scan('pull_request_target'), `ARGS: ${common} --log-opts=${one}..${two}`)
  assert.equal(scan('merge_group'), `ARGS: ${common} --log-opts=${one}..${two}`)
  assert.equal(scan('push'), `ARGS: ${common} --log-opts=${two}`)
  assert.equal(scan('schedule'), `ARGS: ${common}`, 'a scheduled run still scans every branch')
  assert.equal(scan('workflow_dispatch'), `ARGS: ${common}`)
})

test('gitleaks fails closed on a scan range it cannot read: gitleaks itself exits 0 on a missing commit', () => {
  const start = workflow.indexOf('      - name: Gitleaks scan')
  const step = workflow.slice(start, workflow.indexOf('\n  semgrep:', start))
  const script = step.slice(step.indexOf('run: |')).split('\n').slice(1).map(line => line.replace(/^ {10}/, '')).join('\n')
  const dir = mkdtempSync(join(tmpdir(), 'gitleaks-closed-'))
  writeFileSync(join(dir, 'gitleaks'), '#!/bin/sh\necho "GITLEAKS RAN"\n')
  chmodSync(join(dir, 'gitleaks'), 0o755)
  const repo = mkdtempSync(join(tmpdir(), 'gitleaks-closed-repo-'))
  const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).stdout.trim()
  g('init', '-q', '-b', 'main'); g('commit', '-q', '--allow-empty', '-m', 'one')
  const sha = g('rev-parse', 'HEAD')
  const missing = '0123456789abcdef0123456789abcdef01234567'
  const run = vars => spawnSync('bash', ['-c', script], { cwd: repo, encoding: 'utf8', env: { PATH: `${dir}:${process.env.PATH}`, ...vars } })
  const cases = [
    ['a missing head', { EVENT_NAME: 'pull_request', PR_BASE: sha, PR_HEAD: missing }],
    ['a missing base', { EVENT_NAME: 'pull_request_target', PR_BASE: missing, PR_HEAD: sha }],
    ['an empty base', { EVENT_NAME: 'pull_request', PR_BASE: '', PR_HEAD: sha }],
    ['a branch name for a SHA', { EVENT_NAME: 'pull_request', PR_BASE: 'main', PR_HEAD: sha }],
    ['a missing merge-group head', { EVENT_NAME: 'merge_group', MG_BASE: sha, MG_HEAD: missing }],
    ['a missing pushed commit', { EVENT_NAME: 'push', PUSHED_SHA: missing }],
    ['an empty pushed commit', { EVENT_NAME: 'push', PUSHED_SHA: '' }],
  ]
  for (const [why, vars] of cases) {
    const result = run(vars)
    assert.notEqual(result.status, 0, `${why}: the job must fail`)
    assert.doesNotMatch(result.stdout, /GITLEAKS RAN/, `${why}: gitleaks must not run on a range it cannot read`)
    assert.match(result.stderr, /gitleaks scan range/, why)
  }
  // The same step still runs for a readable range.
  const good = run({ EVENT_NAME: 'pull_request', PR_BASE: sha, PR_HEAD: sha })
  assert.equal(good.status, 0)
  assert.match(good.stdout, /GITLEAKS RAN/)
})

test('the gitleaks download is pinned by sha256 and verified before it is unpacked', () => {
  const start = workflow.indexOf('      - name: Install gitleaks')
  const step = workflow.slice(start, workflow.indexOf('      - name: Gitleaks scan', start))
  const version = /gitleaks\/releases\/download\/(v\d+\.\d+\.\d+)\/gitleaks_(\d+\.\d+\.\d+)_linux_x64\.tar\.gz/.exec(step)
  assert.ok(version, 'the download URL is versioned')
  assert.equal(version[1], `v${version[2]}`, 'tag and file version agree')
  const check = /echo "([0-9a-f]{64})  \$dir\/gitleaks\.tar\.gz" \| sha256sum -c -/.exec(step)
  assert.ok(check, 'a 64-hex sha256 is checked with sha256sum -c')
  assert.ok(step.indexOf('sha256sum -c -') > step.indexOf('curl -sSL'), 'the check follows the download')
  assert.ok(step.indexOf('sha256sum -c -') < step.indexOf('tar -xzf'), 'the check precedes the unpack')
  // gitleaks 8.21.2 linux_x64, from the release's checksums file; changing the version means changing this value.
  assert.equal(check[1], '5bc41815076e6ed6ef8fbecc9d9b75bcae31f39029ceb55da08086315316e3ba')
  assert.equal(version[2], '8.21.2')
})

test('no checkout in the gate leaves the job token in .git/config', () => {
  // Every job here goes on to run repository code (pnpm install, the consumer's scripts, a scanner), and a token left in
  // .git/config by actions/checkout is readable by all of it. No step runs git against the remote after the checkout, so no
  // checkout needs the credential. A new job that does need it must say why in this test, not drop the line.
  const lines = workflow.split('\n')
  const checkouts = []
  lines.forEach((line, index) => {
    if (!/^\s*(- )?uses:\s*actions\/checkout@/.test(line)) return
    const indent = line.match(/^\s*/)[0].length + (line.trimStart().startsWith('- ') ? 2 : 0)
    let end = index + 1
    while (end < lines.length && (lines[end].trim() === '' ? false : lines[end].match(/^\s*/)[0].length >= indent)) end += 1
    checkouts.push(lines.slice(index, end).join('\n'))
  })
  assert.equal(checkouts.length, 5, 'quality, docs-lint, gitleaks, semgrep and grype each check out once')
  for (const checkout of checkouts) {
    assert.match(checkout, /persist-credentials: false/, checkout)
  }
  assert.doesNotMatch(workflow, /persist-credentials: true/)
})

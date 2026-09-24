import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../workflows/deploy-gate.yml', import.meta.url), 'utf8');

function extractHeredoc(step, marker) {
  // `[^\n]*` tolerates trailing shell after the closing quote on the opener
  // line (e.g. BINDING_DIFF's `node - <<'BINDING_DIFF' | tee -a "$GITHUB_STEP_SUMMARY"`),
  // not just a bare heredoc redirect.
  const match = step.match(new RegExp(`node - <<'${marker}'[^\\n]*\\n([\\s\\S]*?)\\n\\s*${marker}`));
  assert.ok(match, `${marker} heredoc must be embedded in the step`);
  return match[1].replace(/^ {10}/gm, '');
}

// Different shape from extractHeredoc: DB_NAME resolves via a `node -p "..."`
// command substitution, not a `node - <<'MARKER'` heredoc.
function extractDbNameScript(step) {
  const match = step.match(/DB_NAME="\$\(node -p "\n([\s\S]*?)\n\s*"\)"/);
  assert.ok(match, 'the DB_NAME node -p script must be embedded in the step');
  return match[1];
}

// Same shape, the sibling D1_STAGING_JSON resolution.
function extractStagingJsonScript(step) {
  const match = step.match(/D1_STAGING_JSON="\$\(node -p "\n([\s\S]*?)\n\s*"\)"/);
  assert.ok(match, 'the D1_STAGING_JSON node -p script must be embedded in the step');
  return match[1];
}

// The skip-cleanly-with-a-::notice behaviour lives in the shell AROUND
// DB_NAME, not inside the node -p script itself, so it needs the actual
// bash step run for real (not the node -p script in isolation).
function extractDbNameResolutionShellBlock(step) {
  const marker = 'run: |\n';
  const start = step.indexOf(marker);
  assert.ok(start >= 0, 'the tripwire step must have a run: block');
  const bodyStart = start + marker.length;
  const end = step.indexOf('if ! "$WRANGLER_BIN"', bodyStart);
  assert.ok(end >= 0, 'the run: block must reach the wrangler d1 execute check');
  return step.slice(bodyStart, end).replace(/^ {10}/gm, '');
}

// Captures the run: block from its start through the wrangler d1 execute
// ledger-read call (inclusive) -- further than
// extractDbNameResolutionShellBlock, which stops BEFORE that call. Needed
// to observe what arguments the ledger read actually receives (e.g.
// --config), not just what DB_NAME/D1_STAGING_JSON/notice resolve to.
function extractResolutionAndLedgerReadBlock(step) {
  const marker = 'run: |\n'
  const start = step.indexOf(marker)
  assert.ok(start >= 0, 'the tripwire step must have a run: block')
  const bodyStart = start + marker.length
  const end = step.indexOf("D1_LEDGER_JSON=\"$RUNNER_TEMP/d1-ledger.json\"", bodyStart)
  assert.ok(end >= 0, 'the run: block must reach the heredoc invocation')
  return step.slice(bodyStart, end).replace(/^ {10}/gm, '')
}

function runShellBlock(script, files, env) {
  const root = mkdtempSync(join(tmpdir(), 'd1-shell-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), body);
      // Harmless on a non-script fixture (e.g. .publication/d1-migrations.json);
      // lets a fixture file with a shebang (a fake WRANGLER_BIN) be executed
      // directly without a separate chmod step per test.
      chmodSync(join(root, rel), 0o755);
    }
    return spawnSync('bash', ['-c', script], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function resolveDbName(script, files, env) {
  const root = mkdtempSync(join(tmpdir(), 'd1-dbname-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), body);
    }
    // A real `node -p`, not piped stdin: this is the ASI/TDZ-sensitive shape
    // (KB flake-signature-checkout-freshness..., and the sibling fix in
    // #53 for this exact repo) -- a missing semicolon between two
    // unparenthesized statements silently changes what gets parsed, so this
    // must execute the actual extracted string, never a hand-retyped copy.
    return spawnSync(process.execPath, ['-p', script], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runTripwire(script, files, ledgerNames, extraEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'd1-ledger-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), body);
    }
    const ledgerPath = join(root, 'ledger.json');
    writeFileSync(ledgerPath, JSON.stringify([{ results: ledgerNames.map((name) => ({ name })), success: true }]));
    return spawnSync(process.execPath, ['-'], {
      cwd: root,
      input: script,
      encoding: 'utf8',
      env: { ...process.env, D1_LEDGER_JSON: ledgerPath, ...extraEnv },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the ledger tripwire blocks deployment after wrangler installation, only for repos with a D1 publication contract', () => {
  const installStart = workflow.indexOf('      - name: Install wrangler');
  const deployStart = workflow.indexOf('      - name: Deploy with provenance');
  const tripwireStart = workflow.indexOf('      - name: D1 migration ledger tripwire');
  assert.ok(installStart >= 0 && installStart < tripwireStart && tripwireStart < deployStart,
    'wrangler installation and the D1 ledger tripwire must succeed before deployment');
  const step = workflow.slice(tripwireStart, deployStart);
  // #52 made the ledger contract path app-directory-aware for monorepo
  // callers (M2-14): under `<app-directory>/.publication/d1-migrations.json`
  // when set, and unchanged at the repo root when app-directory is empty --
  // so an existing single-app caller's condition is byte-identical to before.
  assert.match(
    step,
    /if: hashFiles\(inputs\.app-directory != '' && format\('\{0\}\/\.publication\/d1-migrations\.json', inputs\.app-directory\) \|\| '\.publication\/d1-migrations\.json'\) != ''/,
  );
  // "${D1_CONFIG_ARGS[@]}" (reviewer-foundry on #59: binds the ledger read
  // to a verified database-id via a generated --config) sits between
  // "$DB_NAME" and --remote once staging.databaseId is set; empty and a
  // no-op otherwise, so the flag is optional in the match, not required.
  assert.match(step, /d1 execute "\$DB_NAME"(?: "\$\{D1_CONFIG_ARGS\[@\]\}")? --remote --json/);
  assert.match(step, /CF_DEPLOY_API_TOKEN needs D1:Read/);
  assert.doesNotMatch(step, /continue-on-error:|d1 migrations apply/, 'the ledger check must fail closed and never apply migrations');
  assert.doesNotMatch(workflow.slice(deployStart), /if:.*(?:always|failure|cancelled)\(/,
    'deployment must preserve the default success guard after a failed ledger check');
});

test('the ledger tripwire fails on migration files missing from the live ledger', () => {
  const step = workflow.slice(workflow.indexOf('      - name: D1 migration ledger tripwire'));
  const script = extractHeredoc(step, 'D1_LEDGER_TRIPWIRE');
  const files = {
    'wrangler.toml': 'migrations_dir = "node_modules/@growth-labs/analytics/migrations"\n',
    'migrations/0073_a.sql': 'SELECT 1;',
    'migrations/0074_b.sql': 'SELECT 1;',
    'migrations/README.md': 'not sql',
    'node_modules/@growth-labs/analytics/migrations/0006_identity.sql': 'SELECT 1;',
  };

  const complete = runTripwire(script, files, ['0073_a.sql', '0074_b.sql', '0006_identity.sql', '0001_legacy.sql']);
  assert.equal(complete.status, 0, complete.stdout + complete.stderr);
  assert.match(complete.stdout, /3 migration file\(s\) across 2 dir\(s\)/);

  const drifted = runTripwire(script, files, ['0073_a.sql', '0001_legacy.sql']);
  assert.equal(drifted.status, 1);
  assert.match(drifted.stdout, /::error::D1 migration never applied to the live ledger — migrations\/0074_b.sql/);
  assert.match(drifted.stdout, /never applied to the live ledger — node_modules\/@growth-labs\/analytics\/migrations\/0006_identity.sql/);
  assert.doesNotMatch(drifted.stdout, /0073_a.sql/);
});

// fulcrum-labs/platform-foundations#1006 extends .publication/d1-migrations.json
// with a sibling `staging` object; these tests run the actual extracted
// DB_NAME resolution script (not a hand-retyped copy) against real fixture
// files, the same discipline the ledger-tripwire tests above already apply.
test('DB_NAME reads .staging.databaseName on a -staging environment once a project opts in', () => {
  const step = workflow.slice(workflow.indexOf('      - name: D1 migration ledger tripwire'));
  const script = extractDbNameScript(step);
  const files = {
    '.publication/d1-migrations.json': JSON.stringify({
      databaseName: 'fronts-data',
      staging: { databaseName: 'fronts-data-staging' },
    }),
  };

  const staging = resolveDbName(script, files, { GATE_ENVIRONMENT: 'fronts-staging' });
  assert.equal(staging.status, 0, staging.stderr);
  assert.equal(staging.stdout.trim(), 'fronts-data-staging');

  const prod = resolveDbName(script, files, { GATE_ENVIRONMENT: 'fronts-production' });
  assert.equal(prod.status, 0, prod.stderr);
  assert.equal(prod.stdout.trim(), 'fronts-data', 'a -production environment must never read .staging, even when it exists');
});

test('DB_NAME falls back to the top-level databaseName on a -staging environment until a project opts in (paired with the ::notice below, never silent)', () => {
  const step = workflow.slice(workflow.indexOf('      - name: D1 migration ledger tripwire'));
  const script = extractDbNameScript(step);
  const files = {
    '.publication/d1-migrations.json': JSON.stringify({ databaseName: 'fronts-data' }),
  };

  const result = resolveDbName(script, files, { GATE_ENVIRONMENT: 'fronts-staging' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'fronts-data');
});

test('DB_NAME treats a bare "staging" environment name the same as a "*-staging" one', () => {
  const step = workflow.slice(workflow.indexOf('      - name: D1 migration ledger tripwire'));
  const script = extractDbNameScript(step);
  const files = {
    '.publication/d1-migrations.json': JSON.stringify({
      databaseName: 'fronts-data',
      staging: { databaseName: 'fronts-data-staging' },
    }),
  };

  const result = resolveDbName(script, files, { GATE_ENVIRONMENT: 'staging' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'fronts-data-staging');
});

test('DB_NAME defaults GATE_ENVIRONMENT to production when unset, matching the environment input\'s own default', () => {
  const step = workflow.slice(workflow.indexOf('      - name: D1 migration ledger tripwire'));
  const script = extractDbNameScript(step);
  const files = {
    '.publication/d1-migrations.json': JSON.stringify({
      databaseName: 'fronts-data',
      staging: { databaseName: 'fronts-data-staging' },
    }),
  };

  const result = resolveDbName(script, files, {});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'fronts-data');
});

test('D1_STAGING_JSON is empty on a -production environment even when .staging exists, and empty on a -staging environment with no .staging', () => {
  const step = workflow.slice(workflow.indexOf('      - name: D1 migration ledger tripwire'));
  const script = extractStagingJsonScript(step);
  const withStaging = {
    '.publication/d1-migrations.json': JSON.stringify({
      databaseName: 'fronts-data',
      staging: { enabled: true, databaseName: 'fronts-data-staging', reconciliation: 'exact' },
    }),
  };
  const withoutStaging = {
    '.publication/d1-migrations.json': JSON.stringify({ databaseName: 'fronts-data' }),
  };

  const prod = resolveDbName(script, withStaging, { GATE_ENVIRONMENT: 'fronts-production' });
  assert.equal(prod.status, 0, prod.stderr);
  assert.equal(prod.stdout.trim(), '');

  const stagingUnconfigured = resolveDbName(script, withoutStaging, { GATE_ENVIRONMENT: 'fronts-staging' });
  assert.equal(stagingUnconfigured.status, 0, stagingUnconfigured.stderr);
  assert.equal(stagingUnconfigured.stdout.trim(), '');

  const stagingConfigured = resolveDbName(script, withStaging, { GATE_ENVIRONMENT: 'fronts-staging' });
  assert.equal(stagingConfigured.status, 0, stagingConfigured.stderr);
  assert.deepEqual(JSON.parse(stagingConfigured.stdout.trim()), {
    enabled: true,
    databaseName: 'fronts-data-staging',
    reconciliation: 'exact',
  });
});

test('an unconfigured .staging on a -staging environment emits a ::notice naming the environment and the production database it falls back to', () => {
  const step = workflow.slice(workflow.indexOf('      - name: D1 migration ledger tripwire'));
  const script = extractDbNameResolutionShellBlock(step);
  const files = {
    '.publication/d1-migrations.json': JSON.stringify({ databaseName: 'fronts-data' }),
  };

  const result = runShellBlock(script, files, { GATE_ENVIRONMENT: 'fronts-staging' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    /::notice::fronts-staging has no d1Role\.staging yet; checking the production ledger \(fronts-data\)/,
  );
  assert.doesNotMatch(result.stdout, /::error::/);
});

test('a declared-but-unconfigured .staging (enabled:false, no databaseName) still emits the ::notice -- checking D1_STAGING_JSON emptiness alone missed exactly this case', () => {
  const step = workflow.slice(workflow.indexOf('      - name: D1 migration ledger tripwire'));
  const script = extractDbNameResolutionShellBlock(step);
  const files = {
    // .staging EXISTS (so D1_STAGING_JSON would be non-empty), but supplies
    // no databaseName -- DB_NAME must still fall back to prod, and the
    // fallback must still be loud, not silent.
    '.publication/d1-migrations.json': JSON.stringify({
      databaseName: 'fronts-data',
      staging: { enabled: false },
    }),
  };

  const result = runShellBlock(script, files, { GATE_ENVIRONMENT: 'fronts-staging' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    /::notice::fronts-staging has no d1Role\.staging yet; checking the production ledger \(fronts-data\)/,
  );
  assert.doesNotMatch(result.stdout, /::error::/);
});

test('a -production environment with no databaseName at all still hard-errors, exactly as before this existed', () => {
  const step = workflow.slice(workflow.indexOf('      - name: D1 migration ledger tripwire'));
  const script = extractDbNameResolutionShellBlock(step);
  const files = {
    '.publication/d1-migrations.json': JSON.stringify({ staging: { databaseName: 'fronts-data-staging' } }),
  };

  const result = runShellBlock(script, files, { GATE_ENVIRONMENT: 'fronts-production' });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /::error::\.publication\/d1-migrations\.json has no databaseName/);
  assert.doesNotMatch(result.stdout, /::notice::/);
});

test('a configured staging.databaseName on a -staging environment proceeds past the resolution block without a notice or an error', () => {
  const step = workflow.slice(workflow.indexOf('      - name: D1 migration ledger tripwire'));
  const script = extractDbNameResolutionShellBlock(step) + '\necho "REACHED: $DB_NAME"\n';
  const files = {
    '.publication/d1-migrations.json': JSON.stringify({
      databaseName: 'fronts-data',
      staging: { databaseName: 'fronts-data-staging' },
    }),
  };

  const result = runShellBlock(script, files, { GATE_ENVIRONMENT: 'fronts-staging' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /REACHED: fronts-data-staging/);
  assert.doesNotMatch(result.stdout, /::notice::|::error::/);
});

// reviewer-foundry on #59's approval: staging.databaseId was carried into
// D1_STAGING_JSON but never actually used -- the ledger read still resolved
// DB_NAME by name alone, the same gap #58(ii) closed for the apply
// workflow. These run the actual resolution-through-ledger-read block
// against a fake WRANGLER_BIN that records its own argv, so the assertion
// is "the real invocation carried --config pointing at the right id", not
// a guess about what the script does. WRANGLER_BIN/RUNNER_TEMP are set via
// `$(pwd)` INSIDE the script (prepended here), since runShellBlock's temp
// root isn't known until the script is already running in it.
const FAKE_WRANGLER_ARGV_STUB = [
  '#!/usr/bin/env bash',
  'echo "$@" >> "$(pwd)/wrangler-argv.log"',
  'if [[ "$@" == *"--json"* ]]; then echo \'[{"results":[]}]\'; fi',
  '',
].join('\n');

function withFakeWranglerPrefix(script) {
  return 'export WRANGLER_BIN="$(pwd)/bin/wrangler"\nmkdir -p "$(pwd)/tmp"\nexport RUNNER_TEMP="$(pwd)/tmp"\n' + script;
}

test('staging.databaseId binds the ledger read to a generated --config naming the verified id', () => {
  const step = workflow.slice(workflow.indexOf('      - name: D1 migration ledger tripwire'));
  // A marker line between the two `cat`s makes it unambiguous which output
  // is the argv log and which is the generated config, from one run.
  const script = withFakeWranglerPrefix(extractResolutionAndLedgerReadBlock(step))
    + '\ncat "$(pwd)/wrangler-argv.log"\necho "===CONFIG==="\ncat "$RUNNER_TEMP/d1-tripwire-config.json"\n';
  const files = {
    '.publication/d1-migrations.json': JSON.stringify({
      databaseName: 'fronts-data',
      staging: {
        enabled: true,
        databaseName: 'fronts-data-staging',
        reconciliation: 'exact',
        databaseId: 'aaaa-1111-verified-uuid',
      },
    }),
    'bin/wrangler': FAKE_WRANGLER_ARGV_STUB,
  };

  const result = runShellBlock(script, files, { GATE_ENVIRONMENT: 'fronts-staging' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [argvLog, configJson] = result.stdout.split('===CONFIG===\n');
  assert.match(argvLog, /--config \S*d1-tripwire-config\.json/);
  assert.match(argvLog, /d1 execute fronts-data-staging/);
  assert.deepEqual(JSON.parse(configJson.trim()), {
    d1_databases: [{ binding: 'DB', database_name: 'fronts-data-staging', database_id: 'aaaa-1111-verified-uuid' }],
  });
});

test('without a databaseId, the ledger read carries no --config at all -- unchanged for every project that has not opted in yet', () => {
  const step = workflow.slice(workflow.indexOf('      - name: D1 migration ledger tripwire'));
  const script = withFakeWranglerPrefix(extractResolutionAndLedgerReadBlock(step)) + '\ncat "$(pwd)/wrangler-argv.log"\n';
  const files = {
    '.publication/d1-migrations.json': JSON.stringify({
      databaseName: 'fronts-data',
      staging: { enabled: true, databaseName: 'fronts-data-staging', reconciliation: 'exact' },
    }),
    'bin/wrangler': FAKE_WRANGLER_ARGV_STUB,
  };

  const result = runShellBlock(script, files, { GATE_ENVIRONMENT: 'fronts-staging' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /--config/);
  assert.match(result.stdout, /d1 execute fronts-data-staging/);
});

// The catch-up tolerance itself lives in the ledger-tripwire heredoc (it
// needs the missing-file diff already computed there), fed by
// D1_STAGING_JSON -- these run the actual extracted heredoc, the same
// discipline 'the ledger tripwire fails on migration files missing...' above
// already applies, now parameterised by a staging JSON payload.
test('an unexpired catch-up warns with the missing count and deadline, and exits 0, instead of hard-erroring', () => {
  const step = workflow.slice(workflow.indexOf('      - name: D1 migration ledger tripwire'));
  const script = extractHeredoc(step, 'D1_LEDGER_TRIPWIRE');
  const files = { 'migrations/0001_a.sql': 'SELECT 1;', 'migrations/0002_b.sql': 'SELECT 1;' };
  const staging = JSON.stringify({
    enabled: true,
    databaseName: 'fronts-data-staging',
    reconciliation: 'catch-up',
    catchUpUntil: '2099-01-01T00:00:00Z',
  });

  const result = runTripwire(script, files, ['0001_a.sql'], { D1_STAGING_JSON: staging, D1_DB_NAME: 'fronts-data-staging' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /::warning::staging D1 in catch-up until 2099-01-01T00:00:00Z: 1 of 2 migrations missing/);
  assert.doesNotMatch(result.stdout, /::error::/);
});

test('an expired catch-up window hard-errors exactly like a fully reconciled ledger, per missing file', () => {
  const step = workflow.slice(workflow.indexOf('      - name: D1 migration ledger tripwire'));
  const script = extractHeredoc(step, 'D1_LEDGER_TRIPWIRE');
  const files = { 'migrations/0001_a.sql': 'SELECT 1;', 'migrations/0002_b.sql': 'SELECT 1;' };
  const staging = JSON.stringify({
    enabled: true,
    databaseName: 'fronts-data-staging',
    reconciliation: 'catch-up',
    catchUpUntil: '2020-01-01T00:00:00Z',
  });

  const result = runTripwire(script, files, ['0001_a.sql'], { D1_STAGING_JSON: staging, D1_DB_NAME: 'fronts-data-staging' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /::error::D1 migration never applied to the live ledger — migrations\/0002_b\.sql/);
  assert.doesNotMatch(result.stdout, /::warning::/);
});

test('an exact reconciliation hard-errors on any missing file, same as a disabled staging block -- catch-up tolerance never applies to either', () => {
  const step = workflow.slice(workflow.indexOf('      - name: D1 migration ledger tripwire'));
  const script = extractHeredoc(step, 'D1_LEDGER_TRIPWIRE');
  const files = { 'migrations/0001_a.sql': 'SELECT 1;', 'migrations/0002_b.sql': 'SELECT 1;' };

  const exact = JSON.stringify({ enabled: true, databaseName: 'fronts-data-staging', reconciliation: 'exact' });
  const exactResult = runTripwire(script, files, ['0001_a.sql'], { D1_STAGING_JSON: exact, D1_DB_NAME: 'fronts-data-staging' });
  assert.equal(exactResult.status, 1);
  assert.match(exactResult.stdout, /::error::D1 migration never applied to the live ledger — migrations\/0002_b\.sql/);

  const disabled = JSON.stringify({
    enabled: false,
    databaseName: 'fronts-data-staging',
    reconciliation: 'catch-up',
    catchUpUntil: '2099-01-01T00:00:00Z',
  });
  const disabledResult = runTripwire(script, files, ['0001_a.sql'], { D1_STAGING_JSON: disabled, D1_DB_NAME: 'fronts-data-staging' });
  assert.equal(disabledResult.status, 1);
  assert.match(disabledResult.stdout, /::error::D1 migration never applied to the live ledger — migrations\/0002_b\.sql/);
});

test('zero migration files is still a hard error regardless of catch-up state', () => {
  const step = workflow.slice(workflow.indexOf('      - name: D1 migration ledger tripwire'));
  const script = extractHeredoc(step, 'D1_LEDGER_TRIPWIRE');
  const staging = JSON.stringify({
    enabled: true,
    databaseName: 'fronts-data-staging',
    reconciliation: 'catch-up',
    catchUpUntil: '2099-01-01T00:00:00Z',
  });

  const result = runTripwire(script, {}, [], { D1_STAGING_JSON: staging, D1_DB_NAME: 'fronts-data-staging', APP_DIRECTORY: 'publications/fronts' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /::error::zero migration files is unrun, never a pass/);
});

test('a clean ledger names DB_NAME in the success line', () => {
  const step = workflow.slice(workflow.indexOf('      - name: D1 migration ledger tripwire'));
  const script = extractHeredoc(step, 'D1_LEDGER_TRIPWIRE');
  const files = { 'migrations/0001_a.sql': 'SELECT 1;' };

  const result = runTripwire(script, files, ['0001_a.sql'], { D1_DB_NAME: 'fronts-data-staging' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /D1 migration ledger tripwire: 1 migration file\(s\) across 1 dir\(s\), all present in the ledger \(1 rows\) for fronts-data-staging/);
});

// Same discipline as the dry-run version-listing snippet's own equivalent
// test below: a missing semicolon between two unparenthesized statements is
// exactly how this repo's own worst ASI/TDZ incident (run 35916382952)
// happened. Caught live while drafting this script -- the unsemicoloned
// version silently returned `undefined` for every input.
test('the DB_NAME and D1_STAGING_JSON node -p scripts are free of unsemicoloned statements', () => {
  const step = workflow.slice(workflow.indexOf('      - name: D1 migration ledger tripwire'));
  for (const script of [extractDbNameScript(step), extractStagingJsonScript(step)]) {
    for (const statement of script.split('\n').filter((line) => line.trim() !== '')) {
      assert.match(statement.trim(), /;$/, `every statement must end in an explicit semicolon: ${statement}`);
    }
  }
});

// ─── Risk-matched journey gate (operating-baseline B-03) ───
//
// The gate's whole value is that it REFUSES. These tests run the actual
// github-script body extracted from the workflow against a stub Octokit, so a
// future edit that turns a refusal into a pass fails here rather than in
// production four and a half hours after every member starts seeing 500s.

function extractJourneyGateScript() {
  const marker = '          script: |\n';
  const start = workflow.indexOf(marker);
  assert.ok(start >= 0, 'the journey gate must embed a github-script body');
  const lines = [];
  for (const line of workflow.slice(start + marker.length).split('\n')) {
    if (line.trim() !== '' && !line.startsWith('            ')) break;
    lines.push(line.slice(12));
  }
  return lines.join('\n');
}

const journeyGateScript = extractJourneyGateScript();

function stubCore() {
  const state = { failed: null, errors: [], warnings: [], summary: [] };
  const summary = {
    addHeading(text) { state.summary.push(text); return summary; },
    addRaw(text) { state.summary.push(text); return summary; },
    async write() { return summary; },
  };
  return {
    state,
    core: {
      summary,
      error: (message) => state.errors.push(message),
      warning: (message) => state.warnings.push(message),
      info: () => {},
      setFailed: (message) => { state.failed = message; },
    },
  };
}

// #52 added a SECOND `checks.listForRef` call (on the deployed commit itself,
// checked before the pull-request-head fallback -- see the script's own
// comment on "stronger evidence than a PR preview"). The real Octokit
// paginate() is called with {ref, ...} and returns only check runs that
// exist for that exact ref; a run on the PR's head sha never appears when
// querying the deployed commit's sha, and vice versa. The stub must model
// that per-ref scoping -- checkRunsBySha keyed by the ref -- not return one
// undifferentiated list for every `checks.listForRef` call regardless of
// which ref was queried. (A flat `checkRuns` list previously let a fixture
// written for an unrelated PR's head leak into the new deploy-sha lookup;
// see the "unmerged associated pull request" test below.)
async function runJourneyGate({ env, pulls = [], checkRunsBySha = {} }) {
  const { state, core } = stubCore();
  const github = {
    rest: {
      repos: { listPullRequestsAssociatedWithCommit: 'pulls' },
      checks: { listForRef: 'checks' },
    },
    async paginate(route, params) {
      if (route === 'pulls') return pulls;
      return checkRunsBySha[params.ref] ?? [];
    },
  };
  const context = { repo: { owner: 'fulcrum-labs', repo: 'fronts' } };
  const previous = process.env;
  process.env = { ...previous, ...env };
  try {
    const run = new Function(
      'github', 'context', 'core',
      `return (async () => {${journeyGateScript}})()`,
    );
    await run(github, context, core);
  } finally {
    process.env = previous;
  }
  return state;
}

const GATE_ENV = {
  DEPLOY_SHA: 'a'.repeat(40),
  REQUIRED_CHECK: 'Fronts preview journeys',
  OVERRIDE_REASON: '',
};
const mergedPr = {
  number: 42,
  merged_at: '2026-09-14T20:00:00Z',
  head: { sha: 'b'.repeat(40) },
};

test('the journey gate runs before the production build, so a failing journey costs no fleet minutes', () => {
  const gateStart = workflow.indexOf('      - name: Preview journeys gate');
  const checkoutStart = workflow.indexOf('      - uses: actions/checkout@v5');
  const buildStart = workflow.indexOf('      - name: Production build');
  assert.ok(gateStart >= 0, 'deploy-gate must carry the preview journeys gate');
  assert.ok(gateStart < checkoutStart, 'the gate must refuse before the repo is even checked out');
  assert.ok(checkoutStart < buildStart);
});

test('the gate is inert unless the caller names a required journey check, and is skipped on a read-only dry-run', () => {
  // #52 added `&& !inputs.dry-run`: a dry-run never deploys, so gating it on
  // journeys would refuse read-only diffs for no safety benefit.
  const gate = workflow.slice(workflow.indexOf('      - name: Preview journeys gate'));
  assert.match(gate, /^\s+if: inputs\.required-journey-check != '' && !inputs\.dry-run$/m);
  assert.match(workflow, /^      required-journey-check:\n        type: string\n        default: ''$/m);
});

test('the gate declares no permissions of its own, so one pin serves both shapes of caller', () => {
  // A reusable workflow that omits `permissions` inherits the caller job's
  // token scopes verbatim. Declaring the journey gate's wider set here would
  // push `pull-requests: read` + `checks: read` at every existing caller that
  // grants only `contents: read` -- which is the whole fleet's deploy path.
  assert.ok(!/^permissions:$/m.test(workflow), 'no workflow-level permissions block');
  const job = workflow.slice(workflow.indexOf('  deploy:'), workflow.indexOf('    steps:'));
  assert.ok(!job.includes('permissions:'), 'no job-level permissions block');
  // #52 reworded the description around the new deployed-commit-first lookup.
  assert.match(
    workflow,
    /A caller that sets this MUST grant\n\s+`pull-requests: read` and `checks: read` alongside `contents: read`\n\s+on its calling job\./,
    'the input description must tell callers which scopes to grant',
  );
});

test('a green journey run on the originating PR head lets the deploy proceed (deployed-commit lookup empty, falls back to PR head)', async () => {
  const state = await runJourneyGate({
    env: GATE_ENV,
    pulls: [mergedPr],
    checkRunsBySha: {
      [mergedPr.head.sha]: [{
        status: 'completed',
        conclusion: 'success',
        completed_at: '2026-09-14T19:50:00Z',
        html_url: 'https://github.com/fulcrum-labs/fronts/runs/1',
      }],
    },
  });
  assert.equal(state.failed, null);
  assert.equal(state.errors.length, 0);
});

test('a green journey run directly on the deployed commit lets the deploy proceed, without ever consulting the pull request (#52 deployed-commit-first lookup)', async () => {
  const state = await runJourneyGate({
    env: GATE_ENV,
    pulls: [],
    checkRunsBySha: {
      [GATE_ENV.DEPLOY_SHA]: [{
        status: 'completed',
        conclusion: 'success',
        completed_at: '2026-09-14T19:50:00Z',
        html_url: 'https://github.com/fulcrum-labs/fronts/runs/2',
      }],
    },
  });
  assert.equal(state.failed, null);
  assert.equal(state.errors.length, 0);
  assert.match(state.summary.join('\n'), /deployed commit/);
});

test('a failed journey run refuses the deploy and names the run', async () => {
  const state = await runJourneyGate({
    env: GATE_ENV,
    pulls: [mergedPr],
    checkRunsBySha: {
      [mergedPr.head.sha]: [{
        status: 'completed',
        conclusion: 'failure',
        completed_at: '2026-09-14T19:50:00Z',
        html_url: 'https://github.com/fulcrum-labs/fronts/runs/1',
        output: { title: 'member-video failed', summary: 'playback never started' },
      }],
    },
  });
  assert.ok(state.failed, 'a failed journey must fail the deploy');
  assert.match(state.errors.join('\n'), /concluded \*\*failure\*\*/);
  assert.match(state.errors.join('\n'), /runs\/1/);
});

test('the newest completed journey run decides, not the first one listed', async () => {
  const state = await runJourneyGate({
    env: GATE_ENV,
    pulls: [mergedPr],
    checkRunsBySha: {
      [mergedPr.head.sha]: [
        { status: 'completed', conclusion: 'success', completed_at: '2026-09-14T18:00:00Z', html_url: 'https://x/1' },
        { status: 'completed', conclusion: 'failure', completed_at: '2026-09-14T19:00:00Z', html_url: 'https://x/2' },
      ],
    },
  });
  assert.ok(state.failed, 'the latest run failed, so the deploy must refuse');
});

test('journeys that never completed refuse the deploy rather than letting it outrun the gate', async () => {
  const state = await runJourneyGate({
    env: GATE_ENV,
    pulls: [mergedPr],
    checkRunsBySha: { [mergedPr.head.sha]: [{ status: 'in_progress', conclusion: null }] },
  });
  assert.ok(state.failed);
  assert.match(state.errors.join('\n'), /no completed run/);
});

test('a commit with no merged pull request cannot deploy a member-facing site', async () => {
  const state = await runJourneyGate({ env: GATE_ENV, pulls: [] });
  assert.ok(state.failed);
  assert.match(state.errors.join('\n'), /No merged pull request/);
});

// Root-caused 2026-09-23: this test failed after #52 added the
// deployed-commit-first `checks.listForRef` lookup, because the OLD stub
// returned one undifferentiated `checkRuns` list for every `checks.listForRef`
// call regardless of which `ref` was queried -- so a fixture written to
// represent a check run on this UNMERGED PR's head sha (never meant to be
// reachable, since the pre-#52 script only consulted checkRuns after
// confirming a merge) got misread as a run on the DEPLOYED commit itself,
// letting the gate pass before it ever reached the merge check. That was a
// test-double gap, not a gate bug: the real deploy-gate.yml script (and the
// real Octokit paginate()) only returns check runs for the exact ref queried,
// so a run on an unrelated PR's head can never satisfy a lookup scoped to the
// deployed commit. checkRunsBySha now models that scoping -- the fixture
// stays keyed to the unmerged PR's head sha, and the deployed commit's own
// bucket is left empty, exactly as a real fresh commit with no check run of
// its own would look -- and this asserts the success run is never consulted.
test('an unmerged associated pull request does not satisfy the gate, and a success run on ITS head never leaks into the deployed-commit lookup', async () => {
  const unmergedPr = { number: 7, merged_at: null, head: { sha: 'c'.repeat(40) } };
  const state = await runJourneyGate({
    env: GATE_ENV,
    pulls: [unmergedPr],
    checkRunsBySha: {
      [unmergedPr.head.sha]: [{ status: 'completed', conclusion: 'success', completed_at: '2026-09-14T19:00:00Z' }],
    },
  });
  assert.ok(state.failed);
  assert.match(state.errors.join('\n'), /No merged pull request/);
});

test('an override reason bypasses the gate loudly and never silently', async () => {
  const state = await runJourneyGate({
    env: { ...GATE_ENV, OVERRIDE_REASON: 'incident 2026-09-14: revert the 500' },
    pulls: [],
  });
  assert.equal(state.failed, null, 'an explicit override must let the deploy through');
  assert.match(state.warnings.join('\n'), /overridden: incident 2026-09-14/);
  assert.match(state.summary.join('\n'), /BYPASSED/);
});

test('the override input exists only for callers to wire from workflow_dispatch', () => {
  assert.match(workflow, /^      journeys-override-reason:\n        type: string\n        default: ''$/m);
  assert.match(workflow, /never from the push\/workflow_run path/);
});

// ─── Dry-run inline scripts (ASI hazard) ───
//
// growth-labs/publishing run 35916382952 (Fronts staging dry-run, 2026-09-23
// 20:33Z), step "Dry-run binding diff": ReferenceError: Cannot access
// 'newest' before initialization at [eval]:4:4. The version-listing
// `node -p` script had no semicolons; ASI does not break a statement before a
// line starting with `(`, so `const newest = [...d].sort(...)[0]` followed
// by a line starting `(newest?.versions ?? [])...` parsed as one statement --
// a call `...[0](newest?.versions ...)` that reads `newest` inside its own
// initializer. These tests extract the actual inline scripts from the
// workflow and execute them with node against live-shape fixtures, so a
// future edit that reintroduces this hazard (or any real behavior
// regression) fails here, not four minutes into a live dry-run.

function fixturePath(name) {
  return new URL(`fixtures/${name}`, import.meta.url);
}

function extractVersionIdsScript() {
  const anchor = 'DEPLOYMENTS_JSON="$RUNNER_TEMP/live-deployments.json" node -p "\n';
  const start = workflow.indexOf(anchor);
  assert.ok(start >= 0, 'the dry-run version-listing snippet must read DEPLOYMENTS_JSON through env, not through $RUNNER_TEMP interpolated into the script body');
  const bodyStart = start + anchor.length;
  const end = workflow.indexOf('\n          ")"', bodyStart);
  assert.ok(end >= 0, 'the version-listing node -p script must close with ")"');
  return workflow.slice(bodyStart, end).replace(/^ {12}/gm, '');
}

test('the dry-run version-listing snippet is free of unsemicoloned statements', () => {
  const script = extractVersionIdsScript();
  for (const statement of script.split('\n').filter((line) => line.trim() !== '')) {
    assert.match(statement.trim(), /;$/, `every statement must end in an explicit semicolon: ${statement}`);
  }
});

test('the dry-run version-listing snippet parses and lists the newest deployment\'s version ids, against the real fronts-staging shape (growth-labs/publishing run 35916382952)', () => {
  const script = extractVersionIdsScript();
  const deploymentsJson = fixturePath('fronts-staging-deployments.json');
  const result = spawnSync(process.execPath, ['-p', script], {
    encoding: 'utf8',
    env: { ...process.env, DEPLOYMENTS_JSON: deploymentsJson.pathname },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stderr, /ReferenceError/);
  // The staging fixture's newest deployment (created_on 2026-09-22T12:42:48Z)
  // has exactly one version at 100%.
  assert.equal(result.stdout.trim(), '3bd93141-0fd0-4b4e-9db8-e57d548c6714');
});

test('reproduces the exact ASI/TDZ failure from run 35916382952 on the unsemicoloned pre-fix shape', () => {
  // Not the live workflow text (the fix already replaced it) -- the exact
  // shape that shipped at 530670d, kept here so the failure mode itself
  // stays pinned even after the live snippet moves on.
  const preFixScript = [
    "const d = JSON.parse(require('fs').readFileSync(process.env.DEPLOYMENTS_JSON, 'utf8')).result?.deployments ?? []",
    'const newest = [...d].sort((a, b) => new Date(b.created_on || 0) - new Date(a.created_on || 0))[0]',
    "(newest?.versions ?? []).map((v) => v.version_id).join('\\n')",
  ].join('\n');
  const deploymentsJson = fixturePath('fronts-staging-deployments.json');
  const result = spawnSync(process.execPath, ['-p', preFixScript], {
    encoding: 'utf8',
    env: { ...process.env, DEPLOYMENTS_JSON: deploymentsJson.pathname },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cannot access 'newest' before initialization/);
});

function readFixture(name) {
  return readFileSync(fixturePath(name), 'utf8');
}

// CONFIG_JSON (a built wrangler config) and SETTINGS_JSON (the live Worker
// settings response) are not part of the vendored live fixtures -- neither
// was captured in the brief -- so they are hand-built here to the documented
// shapes (wrangler's RawConfig, and the CF Workers scripts/{name}/settings
// response) rather than guessed. DEPLOYMENTS_JSON/SCHEDULES_JSON/
// SUBDOMAIN_JSON below are the real vendored fronts-staging fixtures.
function bindingDiffEnv(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'binding-diff-'));
  const write = (name, body) => {
    const path = join(root, name);
    writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
    return path;
  };
  const builtConfig = {
    compatibility_date: '2026-08-01',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: true,
    observability: { enabled: true },
    triggers: { crons: ['*/5 * * * *'] },
    vars: { SITE_URL: 'https://staging.fronts.co' },
    d1_databases: [{ binding: 'DB', database_id: 'd1-fronts-staging' }],
    ...overrides.built,
  };
  const settingsResp = {
    result: {
      compatibility_date: '2026-08-01',
      compatibility_flags: ['nodejs_compat'],
      observability: { enabled: true },
      bindings: [
        { name: 'SITE_URL', type: 'plain_text', text: 'https://staging.fronts.co' },
        { name: 'DB', type: 'd1', id: 'd1-fronts-staging' },
      ],
      ...overrides.live,
    },
  };
  return {
    root,
    env: {
      ...process.env,
      CONFIG_JSON: write('config.json', builtConfig),
      SETTINGS_JSON: write('settings.json', settingsResp),
      SCHEDULES_JSON: write('schedules.json', readFixture('fronts-staging-schedules.json')),
      SUBDOMAIN_JSON: write('subdomain.json', readFixture('fronts-staging-subdomain.json')),
      DEPLOYMENTS_JSON: write('deployments.json', readFixture('fronts-staging-deployments.json')),
    },
  };
}

function runBindingDiff(overrides) {
  const script = extractHeredoc(
    workflow.slice(workflow.indexOf('      - name: Dry-run binding diff')),
    'BINDING_DIFF',
  );
  const { root, env } = bindingDiffEnv(overrides);
  try {
    return spawnSync(process.execPath, ['-'], { input: script, encoding: 'utf8', env });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the binding diff parses and passes when the built config matches live, against the real fronts-staging shape', () => {
  const result = runBindingDiff();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /ReferenceError/);
  assert.match(result.stdout, /only in built \(0\):/);
  assert.match(result.stdout, /only in live \(0\):/);
  assert.match(result.stdout, /active deployment .* rollback target:/);
});

test('the binding diff fails loudly when the built config declares a binding live does not have', () => {
  const result = runBindingDiff({
    built: { r2_buckets: [{ binding: 'MEDIA', bucket_name: 'fronts-media-staging' }] },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /only in built \(1\):/);
  assert.match(result.stdout, /MEDIA r2_bucket fronts-media-staging/);
});

test('the binding diff fails loudly on a settings drift (crons) even with identical bindings', () => {
  const result = runBindingDiff({ built: { triggers: { crons: ['*/10 * * * *'] } } });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /crons: built=\["\*\/10 \* \* \* \*"\] live=\["\*\/5 \* \* \* \*"\] — DIFF/);
});

test('an unhandled binding class fails the dry-run instead of being silently skipped', () => {
  const result = runBindingDiff({ built: { durable_objects: { bindings: [{ name: 'COUNTER', class_name: 'Counter' }] } } });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /::error::unhandled binding class `durable_objects`/);
});

// require-descends-from-live (deploy-workflow-run-starvation H1(b)): closes
// the TOCTOU window between a caller's own live-tag-vs-tip decision and the
// actual deploy by re-reading the live tag fresh, immediately before
// `wrangler deploy`, and refusing unless it is an ancestor of $GITHUB_SHA.

function extractRequireDescendsStep() {
  const start = workflow.indexOf('      - name: Refuse a deploy older than the live tag');
  const end = workflow.indexOf('      - name: Deploy with provenance');
  assert.ok(start >= 0 && end > start, 'the require-descends-from-live step must precede Deploy with provenance');
  return workflow.slice(start, end);
}

test('require-descends-from-live is inert by default and gated the same way as dry-run (never fires for an existing caller)', () => {
  const step = extractRequireDescendsStep();
  assert.match(step, /if: \$\{\{ !inputs\.dry-run && inputs\.require-descends-from-live \}\}/);
});

function extractLiveVersionIdScript() {
  const step = extractRequireDescendsStep();
  const anchor = 'node -e "\n';
  const start = step.indexOf(anchor);
  assert.ok(start >= 0, 'the live-version-id snippet must be present');
  const bodyStart = start + anchor.length;
  const end = step.indexOf('\n          " "$DEPLOYMENTS_JSON"', bodyStart);
  assert.ok(end >= 0, 'the live-version-id snippet must close with the expected node -e invocation');
  return step.slice(bodyStart, end).replace(/^ {12}/gm, '');
}

function extractLiveTagScript() {
  const step = extractRequireDescendsStep();
  const anchor = 'LIVE_TAG=$(node -e "\n';
  const start = step.indexOf(anchor);
  assert.ok(start >= 0, 'the live-tag snippet must be present');
  const bodyStart = start + anchor.length;
  const end = step.indexOf('\n          " "$VERSION_JSON")', bodyStart);
  assert.ok(end >= 0, 'the live-tag snippet must close with the expected node -e invocation');
  return step.slice(bodyStart, end).replace(/^ {12}/gm, '');
}

test('resolves the newest deployment\'s single-version id against the real fronts-staging shape', () => {
  const script = extractLiveVersionIdScript();
  const deploymentsJson = fixturePath('fronts-staging-deployments.json');
  const result = spawnSync(process.execPath, ['-e', script, '--', deploymentsJson.pathname, 'fronts-staging'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.trim(), '3bd93141-0fd0-4b4e-9db8-e57d548c6714');
});

test('refuses (non-zero) when the live deployment is a gradual/split version, rather than picking one', () => {
  const script = extractLiveVersionIdScript();
  const root = mkdtempSync(join(tmpdir(), 'require-descends-'));
  try {
    const path = join(root, 'deployments.json');
    writeFileSync(path, JSON.stringify({
      success: true,
      result: {
        deployments: [{
          created_on: '2026-09-24T00:00:00Z',
          versions: [{ version_id: 'v1', percentage: 50 }, { version_id: 'v2', percentage: 50 }],
        }],
      },
    }));
    const result = spawnSync(process.execPath, ['-e', script, '--', path, 'fronts-staging'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not a single 100% version/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolves the live workers/tag annotation from a version response', () => {
  const script = extractLiveTagScript();
  const root = mkdtempSync(join(tmpdir(), 'require-descends-'));
  try {
    const path = join(root, 'version.json');
    writeFileSync(path, JSON.stringify({
      success: true,
      result: { annotations: { 'workers/tag': 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' } },
    }));
    const result = spawnSync(process.execPath, ['-e', script, '--', path], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.trim(), 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function extractAncestryDecisionScript() {
  const step = extractRequireDescendsStep();
  const start = step.indexOf('if [ -z "$LIVE_TAG" ]; then');
  assert.ok(start >= 0, 'the ancestry-decision tail must be present');
  const end = step.indexOf('\n\n      - name: Deploy with provenance');
  return step.slice(start, start + (end >= 0 ? end - start : step.length - start));
}

function initAncestryTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'require-descends-repo-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(dir, 'a.txt'), 'one');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  const first = git('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'a.txt'), 'two');
  git('add', '.');
  git('commit', '-q', '-m', 'second');
  const second = git('rev-parse', 'HEAD');
  return { dir, first, second };
}

function runAncestryDecision(script, dir, liveTag, githubSha) {
  const summaryFile = join(dir, '.gh-summary');
  const outputFile = join(dir, '.gh-output');
  writeFileSync(summaryFile, '');
  writeFileSync(outputFile, '');
  const result = spawnSync('bash', ['-c', script], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, LIVE_TAG: liveTag, GITHUB_SHA: githubSha, GITHUB_STEP_SUMMARY: summaryFile, GITHUB_OUTPUT: outputFile },
  });
  const outputs = {};
  for (const line of readFileSync(outputFile, 'utf8').split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key) outputs[key] = rest.join('=');
  }
  return { ...result, summary: readFileSync(summaryFile, 'utf8'), outputs };
}

test('proceeds when the live tag is an ancestor of GITHUB_SHA (the ordinary forward-progress case)', () => {
  const script = extractAncestryDecisionScript();
  const { dir, first, second } = initAncestryTempRepo();
  try {
    const result = runAncestryDecision(script, dir, first, second);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.summary, /confirmed an ancestor/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('C2: stays GREEN (exit 0, warning, proceed=false) when GITHUB_SHA is OLDER than the live tag -- superseded-at-deploy-time is the CORRECT outcome of a race, not a failure', () => {
  const script = extractAncestryDecisionScript();
  const { dir, first, second } = initAncestryTempRepo();
  try {
    // live is `second` (newer, already deployed by a faster-racing trigger);
    // this run's own tip is `first` (older) -- must skip the deploy (never
    // deploy backwards over what already shipped), but the JOB stays green:
    // this is the race resolving as designed, not an error.
    const result = runAncestryDecision(script, dir, second, first);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /::warning::.*live tag .* is NEWER/);
    assert.match(result.summary, /superseded at deploy time/);
    assert.equal(result.outputs.proceed, 'false');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the "Deploy with provenance" step skips itself (never runs) when require-descends-from-live reports proceed=false', () => {
  const deployStep = workflow.slice(workflow.indexOf('      - name: Deploy with provenance'));
  assert.match(
    deployStep,
    /if: \$\{\{ !inputs\.dry-run && steps\.require-descends-from-live\.outputs\.proceed != 'false' \}\}/,
  );
});

test('"Post-deploy journeys" also skips when require-descends-from-live reports proceed=false -- it must not canary-test the newer version that already deployed under this run\'s SHA', () => {
  const journeysStart = workflow.indexOf('      - name: Post-deploy journeys');
  const journeysStep = workflow.slice(journeysStart, workflow.indexOf('\n\n', journeysStart));
  assert.match(
    journeysStep,
    /if: \$\{\{ !inputs\.dry-run && inputs\.journeys-audience != '' && steps\.require-descends-from-live\.outputs\.proceed != 'false' \}\}/,
  );
});

test('refuses loudly on diverged history (neither commit is an ancestor of the other)', () => {
  const script = extractAncestryDecisionScript();
  const { dir } = initAncestryTempRepo();
  try {
    const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('checkout', '-q', '-b', 'diverged', 'HEAD~1');
    writeFileSync(join(dir, 'b.txt'), 'diverged');
    git('add', '.');
    git('commit', '-q', '-m', 'diverged commit');
    const diverged = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
    const main = spawnSync('git', ['rev-parse', 'main'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
    const result = runAncestryDecision(script, dir, main, diverged);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /shares no ancestry/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('proceeds (with a warning, proceed=true) when the live tag is not a commit of this repository', () => {
  const script = extractAncestryDecisionScript();
  const { dir, second } = initAncestryTempRepo();
  try {
    const result = runAncestryDecision(script, dir, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', second);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /::warning::/);
    assert.equal(result.outputs.proceed, 'true');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('C1: proceeds (with a warning, proceed=true) on an EMPTY live tag, same as foreign -- a version deployed without --tag must not deadlock every future gated deploy', () => {
  const script = extractAncestryDecisionScript();
  const { dir, second } = initAncestryTempRepo();
  try {
    const result = runAncestryDecision(script, dir, '', second);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /::warning::.*no workers\/tag annotation/);
    assert.equal(result.outputs.proceed, 'true');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

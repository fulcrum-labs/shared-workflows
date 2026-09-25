import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Stands in for the real Cloudflare D1 list endpoint. Deliberately returns
// substring matches for `?name=` (like the real API does -- confirmed live:
// querying "fronts-data" also returns "fronts-data-staging" and
// "homefronts-data-staging") so a test that skipped the script's own
// exact-name filter would fail here, not just in production.
function startFixtureD1ListServer(databases) {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const nameQuery = url.searchParams.get('name') || '';
      const result = databases.filter((db) => db.name.includes(nameQuery));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result }));
    });
    server.listen(0, '127.0.0.1', () => resolvePromise(server));
  });
}

// apply-d1-migrations.mjs shells out to a real `wrangler` binary
// (WRANGLER_BIN). This stubs it with a fake that logs every invocation to
// FAKE_WRANGLER_LOG and returns the canned ledger a real `d1 execute --json
// --command "SELECT name FROM d1_migrations"` would, so the script's own
// diff/apply/dry-run logic runs for real against a fake D1, not a live one.
//
// It also records which database_id it was actually "targeting" for each
// call, to FAKE_WRANGLER_TARGETED_LOG: if `--config <path>` was passed, the
// id named THERE (proving the generated config -- not the consumer's own
// wrangler.toml -- decided the target); otherwise a crude sniff of a real
// wrangler.toml in the cwd, the same resolution a real wrangler binary
// would do without an explicit --config override.
const FAKE_WRANGLER = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_WRANGLER_LOG, JSON.stringify(args) + '\\n');
let targetedId = null;
const configIndex = args.indexOf('--config');
if (configIndex !== -1) {
  const config = JSON.parse(readFileSync(args[configIndex + 1], 'utf8'));
  targetedId = config.d1_databases?.[0]?.database_id ?? null;
} else if (existsSync('wrangler.toml')) {
  const text = readFileSync('wrangler.toml', 'utf8');
  const match = text.match(/database_id\\s*=\\s*"([^"]+)"/);
  targetedId = match ? match[1] : null;
}
if (process.env.FAKE_WRANGLER_TARGETED_LOG) {
  appendFileSync(process.env.FAKE_WRANGLER_TARGETED_LOG, (targetedId ?? '') + '\\n');
}
if (args.includes('--json')) {
  const applied = JSON.parse(process.env.FAKE_WRANGLER_APPLIED || '[]');
  process.stdout.write('some wrangler banner line\\n');
  process.stdout.write(JSON.stringify([{ results: applied.map((name) => ({ name })) }]));
}
process.exit(0);
`;

// Async spawn, not spawnSync: a couple of these tests run a fixture HTTP
// server IN THIS SAME PROCESS for the child to call. spawnSync blocks this
// process's entire event loop until the child exits, so it can never accept
// the child's connection to that server -- a real deadlock, caught by hand
// (the first run of these tests hung until killed) before it became a CI
// hang instead of a red test.
function runApply({ migrationFiles, appliedLedgerNames, dryRun, databaseId, cfApiBase, databaseName, wranglerTomlContent }) {
  const dir = mkdtempSync(join(tmpdir(), 'd1-apply-test-'));
  const migrationsDir = join(dir, 'migrations');
  mkdirSync(migrationsDir);
  for (const name of migrationFiles) {
    writeFileSync(join(migrationsDir, name), `-- ${name}\nSELECT 1;\n`);
  }
  if (wranglerTomlContent) {
    writeFileSync(join(dir, 'wrangler.toml'), wranglerTomlContent);
  }
  const wranglerPath = join(dir, 'fake-wrangler.mjs');
  writeFileSync(wranglerPath, FAKE_WRANGLER);
  chmodSync(wranglerPath, 0o755);
  const logPath = join(dir, 'wrangler-invocations.log');
  writeFileSync(logPath, '');
  const targetedIdsLogPath = join(dir, 'wrangler-targeted-ids.log');
  writeFileSync(targetedIdsLogPath, '');
  // A dedicated, test-owned RUNNER_TEMP -- separate from `dir` -- so a test
  // can inspect it AFTER the child exits to confirm the script's own
  // cleanup (not this harness's own teardown) removed the generated
  // wrangler-config directory. Left in place here; the caller is
  // responsible for removing it once done inspecting.
  const runnerTemp = mkdtempSync(join(tmpdir(), 'd1-runner-temp-'));

  return new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      [new URL('apply-d1-migrations.mjs', import.meta.url).pathname],
      {
        cwd: dir,
        env: {
          ...process.env,
          D1_DATABASE_NAME: databaseName || 'test-db',
          D1_MIGRATIONS_DIR: migrationsDir,
          CLOUDFLARE_ACCOUNT_ID: 'test-account',
          CLOUDFLARE_API_TOKEN: 'test-token',
          WRANGLER_BIN: wranglerPath,
          RUNNER_TEMP: runnerTemp,
          FAKE_WRANGLER_LOG: logPath,
          FAKE_WRANGLER_TARGETED_LOG: targetedIdsLogPath,
          FAKE_WRANGLER_APPLIED: JSON.stringify(appliedLedgerNames),
          ...(dryRun ? { D1_MIGRATIONS_DRY_RUN: '1' } : {}),
          ...(databaseId ? { D1_DATABASE_ID: databaseId } : {}),
          ...(cfApiBase ? { D1_MIGRATIONS_CF_API_BASE_FOR_TESTS_ONLY: cfApiBase } : {}),
        },
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => {
      const invocations = readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const targetedIds = readFileSync(targetedIdsLogPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean);
      rmSync(dir, { recursive: true, force: true });
      resolvePromise({ result: { status, stdout, stderr }, invocations, targetedIds, runnerTemp });
    });
  });
}

test('dry run lists pending migrations and exits 0 without applying or writing to the ledger', async () => {
  const { result, invocations } = await runApply({
    migrationFiles: ['0001_a.sql', '0002_b.sql'],
    appliedLedgerNames: ['0001_a.sql'],
    dryRun: true,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 pending: 0002_b\.sql/);
  assert.match(result.stdout, /dry run: not applying \(D1_MIGRATIONS_DRY_RUN=1\)/);

  // Exactly the ledger SELECT ran -- no --file apply, no INSERT.
  assert.equal(invocations.length, 1);
  assert.ok(invocations[0].includes('--json'));
  for (const call of invocations) {
    assert.ok(!call.includes('--file'), `dry run must never apply a migration file: ${JSON.stringify(call)}`);
    assert.ok(
      !call.some((arg) => typeof arg === 'string' && arg.includes('INSERT INTO d1_migrations')),
      `dry run must never write to the ledger: ${JSON.stringify(call)}`,
    );
  }
});

test('dry run with nothing pending still exits 0 and never applies', async () => {
  const { result, invocations } = await runApply({
    migrationFiles: ['0001_a.sql'],
    appliedLedgerNames: ['0001_a.sql'],
    dryRun: true,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nothing to apply/);
  assert.equal(invocations.length, 1, 'only the ledger SELECT, nothing after it');
});

test('without dry run, pending migrations are applied and recorded exactly as before', async () => {
  const { result, invocations } = await runApply({
    migrationFiles: ['0001_a.sql', '0002_b.sql'],
    appliedLedgerNames: ['0001_a.sql'],
    dryRun: false,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /applied 0002_b\.sql/);
  assert.match(result.stdout, /done; applied 1 migration\(s\)/);

  // SELECT, then --file apply, then the INSERT -- unchanged regression shape.
  assert.equal(invocations.length, 3);
  assert.ok(invocations[1].includes('--file'));
  assert.ok(
    invocations[2].some((arg) => typeof arg === 'string' && arg.includes('INSERT INTO d1_migrations')),
  );
});

test('without database-id, no lookup happens at all -- unchanged for every existing caller', async () => {
  const { result, invocations } = await runApply({
    migrationFiles: ['0001_a.sql'],
    appliedLedgerNames: ['0001_a.sql'],
    dryRun: true,
    // No databaseId, no cfApiBase override -- if verifyDatabaseId ran anyway
    // it would try to reach the real Cloudflare API and fail/hang in CI.
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(invocations.length, 1, 'only the ledger SELECT; the identity lookup must be skipped entirely');
});

test('a matching database-id verifies and proceeds, even in dry run', async () => {
  const server = await startFixtureD1ListServer([
    { name: 'fronts-data-staging', uuid: 'aaaaaaaa-0000-0000-0000-000000000001' },
    { name: 'fronts-data', uuid: 'bbbbbbbb-0000-0000-0000-000000000002' },
  ]);
  try {
    const { port } = server.address();
    const { result, invocations } = await runApply({
      migrationFiles: ['0001_a.sql', '0002_b.sql'],
      appliedLedgerNames: ['0001_a.sql'],
      dryRun: true,
      databaseName: 'fronts-data-staging',
      databaseId: 'aaaaaaaa-0000-0000-0000-000000000001',
      cfApiBase: `http://127.0.0.1:${port}`,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /verified "fronts-data-staging" resolves to the declared uuid aaaaaaaa-0000-0000-0000-000000000001/);
    assert.equal(invocations.length, 1, 'the ledger SELECT still ran after verification passed');
  } finally {
    server.close();
  }
});

test('a mismatched database-id refuses before any D1 interaction, including in dry run', async () => {
  const server = await startFixtureD1ListServer([
    { name: 'fronts-data-staging', uuid: 'aaaaaaaa-0000-0000-0000-000000000001' },
    { name: 'fronts-data', uuid: 'bbbbbbbb-0000-0000-0000-000000000002' },
  ]);
  try {
    const { port } = server.address();
    // A staging config block that accidentally carried prod's uuid --
    // exactly the mismatch reviewer-foundry flagged.
    const { result, invocations } = await runApply({
      migrationFiles: ['0001_a.sql'],
      appliedLedgerNames: [],
      dryRun: true,
      databaseName: 'fronts-data-staging',
      databaseId: 'bbbbbbbb-0000-0000-0000-000000000002',
      cfApiBase: `http://127.0.0.1:${port}`,
    });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /resolves to uuid aaaaaaaa-0000-0000-0000-000000000001, but the caller declared database-id bbbbbbbb-0000-0000-0000-000000000002/,
    );
    assert.equal(invocations.length, 0, 'the mismatch must be caught before even the ledger SELECT runs');
  } finally {
    server.close();
  }
});

test('database-id verification filters the list endpoint\'s own substring match down to an exact name', async () => {
  // The fixture server intentionally mimics the real API's substring
  // behaviour: querying "fronts-data" would also return
  // "fronts-data-staging" from a real account. Confirm the script's own
  // exact-name filter, not the server's, is what decides the match.
  const server = await startFixtureD1ListServer([
    { name: 'fronts-data-staging', uuid: 'aaaaaaaa-0000-0000-0000-000000000001' },
    { name: 'fronts-data', uuid: 'bbbbbbbb-0000-0000-0000-000000000002' },
  ]);
  try {
    const { port } = server.address();
    const { result, invocations } = await runApply({
      migrationFiles: ['0001_a.sql'],
      appliedLedgerNames: ['0001_a.sql'],
      dryRun: true,
      databaseName: 'fronts-data',
      databaseId: 'bbbbbbbb-0000-0000-0000-000000000002',
      cfApiBase: `http://127.0.0.1:${port}`,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /verified "fronts-data" resolves to the declared uuid bbbbbbbb-0000-0000-0000-000000000002/);
    assert.equal(invocations.length, 1);
  } finally {
    server.close();
  }
});

// reviewer-foundry MED on #58: the API-list check above proves the
// ACCOUNT has a database named X with uuid Y, but wrangler resolves the
// database-name argument through the CONSUMER REPO's own checked-out
// wrangler.toml first, using THAT entry's id -- never re-resolving
// against the live account. A consumer config mapping the staging name to
// PROD's uuid would pass verifyDatabaseId and still silently write prod.
test('a misconfigured consumer wrangler.toml (staging name mapped to prod\'s uuid) is overridden -- every wrangler call targets the verified id, never the file\'s', async () => {
  const server = await startFixtureD1ListServer([
    { name: 'fronts-data-staging', uuid: 'aaaaaaaa-0000-0000-0000-000000000001' },
    { name: 'fronts-data', uuid: 'bbbbbbbb-0000-0000-0000-000000000002' },
  ]);
  try {
    const { port } = server.address();
    // The fixture repo's OWN wrangler.toml wrongly maps the staging name to
    // PROD's uuid -- exactly the misconfiguration this fix defends against.
    const wranglerTomlContent = [
      '[[d1_databases]]',
      'binding = "DB"',
      'database_name = "fronts-data-staging"',
      'database_id = "bbbbbbbb-0000-0000-0000-000000000002"',
      '',
    ].join('\n');

    const { result, invocations, targetedIds } = await runApply({
      migrationFiles: ['0001_a.sql', '0002_b.sql'],
      appliedLedgerNames: ['0001_a.sql'],
      dryRun: false,
      databaseName: 'fronts-data-staging',
      databaseId: 'aaaaaaaa-0000-0000-0000-000000000001',
      cfApiBase: `http://127.0.0.1:${port}`,
      wranglerTomlContent,
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    // SELECT, --file apply, INSERT -- every single wrangler d1 call, not
    // just the first one, must have targeted the verified id.
    assert.equal(invocations.length, 3);
    assert.deepEqual(
      targetedIds,
      ['aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001'],
      'every wrangler call must target the API-verified uuid, never the misconfigured wrangler.toml\'s',
    );
    for (const call of invocations) {
      assert.ok(call.includes('--config'), `every wrangler call must carry --config once database-id is set: ${JSON.stringify(call)}`);
    }
  } finally {
    server.close();
  }
});

test('without database-id, wrangler resolves through the consumer\'s own wrangler.toml exactly as before this existed', async () => {
  const wranglerTomlContent = [
    '[[d1_databases]]',
    'binding = "DB"',
    'database_name = "fronts-data-staging"',
    'database_id = "cccccccc-0000-0000-0000-000000000003"',
    '',
  ].join('\n');

  const { result, invocations, targetedIds } = await runApply({
    migrationFiles: ['0001_a.sql'],
    appliedLedgerNames: ['0001_a.sql'],
    dryRun: true,
    databaseName: 'fronts-data-staging',
    wranglerTomlContent,
    // No databaseId, no cfApiBase -- must never touch the network, and
    // must never pass --config.
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(invocations.length, 1);
  assert.ok(!invocations[0].includes('--config'), 'no database-id means no generated config, exactly as before this existed');
  assert.deepEqual(targetedIds, ['cccccccc-0000-0000-0000-000000000003']);
});

// reviewer-foundry NIT on #58's approval: the generated wrangler-config
// directory was never removed. Self-hosted runners are persistent, not
// ephemeral containers, so a leftover mkdtempSync directory per run would
// accumulate forever with nothing else to clean it up.
test('the generated wrangler-config directory is removed after the process exits', async () => {
  const server = await startFixtureD1ListServer([
    { name: 'fronts-data-staging', uuid: 'aaaa-1111-verified-uuid' },
  ]);
  try {
    const { port } = server.address();
    const { result, runnerTemp } = await runApply({
      migrationFiles: ['0001_a.sql'],
      appliedLedgerNames: ['0001_a.sql'],
      dryRun: true,
      databaseName: 'fronts-data-staging',
      databaseId: 'aaaa-1111-verified-uuid',
      cfApiBase: `http://127.0.0.1:${port}`,
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    // RUNNER_TEMP itself must survive (the script never owns that
    // directory, only the one subdirectory it created inside it) --
    // empty of the generated config subdirectory, not deleted itself.
    assert.deepEqual(readdirSync(runnerTemp), []);
    rmSync(runnerTemp, { recursive: true, force: true });
  } finally {
    server.close();
  }
});

// Structural regression test for the #58 gap this PR fixes: apply-d1-
// migrations.mjs reading process.env.SOMETHING is worthless if
// d1-migrations-apply.yml's own env: block never maps SOMETHING from an
// input -- exactly what happened to D1_DATABASE_ID. Parses both files
// directly (not a mock, not the script's own runtime behaviour) so the
// same class of bug -- a new script-side input read with no workflow-side
// wiring -- fails THIS test the moment it's introduced, for any future
// input, not just this one.
test('every process.env.D1_* / CLOUDFLARE_* the script reads is mapped in the workflow\'s job-level env block', () => {
  const scriptPath = new URL('apply-d1-migrations.mjs', import.meta.url).pathname;
  const workflowPath = new URL('../workflows/d1-migrations-apply.yml', import.meta.url).pathname;
  const script = readFileSync(scriptPath, 'utf8');
  const workflow = readFileSync(workflowPath, 'utf8');

  // Not a workflow_call input, so exempt from "must be mapped in env: from
  // an input": D1_MIGRATIONS_CF_API_BASE_FOR_TESTS_ONLY is a test-only
  // escape hatch no real caller ever sets; RUNNER_TEMP is a GitHub Actions
  // runner-provided ambient var, never workflow-declared; WRANGLER_BIN is
  // written by the "Install wrangler" step via $GITHUB_ENV, not the job's
  // own env: block (a different, already-covered wiring path).
  const NOT_A_WORKFLOW_CALL_INPUT = new Set([
    'D1_MIGRATIONS_CF_API_BASE_FOR_TESTS_ONLY',
    'RUNNER_TEMP',
    'WRANGLER_BIN',
  ]);
  const readNames = new Set(
    [...script.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)]
      .map((m) => m[1])
      .filter((name) => !NOT_A_WORKFLOW_CALL_INPUT.has(name)),
  );
  assert.ok(readNames.size > 0, 'sanity: the script must read at least one env var, or this test is checking nothing');

  // The job-level `env:` block only -- between `env:` and the next
  // top-level-under-job key (`steps:`), so a step's own unrelated `env:`
  // (there are none today, but a future one must not be scanned here) can
  // never satisfy this check.
  const envBlockMatch = workflow.match(/\n {4}env:\n([\s\S]*?)\n {4}steps:/);
  assert.ok(envBlockMatch, 'could not find the jobs.apply.env: block in d1-migrations-apply.yml');
  const envBlock = envBlockMatch[1];
  const mappedNames = new Set([...envBlock.matchAll(/^ {6}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]));

  const unmapped = [...readNames].filter((name) => !mappedNames.has(name));
  assert.deepEqual(
    unmapped,
    [],
    `the script reads process.env.${unmapped[0]} but the workflow's env: block never maps it from an input -- exactly the #58 gap this test exists to catch`,
  );
});

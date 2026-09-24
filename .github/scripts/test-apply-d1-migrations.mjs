import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
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
const FAKE_WRANGLER = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_WRANGLER_LOG, JSON.stringify(args) + '\\n');
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
function runApply({ migrationFiles, appliedLedgerNames, dryRun, databaseId, cfApiBase, databaseName }) {
  const dir = mkdtempSync(join(tmpdir(), 'd1-apply-test-'));
  const migrationsDir = join(dir, 'migrations');
  mkdirSync(migrationsDir);
  for (const name of migrationFiles) {
    writeFileSync(join(migrationsDir, name), `-- ${name}\nSELECT 1;\n`);
  }
  const wranglerPath = join(dir, 'fake-wrangler.mjs');
  writeFileSync(wranglerPath, FAKE_WRANGLER);
  chmodSync(wranglerPath, 0o755);
  const logPath = join(dir, 'wrangler-invocations.log');
  writeFileSync(logPath, '');

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
          FAKE_WRANGLER_LOG: logPath,
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
      rmSync(dir, { recursive: true, force: true });
      resolvePromise({ result: { status, stdout, stderr }, invocations });
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

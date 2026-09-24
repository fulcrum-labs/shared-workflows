import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

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

function runApply({ migrationFiles, appliedLedgerNames, dryRun }) {
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

  const result = spawnSync(
    process.execPath,
    [new URL('apply-d1-migrations.mjs', import.meta.url).pathname],
    {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        D1_DATABASE_NAME: 'test-db',
        D1_MIGRATIONS_DIR: migrationsDir,
        CLOUDFLARE_ACCOUNT_ID: 'test-account',
        CLOUDFLARE_API_TOKEN: 'test-token',
        WRANGLER_BIN: wranglerPath,
        FAKE_WRANGLER_LOG: logPath,
        FAKE_WRANGLER_APPLIED: JSON.stringify(appliedLedgerNames),
        ...(dryRun ? { D1_MIGRATIONS_DRY_RUN: '1' } : {}),
      },
    },
  );

  const invocations = readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  rmSync(dir, { recursive: true, force: true });
  return { result, invocations };
}

test('dry run lists pending migrations and exits 0 without applying or writing to the ledger', () => {
  const { result, invocations } = runApply({
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

test('dry run with nothing pending still exits 0 and never applies', () => {
  const { result, invocations } = runApply({
    migrationFiles: ['0001_a.sql'],
    appliedLedgerNames: ['0001_a.sql'],
    dryRun: true,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nothing to apply/);
  assert.equal(invocations.length, 1, 'only the ledger SELECT, nothing after it');
});

test('without dry run, pending migrations are applied and recorded exactly as before', () => {
  const { result, invocations } = runApply({
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

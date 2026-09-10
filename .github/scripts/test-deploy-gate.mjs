import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../workflows/deploy-gate.yml', import.meta.url), 'utf8');

function extractHeredoc(step, marker) {
  const match = step.match(new RegExp(`node - <<'${marker}'\\n([\\s\\S]*?)\\n\\s*${marker}`));
  assert.ok(match, `${marker} heredoc must be embedded in the step`);
  return match[1].replace(/^ {10}/gm, '');
}

function runTripwire(script, files, ledgerNames) {
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
      env: { ...process.env, D1_LEDGER_JSON: ledgerPath },
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
  assert.match(step, /if: hashFiles\('.publication\/d1-migrations.json'\) != ''/);
  assert.match(step, /d1 execute "\$DB_NAME" --remote --json/);
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

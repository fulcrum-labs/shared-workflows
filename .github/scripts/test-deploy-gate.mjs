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

async function runJourneyGate({ env, pulls = [], checkRuns = [] }) {
  const { state, core } = stubCore();
  const github = {
    rest: {
      repos: { listPullRequestsAssociatedWithCommit: 'pulls' },
      checks: { listForRef: 'checks' },
    },
    async paginate(route) {
      return route === 'pulls' ? pulls : checkRuns;
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

test('the gate is inert unless the caller names a required journey check', () => {
  const gate = workflow.slice(workflow.indexOf('      - name: Preview journeys gate'));
  assert.match(gate, /^\s+if: inputs\.required-journey-check != ''$/m);
  assert.match(workflow, /^      required-journey-check:\n        type: string\n        default: ''$/m);
});

test('the deploy job holds the pull-requests and checks reads the gate needs', () => {
  const job = workflow.slice(workflow.indexOf('  deploy:'), workflow.indexOf('    steps:'));
  for (const scope of ['contents: read', 'pull-requests: read', 'checks: read']) {
    assert.ok(job.includes(scope), `deploy job permissions must include ${scope}`);
  }
});

test('a green journey run on the originating PR head lets the deploy proceed', async () => {
  const state = await runJourneyGate({
    env: GATE_ENV,
    pulls: [mergedPr],
    checkRuns: [{
      status: 'completed',
      conclusion: 'success',
      completed_at: '2026-09-14T19:50:00Z',
      html_url: 'https://github.com/fulcrum-labs/fronts/runs/1',
    }],
  });
  assert.equal(state.failed, null);
  assert.equal(state.errors.length, 0);
});

test('a failed journey run refuses the deploy and names the run', async () => {
  const state = await runJourneyGate({
    env: GATE_ENV,
    pulls: [mergedPr],
    checkRuns: [{
      status: 'completed',
      conclusion: 'failure',
      completed_at: '2026-09-14T19:50:00Z',
      html_url: 'https://github.com/fulcrum-labs/fronts/runs/1',
      output: { title: 'member-video failed', summary: 'playback never started' },
    }],
  });
  assert.ok(state.failed, 'a failed journey must fail the deploy');
  assert.match(state.errors.join('\n'), /concluded \*\*failure\*\*/);
  assert.match(state.errors.join('\n'), /runs\/1/);
});

test('the newest completed journey run decides, not the first one listed', async () => {
  const state = await runJourneyGate({
    env: GATE_ENV,
    pulls: [mergedPr],
    checkRuns: [
      { status: 'completed', conclusion: 'success', completed_at: '2026-09-14T18:00:00Z', html_url: 'https://x/1' },
      { status: 'completed', conclusion: 'failure', completed_at: '2026-09-14T19:00:00Z', html_url: 'https://x/2' },
    ],
  });
  assert.ok(state.failed, 'the latest run failed, so the deploy must refuse');
});

test('journeys that never completed refuse the deploy rather than letting it outrun the gate', async () => {
  const state = await runJourneyGate({
    env: GATE_ENV,
    pulls: [mergedPr],
    checkRuns: [{ status: 'in_progress', conclusion: null }],
  });
  assert.ok(state.failed);
  assert.match(state.errors.join('\n'), /no completed run/);
});

test('a commit with no merged pull request cannot deploy a member-facing site', async () => {
  const state = await runJourneyGate({ env: GATE_ENV, pulls: [], checkRuns: [] });
  assert.ok(state.failed);
  assert.match(state.errors.join('\n'), /No merged pull request/);
});

test('an unmerged associated pull request does not satisfy the gate', async () => {
  const state = await runJourneyGate({
    env: GATE_ENV,
    pulls: [{ number: 7, merged_at: null, head: { sha: 'c'.repeat(40) } }],
    checkRuns: [{ status: 'completed', conclusion: 'success', completed_at: '2026-09-14T19:00:00Z' }],
  });
  assert.ok(state.failed);
  assert.match(state.errors.join('\n'), /No merged pull request/);
});

test('an override reason bypasses the gate loudly and never silently', async () => {
  const state = await runJourneyGate({
    env: { ...GATE_ENV, OVERRIDE_REASON: 'incident 2026-09-14: revert the 500' },
    pulls: [],
    checkRuns: [],
  });
  assert.equal(state.failed, null, 'an explicit override must let the deploy through');
  assert.match(state.warnings.join('\n'), /overridden: incident 2026-09-14/);
  assert.match(state.summary.join('\n'), /BYPASSED/);
});

test('the override input exists only for callers to wire from workflow_dispatch', () => {
  assert.match(workflow, /^      journeys-override-reason:\n        type: string\n        default: ''$/m);
  assert.match(workflow, /never from the push\/workflow_run path/);
});

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../workflows/worker-rollback.yml', import.meta.url), 'utf8');

// Same "extract the real inline script and execute it" discipline as
// test-deploy-gate.mjs's dry-run coverage (deploy-gate.yml's ASI/TDZ bug --
// growth-labs/publishing run 35916382952 -- was found in a sibling of these
// exact scripts). worker-rollback.yml's node -e/-p blocks have no equivalent
// hazard (none starts a statement with `(`, `[`, a template literal, or a
// regex right after an unsemicoloned line), but they were entirely
// unexecuted by any test before now, so a future edit gets no regression
// coverage without this.
function extractNodeScript(step, anchor) {
  const start = step.indexOf(anchor);
  assert.ok(start >= 0, `script anchored on ${JSON.stringify(anchor)} must be embedded in the step`);
  const bodyStart = start + anchor.length;
  const end = step.indexOf('\n          "', bodyStart);
  assert.ok(end >= 0, 'the node script must close with a bare quote');
  return step.slice(bodyStart, end).replace(/^ {12}/gm, '');
}

const beforeStep = workflow.slice(workflow.indexOf('      - name: Before'), workflow.indexOf('      - name: Roll back'));
const afterStep = workflow.slice(workflow.indexOf('      - name: After'));

function fixturePath(name) {
  return new URL(`fixtures/${name}`, import.meta.url).pathname;
}

function runNodeScript(script, runnerTemp, env = {}) {
  const substituted = script.replace(/\$RUNNER_TEMP/g, runnerTemp);
  return spawnSync(process.execPath, ['-e', substituted], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function runNodeExpression(script, runnerTemp, env = {}) {
  const substituted = script.replace(/\$RUNNER_TEMP/g, runnerTemp);
  return spawnSync(process.execPath, ['-p', substituted], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('the Before step resolves the active deployment from the real fronts-staging deployments shape', () => {
  const script = extractNodeScript(beforeStep, 'node -e "\n');
  const root = mkdtempSync(join(tmpdir(), 'rollback-before-'));
  try {
    writeFileSync(
      join(root, 'rollback-deployments-before.json'),
      readFileSync(fixturePath('fronts-staging-deployments.json')),
    );
    const result = runNodeScript(script, root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const active = JSON.parse(readFileSync(join(root, 'rollback-active-before.json'), 'utf8'));
    // The staging fixture's newest deployment by created_on.
    assert.equal(active.id, '23b43bdb-331f-43fb-ac50-8a1fa64280fa');
    assert.equal(active.versions[0].version_id, '3bd93141-0fd0-4b4e-9db8-e57d548c6714');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the After step resolves the active deployment the same way, against the same real shape', () => {
  const script = extractNodeScript(afterStep, 'node -e "\n');
  const root = mkdtempSync(join(tmpdir(), 'rollback-after-'));
  try {
    writeFileSync(
      join(root, 'rollback-deployments-after.json'),
      readFileSync(fixturePath('fronts-staging-deployments.json')),
    );
    const result = runNodeScript(script, root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const active = JSON.parse(readFileSync(join(root, 'rollback-active-after.json'), 'utf8'));
    assert.equal(active.versions[0].version_id, '3bd93141-0fd0-4b4e-9db8-e57d548c6714');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the already_active check reports true only when the requested version is the sole 100% version', () => {
  const script = extractNodeScript(beforeStep, 'already_active="$(node -p "\n');
  const root = mkdtempSync(join(tmpdir(), 'rollback-already-active-'));
  try {
    writeFileSync(
      join(root, 'rollback-active-before.json'),
      JSON.stringify({ versions: [{ version_id: 'v-current', percentage: 100 }] }),
    );
    const matching = runNodeExpression(script, root, { VERSION_ID: 'v-current' });
    assert.equal(matching.status, 0, matching.stdout + matching.stderr);
    assert.equal(matching.stdout.trim(), 'true');

    const different = runNodeExpression(script, root, { VERSION_ID: 'v-other' });
    assert.equal(different.status, 0, different.stdout + different.stderr);
    assert.equal(different.stdout.trim(), 'false');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the post-rollback ok check reports true only once the target version converges to a single 100% version', () => {
  const script = extractNodeScript(afterStep, 'ok="$(node -p "\n');
  const root = mkdtempSync(join(tmpdir(), 'rollback-ok-'));
  try {
    writeFileSync(
      join(root, 'rollback-active-after.json'),
      JSON.stringify({ versions: [{ version_id: 'v-target', percentage: 100 }] }),
    );
    const converged = runNodeExpression(script, root, { VERSION_ID: 'v-target' });
    assert.equal(converged.status, 0, converged.stdout + converged.stderr);
    assert.equal(converged.stdout.trim(), 'true');

    writeFileSync(
      join(root, 'rollback-active-after.json'),
      JSON.stringify({ versions: [{ version_id: 'v-target', percentage: 50 }, { version_id: 'v-other', percentage: 50 }] }),
    );
    const gradual = runNodeExpression(script, root, { VERSION_ID: 'v-target' });
    assert.equal(gradual.status, 0, gradual.stdout + gradual.stderr);
    assert.equal(gradual.stdout.trim(), 'false');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

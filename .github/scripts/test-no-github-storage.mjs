import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const workflowsDir = fileURLToPath(new URL('../workflows/', import.meta.url));

// Every workflow file under .github/workflows/ -- mirrors allWorkflows() in
// test-self-hosted-runners.mjs (kept separate here since this guard is a
// standalone contract: nothing is stored on GitHub, per operator ruling
// 2026-09-27. The Actions artifact-storage quota is exhausted org-wide and
// will not be raised; every upload-artifact/cache write fails outright).
function allWorkflows(dir = workflowsDir) {
  return readdirSync(dir)
    .filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .map(name => [name, readFileSync(join(dir, name), 'utf8')]);
}

// Slices the source into step blocks, one per "- uses:" or "- name:" list
// item at the conventional 6-space step indentation used throughout this
// repo's workflows. A job-level "uses:" (a job that calls another reusable
// workflow) is indented at 4 spaces and never matches this split, so it is
// out of scope here -- only steps are.
function stepBlocks(source) {
  const marker = '\n      - ';
  const bodies = source.split(marker);
  // The first slice is whatever precedes the first step (job header, etc).
  return bodies.slice(1).map(body => `      - ${body}`);
}

function stepAction(step) {
  const match = step.match(/uses:\s*(\S+)/);
  return match ? match[1] : null;
}

const FORBIDDEN_ACTIONS = [
  { pattern: /^actions\/upload-artifact\b/, label: 'actions/upload-artifact' },
  { pattern: /^actions\/download-artifact\b/, label: 'actions/download-artifact' },
  { pattern: /^actions\/cache(\/|@|$)/, label: 'actions/cache' },
  { pattern: /^github\/codeql-action\/upload-sarif\b/, label: 'github/codeql-action/upload-sarif' },
];

test('no workflow uploads or downloads a GitHub Actions artifact, uploads a SARIF file, or uses actions/cache', () => {
  for (const [file, source] of allWorkflows()) {
    for (const step of stepBlocks(source)) {
      const action = stepAction(step);
      if (!action) continue;
      for (const { pattern, label } of FORBIDDEN_ACTIONS) {
        assert.doesNotMatch(
          action,
          pattern,
          `${file} uses ${label} (found "${action}") -- nothing is stored on GitHub ` +
            '(operator ruling 2026-09-27); the Actions artifact-storage quota is exhausted ' +
            'and every upload fails outright.',
        );
      }
    }
  }
});

test('no setup-* action restores a package manager or toolchain cache from GitHub Actions', () => {
  for (const [file, source] of allWorkflows()) {
    for (const step of stepBlocks(source)) {
      const action = stepAction(step);
      if (!action || !/^actions\/setup-/.test(action)) continue;
      const cacheMatch = step.match(/^\s*cache:\s*(.+)$/m);
      if (!cacheMatch) continue;
      const value = cacheMatch[1].trim().replace(/^['"]|['"]$/g, '');
      assert.equal(
        value,
        'false',
        `${file} has ${action} with cache: ${cacheMatch[1].trim()} -- setup-* caching must stay off ` +
          '(nothing is stored on GitHub, operator ruling 2026-09-27); self-hosted runners keep their own local store instead.',
      );
    }
  }
});

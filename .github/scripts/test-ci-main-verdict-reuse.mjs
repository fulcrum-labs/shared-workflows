import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// A push to main whose tree is the tree its merged pull request's Ready run executed and passed reuses that verdict:
// route's main-verdict step decides, quality names the run and skips its build and test steps, the scans still run.
const workflow = readFileSync(new URL('../workflows/ci-gate.yml', import.meta.url), 'utf8');
const heredoc = name => {
  const found = workflow.match(new RegExp(`          python3 - <<'${name}'\\n([\\s\\S]+?)          ${name}\\n`));
  assert.ok(found, `exercise the exact Python shipped in the reusable workflow (${name})`);
  return found[1].split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
};
const verdictSource = heredoc('MAIN_VERDICT');
const reusedSource = heredoc('MAIN_REUSED');
const priorSource = heredoc('PRIOR_VERDICT');

const repository = 'fulcrum-labs/fixture';
const root = `/repos/${repository}`;
const MAIN = 'c'.repeat(40);
const HEAD = 'a'.repeat(40);
const TREE = 'd'.repeat(40);
const WORK = 'CI gate (typecheck + lint + test + build)';

function prRun(id, { draft = false, status = 'success', number = 42, started = '2026-11-10T10:00:00Z', ...over } = {}) {
  return {
    id, index_in_repo: id - 100, workflow_id: 'ci.yml', commit_sha: HEAD, repository: { full_name: repository },
    trigger_event: 'pull_request', is_fork_pull_request: false, need_approval: false, status, started,
    event_payload: JSON.stringify({ action: 'synchronize', pull_request: { number, draft,
      head: { sha: HEAD, repo: { full_name: repository } }, base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: repository } } } }),
    ...over,
  };
}

// work: the quality job's CI gate step status ('success' executed, 'skipped' reused an earlier verdict).
function jobsFor(run, work = 'success', quality = {}) {
  const job = { id: run * 10 + 1, run_id: run, name: 'quality', status: 'success', task_id: run * 10 + 1, attempt: 1, ...quality };
  const scan = { id: run * 10 + 2, run_id: run, name: 'gitleaks', status: 'success', task_id: run * 10 + 2, attempt: 1 };
  const steps = [{ number: 0, name: 'Draft runs are never green', status: 'skipped' }, { number: 1, name: WORK, status: work }];
  return { jobs: [job, scan], details: { [job.id]: { ...job, steps } } };
}

function fixture(history = [prRun(150)], work = { 150: 'success' }) {
  const data = {
    current: { id: 200, trigger_event: 'push', commit_sha: MAIN, workflow_id: 'ci.yml', repository: { full_name: repository },
      event_payload: JSON.stringify({ ref: 'refs/heads/main', before: 'b'.repeat(40), after: MAIN }) },
    pull: { number: 42, merged: true, merge_commit_sha: MAIN, head: { sha: HEAD, repo: { full_name: repository } },
      base: { ref: 'main', repo: { full_name: repository } } },
    trees: { [MAIN]: TREE, [HEAD]: TREE }, history, jobs: {}, details: {},
  };
  for (const run of history) {
    const made = jobsFor(run.id, work[run.id] ?? 'success');
    data.jobs[run.id] = made.jobs;
    Object.assign(data.details, made.details);
  }
  return data;
}

function evaluate(data) {
  const result = spawnSync('python3', ['-I', '-c', `
import json, sys, urllib.parse
data = json.load(sys.stdin)
namespace = {"__name__": "fixture"}
exec(compile(data.pop("source"), "ci-gate.yml", "exec"), namespace)
reads = []
root = "/repos/fulcrum-labs/fixture"
def read(path):
    reads.append(path)
    url = urllib.parse.urlsplit(path)
    query = urllib.parse.parse_qs(url.query)
    page = int(query.get("page", [1])[0])
    start = (page - 1) * 50
    if url.path == root + "/actions/runs/200":
        return data["current"]
    if url.path == root + "/commits/" + data["current"]["commit_sha"] + "/pull":
        return data["pull"]
    if url.path.startswith(root + "/git/commits/"):
        sha = url.path.rsplit("/", 1)[1]
        return {"sha": sha, "commit": {"tree": {"sha": data["trees"][sha]}}}
    if url.path == root + "/actions/runs":
        assert query["head_sha"] == ["a" * 40] and query["workflow_id"] == ["ci.yml"], query
        return {"workflow_runs": data["history"][start:start + 50], "total_count": data.get("total", len(data["history"]))}
    if url.path.startswith(root + "/actions/runs/") and url.path.endswith("/jobs"):
        return data["jobs"][url.path.split("/")[-2]][start:start + 50]
    if url.path.startswith(root + "/actions/jobs/"):
        return data["details"][url.path.rsplit("/", 1)[1]]
    raise AssertionError("unexpected read " + path)
try:
    record = namespace["verdict"](read, "fulcrum-labs/fixture", 200, data["current"]["commit_sha"])
    print(json.dumps({"record": record, "reads": reads, "reason": None if record else (namespace["REFUSED"] or [None])[-1]}))
except Exception as error:
    reason = str(error) if isinstance(error, namespace["Refusal"]) else None
    print(json.dumps({"record": None, "error": type(error).__name__, "reason": reason, "reads": reads}))
`], { input: JSON.stringify({ source: verdictSource, ...JSON.parse(JSON.stringify(data)) }), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const named = (runId = 150) => ({
  schema: 'ci-gate.reused.v1', repository, candidateCommit: MAIN, candidateTree: TREE, pullRequest: 42, head: HEAD,
  runId, runIndex: runId - 100,
});

test('a main push at the tree its merged pull request executed names that run', () => {
  const result = evaluate(fixture());
  assert.deepEqual(result.record, named(), JSON.stringify(result));
  assert.ok(result.reads.includes(`${root}/git/commits/${MAIN}`) && result.reads.includes(`${root}/git/commits/${HEAD}`), 'both trees are read');
  assert.ok(result.reads.includes(`${root}/actions/jobs/1501`), 'the quality job steps are read');
});

test('a Ready run that reused an earlier verdict defers to the executed run before it', () => {
  assert.deepEqual(evaluate(fixture([prRun(160), prRun(150)], { 160: 'skipped', 150: 'success' })).record, named(150));
  // Drafts, a run queued behind the merge and another pull request's run at the same head are no evidence.
  const quiet = [prRun(180, { draft: true, status: 'failure' }), prRun(175, { status: 'waiting', started: '1970-01-01T00:00:00Z' }),
    prRun(170, { number: 43, status: 'failure' }), prRun(150)];
  assert.deepEqual(evaluate(fixture(quiet)).record, named(150));
});

test('the newest Ready verdict decides: a failed, cancelled or running one, or none executed, is no reuse', () => {
  for (const status of ['failure', 'cancelled', 'running', 'waiting']) {
    const result = evaluate(fixture([prRun(160, { status }), prRun(150)]));
    assert.equal(result.record, null, status);
    assert.equal(result.error, undefined, status);
  }
  assert.equal(evaluate(fixture([prRun(160)], { 160: 'skipped' })).record, null, 'only a reused verdict');
  assert.equal(evaluate(fixture([])).record, null, 'no pull request run at the head');
});

test('another tree is no reuse, and the run history is not read', () => {
  const data = fixture();
  data.trees[HEAD] = 'e'.repeat(40);
  const result = evaluate(data);
  assert.equal(result.record, null);
  assert.ok(!result.reads.some(path => path.includes('/actions/runs?')));
});

test('only a push of a merged same-repository pull request to main is considered', () => {
  const edits = [
    d => { d.current.trigger_event = 'pull_request'; },
    d => { d.current.commit_sha = 'f'.repeat(40); d.pull.merge_commit_sha = 'f'.repeat(40); d.current.event_payload = JSON.stringify({ ref: 'refs/heads/main', after: MAIN }); },
    d => { d.current.event_payload = JSON.stringify({ ref: 'refs/heads/other', after: MAIN }); },
    d => { d.current.event_payload = JSON.stringify({ ref: 'refs/heads/main', after: 'f'.repeat(40) }); },
    d => { d.current.event_payload = JSON.stringify({ ref: 'refs/heads/main', after: MAIN, pull_request: { number: 42 } }); },
    d => { d.current.workflow_id = ''; },
    d => { d.pull.merged = false; },
    d => { d.pull.merge_commit_sha = 'f'.repeat(40); },
    d => { d.pull.base.ref = 'release'; },
    d => { d.pull.head.repo.full_name = 'someone/fork'; },
    d => { d.pull.base.repo.full_name = 'someone/fork'; },
    d => { d.pull.number = 0; },
  ];
  for (const [i, edit] of edits.entries()) {
    const data = fixture();
    edit(data);
    assert.equal(evaluate(data).record, null, `edit ${i}`);
  }
});

test('a forked, unapproved or mismatched pull request run, or unreadable job evidence, refuses', () => {
  const runs = [
    prRun(150, { is_fork_pull_request: true }), prRun(150, { need_approval: true }), prRun(150, { commit_sha: 'f'.repeat(40) }),
    prRun(150, { workflow_id: 'other.yml' }), prRun(150, { repository: { full_name: 'someone/fork' } }), prRun(150, { index_in_repo: 0 }),
  ];
  for (const run of runs) {
    const result = evaluate(fixture([run]));
    assert.equal(result.record, null, JSON.stringify(run).slice(0, 120));
    assert.ok(result.error, 'refused, not merely passed over');
  }
  const jobEdits = [
    d => { d.jobs[150] = d.jobs[150].filter(job => job.name !== 'quality'); },
    d => { d.jobs[150].push({ ...d.jobs[150][0], id: 9999 }); },
    d => { d.jobs[150][0].status = 'skipped'; d.jobs[150][0].task_id = 0; },
    d => { d.jobs[150][0].status = 'failure'; },
    d => { d.jobs[150][0].run_id = 151; },
    d => { d.details[1501].status = 'failure'; },
    d => { d.details[1501].steps = d.details[1501].steps.filter(step => step.name !== 'CI gate (typecheck + lint + test + build)'); },
    d => { d.details[1501].steps[1].status = 'failure'; },
    d => { d.details[1501].steps[1].status = 'cancelled'; },
    d => { d.total = 2; },
  ];
  for (const [i, edit] of jobEdits.entries()) {
    const data = fixture();
    edit(data);
    const result = evaluate(data);
    assert.equal(result.record, null, `job edit ${i}`);
    assert.ok(result.error, `job edit ${i} refused`);
  }
});

function runMain(env, record = undefined) {
  const folder = mkdtempSync(join(tmpdir(), 'ci-main-verdict-'));
  try {
    const result = spawnSync('python3', ['-I', '-c', `
import json, os, sys
namespace = {"__name__": "fixture"}
exec(compile(json.load(sys.stdin), "ci-gate.yml", "exec"), namespace)
import io, urllib.error
seen = []
http = json.loads(os.environ.pop("FIXTURE_HTTP", "null"))
class Recorder:
    def open(self, request, **kwargs):
        seen.append(request.full_url)
        if http:
            raise urllib.error.HTTPError(request.full_url + "?token=leak", http["code"], "secret reason text",
                                         {"X-Leak": "header-value"}, io.BytesIO(http["body"].encode()))
        raise PermissionError("fixture refusal")
namespace["urllib"].request.build_opener = lambda *args: Recorder()
record = json.loads(os.environ.pop("FIXTURE_RECORD", "null"))
if record is not None:
    namespace["verdict"] = lambda read, repository, run_id, sha: record
refused = os.environ.pop("FIXTURE_REFUSE", "")
if refused:
    namespace["verdict"] = lambda read, repository, run_id, sha: namespace["refuse"](refused)
raised = os.environ.pop("FIXTURE_RAISE", "")
if raised:
    def boom(read, repository, run_id, sha):
        kind, _, text = raised.partition(":")
        if kind == "KeyError":
            raise KeyError(text)
        json.loads(text)
    namespace["verdict"] = boom
namespace["main"]()
print(json.dumps(seen))
`], { input: JSON.stringify(verdictSource), encoding: 'utf8', timeout: 10000, env: {
      PATH: process.env.PATH, ENABLED: 'true', MAIN_REUSE: 'true', VERDICT_API: 'https://forge.example/api/v1', VERDICT_REPOSITORY: repository,
      VERDICT_RUN_ID: '200', VERDICT_TOKEN: 'fixture-only', VERDICT_SHA: MAIN, VERDICT_REF: 'refs/heads/main', VERDICT_PR: '',
      VERDICT_BEFORE: 'b'.repeat(40), SCAN_RUNNER: '["fulcrum-light"]', GITHUB_OUTPUT: join(folder, 'out'),
      ...(record === undefined ? {} : { FIXTURE_RECORD: JSON.stringify(record) }), ...env,
    } });
    assert.equal(result.status, 0, result.stderr);
    const output = Object.fromEntries(readFileSync(join(folder, 'out'), 'utf8').trim().split('\n').map(l => l.split(/=(.*)/s).slice(0, 2)));
    const printed = result.stdout.trim().split('\n');
    return { output, requests: JSON.parse(printed.pop()), printed };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

test('main() reads nothing for a pull request, a disabled gate or lever, another ref or a run with no push payload', () => {
  for (const env of [{ ENABLED: 'false' }, { MAIN_REUSE: 'false' }, { MAIN_REUSE: '' }, { VERDICT_PR: '7' }, { VERDICT_REF: 'refs/heads/other' }, { VERDICT_BEFORE: '' }, { VERDICT_SHA: 'main' }]) {
    const { output, requests } = runMain(env);
    assert.deepEqual(output, { reuse: 'false' }, JSON.stringify(env));
    assert.deepEqual(requests, [], JSON.stringify(env));
  }
  const refused = runMain({});
  assert.deepEqual(refused.output, { reuse: 'false' }, 'an unreadable forge runs the full gate');
  assert.deepEqual(refused.requests, [`https://forge.example/api/v1${root}/actions/runs/200`]);
  assert.deepEqual(runMain({ VERDICT_API: 'http://forge.example/api/v1' }).requests, [], 'only https');
});

test('main() writes the provenance and sends quality to the scan lane only on a reuse', () => {
  const { output } = runMain({}, named());
  assert.equal(output.reuse, 'true');
  assert.deepEqual(JSON.parse(output.provenance), named());
  assert.equal(output['quality-runner'], '["fulcrum-light"]');
  for (const lane of ['', 'fulcrum-light', '[]', '[""]', '[1]', '{"a":1}']) {
    const other = runMain({ SCAN_RUNNER: lane }, named()).output;
    assert.equal(other.reuse, 'true', lane);
    assert.equal(other['quality-runner'], undefined, `no lane from ${JSON.stringify(lane)}`);
  }
});

function runNamed(provenance, env = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'ci-main-reused-'));
  try {
    const result = spawnSync('python3', ['-I', '-c', reusedSource], { encoding: 'utf8', env: {
      PATH: process.env.PATH, PROVENANCE: provenance, SHA: MAIN, REPOSITORY: repository, GITHUB_OUTPUT: join(folder, 'out'), ...env } });
    let output = '';
    try { output = readFileSync(join(folder, 'out'), 'utf8'); } catch { /* not written */ }
    return { ...result, output };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

test('quality names the reused run in one exact line, and refuses a provenance it cannot read exactly', () => {
  const good = runNamed(JSON.stringify(named()));
  assert.equal(good.status, 0, good.stderr);
  assert.equal(good.stdout.trim(), `CI_GATE_REUSED_V1 ${JSON.stringify(Object.fromEntries(Object.entries(named()).sort(([a], [b]) => a.localeCompare(b))))}`);
  assert.equal(good.output, 'reuse=true\n');
  const bad = [
    '', 'not json', '[]', JSON.stringify({ ...named(), extra: 1 }), JSON.stringify({ ...named(), schema: 'other' }),
    JSON.stringify({ ...named(), candidateCommit: HEAD }), JSON.stringify({ ...named(), repository: 'someone/fork' }),
    JSON.stringify({ ...named(), runId: '150' }), JSON.stringify({ ...named(), pullRequest: 0 }), JSON.stringify({ ...named(), runIndex: true }),
    JSON.stringify({ ...named(), candidateTree: 'D'.repeat(40) }), JSON.stringify({ ...named(), head: 'main' }),
  ];
  for (const provenance of bad) {
    const result = runNamed(provenance);
    assert.equal(result.status, 1, provenance);
    assert.match(result.stderr, /without exact provenance; this main run is not green/);
    assert.equal(result.output, '', 'reuse is never written');
    assert.doesNotMatch(result.stdout, /CI_GATE_REUSED_V1/);
  }
});

test('the anchored prior-verdict step passes quality\'s main verdict through without reading', () => {
  const folder = mkdtempSync(join(tmpdir(), 'ci-prior-main-'));
  try {
    const run = env => spawnSync('python3', ['-I', '-c', `
import json, sys
namespace = {"__name__": "fixture"}
exec(compile(json.load(sys.stdin), "ci-gate.yml", "exec"), namespace)
seen = []
class Recorder:
    def open(self, request, **kwargs):
        seen.append(request.full_url)
        raise PermissionError("fixture refusal")
namespace["urllib"].request.build_opener = lambda *args: Recorder()
namespace["main"]()
print(json.dumps(seen))
`], { input: JSON.stringify(priorSource), encoding: 'utf8', timeout: 10000, env: {
      PATH: process.env.PATH, VERDICT_API: 'https://forge.example/api/v1', VERDICT_REPOSITORY: repository, VERDICT_RUN_ID: '200',
      VERDICT_TOKEN: 'fixture-only', GITHUB_OUTPUT: join(folder, `out-${env.VERDICT_MAIN_REUSED || 'none'}`), ...env } });
    const reused = run({ VERDICT_MAIN_REUSED: 'true' });
    assert.equal(reused.status, 0, reused.stderr);
    assert.deepEqual(JSON.parse(reused.stdout.trim().split('\n').pop()), []);
    assert.equal(readFileSync(join(folder, 'out-true'), 'utf8'), 'reuse=true\n');
    const scans = run({ VERDICT_MAIN_REUSED: '' });
    assert.equal(scans.status, 0, scans.stderr);
    assert.equal(readFileSync(join(folder, 'out-none'), 'utf8'), 'reuse=false\n', 'without a main verdict the normal path decides');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('route decides, quality alone names the run, and the scans and docs-lint never take the main verdict', () => {
  const job = name => {
    const start = workflow.indexOf(`\n  ${name}:\n`);
    const next = workflow.slice(start + 1).search(/\n  [a-z][a-z0-9-]*:\n/);
    return workflow.slice(start, next < 0 ? undefined : start + 1 + next);
  };
  const route = job('route');
  for (const line of [
    '      quality-runner: ${{ steps.main-verdict.outputs.quality-runner }}',
    '      main-reused: ${{ steps.main-verdict.outputs.reuse }}',
    '      main-provenance: ${{ steps.main-verdict.outputs.provenance }}',
    '          SCAN_RUNNER: ${{ steps.route.outputs.scan-runner }}',
    '          MAIN_REUSE: ${{ inputs.main-verdict-reuse }}',
    '          VERDICT_PR: ${{ github.event.pull_request.number }}',
    '          VERDICT_BEFORE: ${{ github.event.before }}',
  ]) assert.ok(route.split('\n').includes(line), line);
  const step = route.slice(route.indexOf("      - name: Reuse the merged pull request's executed verdict at an identical tree\n"));
  assert.match(step, /^        id: main-verdict\n        continue-on-error: true\n        timeout-minutes: 1\n/m, 'a failed decision runs the full gate');
  assert.doesNotMatch(route, /secrets\./);

  const quality = job('quality');
  const steps = quality.slice(quality.indexOf('    steps:\n')).split(/^      - /m).slice(1).map(s => s.split('\n')[0]);
  assert.deepEqual(steps.slice(0, 3), ['name: Draft runs are never green', 'name: Name the merged pull request run this main push reused', '&prior-verdict']);
  assert.match(quality, /        id: main-verdict\n        if: \$\{\{ needs\.route\.outputs\.main-reused == 'true' \}\}\n/);
  assert.ok(quality.split('\n').includes('          VERDICT_MAIN_REUSED: ${{ steps.main-verdict.outputs.reuse }}'), 'the anchor reads quality\'s main verdict');
  for (const name of ['docs-lint', 'gitleaks', 'semgrep', 'grype']) {
    const other = job(name);
    assert.match(other, /^      - \*prior-verdict$/m, `${name} shares the anchored step`);
    assert.doesNotMatch(other, /id: main-verdict|main-reused|main-provenance|quality-runner/, `${name} has no main verdict of its own`);
  }
  assert.equal([...workflow.matchAll(/^        id: main-verdict$/gm)].length, 2, 'route decides, quality names');
});

test('main-verdict-reuse is an input, on by default, so one repository can keep every main push on the full gate', () => {
  assert.match(workflow, /^      main-verdict-reuse:\n        type: boolean\n        default: true\n/m);
  // A lever set false reads nothing and leaves quality on its own runner with every step.
  const { output, requests } = runMain({ MAIN_REUSE: 'false' }, named());
  assert.deepEqual(output, { reuse: 'false' });
  assert.deepEqual(requests, []);
});

// A main push that runs the full gate says why in one plain line the runner keeps (a ::notice:: annotation was lost).
// Every reason is a literal of the step: never a response body, a URL, a header or the job token.
const REFUSED = reason => `CI_GATE_MAIN_REUSE refused: ${reason}; running the full gate.`;

test('each refusal path names its fixed reason', () => {
  const reason = (data, edit = () => {}) => { edit(data); return evaluate(data).reason; };
  for (const status of ['failure', 'cancelled', 'running', 'waiting']) {
    assert.equal(reason(fixture([prRun(160, { status }), prRun(150)])), `the newest Ready pull request run at the head is ${status}`);
  }
  assert.equal(reason(fixture([prRun(160, { status: 'Bad\nline' }), prRun(150)])), 'the newest Ready pull request run at the head is not success');
  assert.equal(reason(fixture([prRun(160)], { 160: 'skipped' })), 'no Ready pull request run at the head executed the gate');
  assert.equal(reason(fixture([])), 'no Ready pull request run at the head executed the gate');
  assert.equal(reason(fixture(), d => { d.trees[HEAD] = 'e'.repeat(40); }), "the merged pull request's head has another tree");
  assert.equal(reason(fixture(), d => { d.current.trigger_event = 'pull_request'; }), 'this run is not the push of this commit to main');
  assert.equal(reason(fixture(), d => { d.pull.merged = false; }), 'this commit is not a same-repository pull request merged into main');
  // A refused shape names the check it failed, a literal of the step.
  assert.equal(reason(fixture([prRun(150, { is_fork_pull_request: true })])), 'provenance');
  assert.equal(reason(fixture(), d => { d.jobs[150] = d.jobs[150].filter(job => job.name !== 'quality'); }), 'quality job');
  assert.equal(reason(fixture(), d => { d.total = 2; }), 'incomplete history');
  assert.equal(evaluate(fixture()).reason, null, 'a reuse refuses nothing');
});

test('main() prints one reason line on a main push that runs the full gate, and nothing on a pull request or a reuse', () => {
  const cases = [
    [{ ENABLED: 'false' }, 'the gate is off'],
    [{ MAIN_REUSE: 'false' }, 'main-verdict-reuse is off for this repository'],
    [{ MAIN_REUSE: '' }, 'main-verdict-reuse is off for this repository'],
    [{ VERDICT_BEFORE: '' }, 'this run carries no push of a full commit'],
    [{ VERDICT_SHA: 'main' }, 'this run carries no push of a full commit'],
    [{ VERDICT_API: 'http://forge.example/api/v1' }, 'unsupported API'],
    [{}, 'PermissionError'],
    [{ FIXTURE_REFUSE: "the merged pull request's head has another tree" }, "the merged pull request's head has another tree"],
    [{ FIXTURE_RAISE: 'KeyError:workflow_id' }, 'KeyError workflow_id'],
    [{ FIXTURE_RAISE: 'KeyError:Bearer fixture-only' }, 'KeyError'],
    [{ FIXTURE_RAISE: 'json:{"leak": token fixture-only' }, 'JSONDecodeError'],
  ];
  for (const [env, reason] of cases) {
    const { output, printed } = runMain(env);
    assert.deepEqual(output, { reuse: 'false' }, JSON.stringify(env));
    assert.deepEqual(printed, [REFUSED(reason)], JSON.stringify(env));
  }
  for (const env of [{ VERDICT_PR: '7' }, { VERDICT_REF: 'refs/heads/other' }]) {
    assert.deepEqual(runMain(env).printed, [], JSON.stringify(env));
  }
  const reused = runMain({}, named());
  assert.equal(reused.output.reuse, 'true');
  assert.ok(!reused.printed.some(line => line.startsWith('CI_GATE_MAIN_REUSE')), 'a reuse prints no refusal');
});

test('an HTTP refusal names its code and the read\'s fixed shape, never the body, URL, headers or token', () => {
  for (const code of [401, 403, 404, 500, 302]) {
    const { output, printed, requests } = runMain({ FIXTURE_HTTP: JSON.stringify({ code, body: '{"message":"secret body text"}' }) });
    assert.deepEqual(output, { reuse: 'false' });
    assert.deepEqual(requests, [`https://forge.example/api/v1${root}/actions/runs/200`]);
    assert.deepEqual(printed, [REFUSED(`HTTP ${code} on actions/runs/{id}`)]);
    for (const leak of ['secret', 'leak', 'header-value', 'fixture-only', 'forge.example', 'fulcrum-labs/fixture', '200']) {
      assert.ok(!printed.join('\n').includes(leak), `${code} leaks ${leak}`);
    }
  }
});

test('a read is named by its fixed shape, and any other path by none', () => {
  const result = spawnSync('python3', ['-I', '-c', `
import json, sys
namespace = {"__name__": "fixture"}
exec(compile(json.load(sys.stdin), "ci-gate.yml", "exec"), namespace)
root = "/repos/fulcrum-labs/fixture"
print(json.dumps([namespace["endpoint"](root + path) for path in sys.argv[1:]]))
`, '/actions/runs/200', `/commits/${MAIN}/pull`, `/git/commits/${HEAD}`, `/actions/runs?head_sha=${HEAD}&workflow_id=ci.yml&limit=50&page=1`,
    '/actions/runs/150/jobs?limit=50&page=1', '/actions/jobs/1501', '/actions/secrets', `/contents/${'x'.repeat(10)}`],
  { input: JSON.stringify(verdictSource), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['actions/runs/{id}', 'commits/{sha}/pull', 'git/commits/{sha}', 'actions/runs',
    'actions/runs/{id}/jobs', 'actions/jobs/{id}', 'another read', 'another read']);
});

test('every refusal text in the step is a literal, so the reason line can print nothing it read', () => {
  const refusals = [...verdictSource.matchAll(/(?<!def )\b(?:raise Refusal|refuse)\((.*)\)/g)].map(m => m[1].replace(/\) from None$/, ''));
  assert.ok(refusals.length >= 20, refusals.length);
  const formatted = new Set(['f"HTTP {code} on {endpoint(path)}"', 'f"the newest Ready pull request run at the head is {status}"']);
  for (const text of refusals) {
    assert.ok(/^"[^"{}\\]+"$/.test(text) || formatted.has(text), text);
  }
  assert.doesNotMatch(verdictSource, /raise ValueError\(/, 'every refusal of this step is a Refusal');
});

test('the gate asks for no more than contents: read, the most every caller grants', () => {
  // A called workflow that asks for more than its caller grants may fail at start; a wider grant is its own change.
  assert.match(workflow, /^permissions:\n  contents: read\n\n/m);
});

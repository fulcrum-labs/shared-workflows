import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../workflows/ci-gate.yml', import.meta.url), 'utf8');
const embedded = workflow.match(/          python3 - <<'PRIOR_VERDICT'\n([\s\S]+?)          PRIOR_VERDICT/);
assert.ok(embedded, 'exercise the exact Python shipped in the reusable workflow');
const source = embedded[1].split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const repository = 'fulcrum-labs/fixture';
const root = `/repos/${repository}`;

function run(id = 109, draft = false) {
  return {
    id, index_in_repo: id - 100, workflow_id: 'pr-ci.yml', commit_sha: head,
    repository: { full_name: repository }, trigger_event: 'pull_request',
    is_fork_pull_request: false, need_approval: false, status: 'success',
    started: '2026-10-16T12:00:00Z', stopped: '2026-10-16T12:01:00Z', duration: 60e9,
    html_url: `https://forge.example/${repository}/actions/runs/${id - 100}`,
    event_payload: JSON.stringify({ action: id === 110 ? 'edited' : 'synchronize',
      pull_request: { number: 42, draft, head: { sha: head, repo: { full_name: repository } },
        base: { sha: base, ref: 'main', repo: { full_name: repository } } } }),
  };
}

function status(job, id = 1, index = 9) {
  return { id, context: `ci / ${job} (pull_request)`, status: 'success',
    description: 'Successful in 1m0s', target_url: `/${repository}/actions/runs/${index}/jobs/${id}` };
}

function fixture() {
  return { current: run(110), history: [run(110), run()],
    statuses: ['quality', 'gitleaks', 'grype', 'semgrep'].map((job, i) => status(job, i + 1)),
    live: { state: 'open', draft: false, head: { sha: head }, base: { sha: base, ref: 'main' } },
    tip: { commit: { id: base } }, docsLint: false };
}

function editPayload(run, edit) {
  const payload = JSON.parse(run.event_payload);
  edit(payload);
  run.event_payload = JSON.stringify(payload);
}

function evaluate(data = fixture()) {
  const result = spawnSync('python3', ['-c', `
import json, sys, urllib.parse
data = json.load(sys.stdin)
namespace = {"__name__": "fixture"}
exec(compile(data.pop("source"), "ci-gate.yml", "exec"), namespace)
reads = []
def read(path):
    reads.append(path)
    if data.get("failPath") and data["failPath"] in path:
        raise PermissionError("fixture refusal")
    url = urllib.parse.urlsplit(path)
    query = urllib.parse.parse_qs(url.query, keep_blank_values=True)
    page = int(query.get("page", [1])[0])
    start = (page - 1) * 50
    root = "/repos/fulcrum-labs/fixture"
    if url.path == root + "/actions/runs/110":
        return data["current"]
    if url.path == root + "/actions/runs":
        assert query["head_sha"] == ["a" * 40]
        assert query["workflow_id"] == [str(data["current"]["workflow_id"])]
        return {"workflow_runs": data["history"][start:start+50],
                "total_count": data.get("total", len(data["history"]))}
    if url.path == root + "/actions/runs/109/jobs" and "skippedJobs" in data:
        return data["skippedJobs"][start:start+50]
    if url.path.endswith("/statuses"):
        return data["statuses"][start:start+50]
    if url.path == root + "/pulls/42":
        return data["live"]
    if url.path == root + "/branches/main":
        return data["tip"]
    raise AssertionError("unexpected read")
try:
    reuse = namespace["reusable"](read, "fulcrum-labs/fixture", 110, data["docsLint"])
    print(json.dumps({"reuse": reuse, "reads": reads}))
except Exception as e:
    print(json.dumps({"reuse": False, "error": type(e).__name__, "reads": reads}))
`], { input: JSON.stringify({ source, ...data }), encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('a metadata edit reuses all required successes at the same immutable head', () => {
  const result = evaluate();
  assert.equal(result.reuse, true, JSON.stringify(result));
  assert.equal(result.reads.at(-1), `${root}/pulls/42`);
  assert.ok(!result.reads.some(path => path.includes('/branches/')), 'the base tip is not read');
});

test('ready uses the same verdict and a still-draft event cannot use it', () => {
  const data = fixture();
  editPayload(data.current, p => { p.action = 'ready_for_review'; });
  assert.equal(evaluate(data).reuse, true);
  editPayload(data.current, p => { p.action = 'converted_to_draft'; p.pull_request.draft = true; });
  assert.equal(evaluate(data).reuse, false);
});

test('new commits and ordinary synchronize events run full CI', () => {
  for (const change of [
    d => editPayload(d.current, p => { p.action = 'synchronize'; }),
    d => { d.current.commit_sha = 'c'.repeat(40); },
    d => { d.history[1].commit_sha = 'c'.repeat(40); },
  ]) {
    const data = fixture(); change(data); assert.equal(evaluate(data).reuse, false);
  }
});

test('missing, empty or non-string workflow identity runs full CI before history lookup', () => {
  for (const identity of ['', '   ', null, 42]) {
    const data = fixture();
    for (const run of [data.current, ...data.history]) run.workflow_id = identity;
    const result = evaluate(data);
    assert.equal(result.reuse, false, JSON.stringify({ identity, result }));
    assert.deepEqual(result.reads, [`${root}/actions/runs/110`]);
  }
  const data = fixture(); delete data.current.workflow_id;
  assert.equal(evaluate(data).reuse, false);
  const history = fixture(); delete history.history[1].workflow_id;
  assert.equal(evaluate(history).reuse, false, 'history cannot infer identity from the requested filter');
});

test('nonempty workflow filenames, paths and id strings preserve compatibility', () => {
  for (const identity of ['pr-ci.yml', 'nested/pr-ci.yml', '42']) {
    const data = fixture();
    for (const run of [data.current, ...data.history]) run.workflow_id = identity;
    assert.equal(evaluate(data).reuse, true, identity);
  }
});

test('main moving on does not void a verdict for the same head; another base branch or head does', () => {
  // Forgejo checks out the head itself and records the base tip at event time, so an edit
  // after main advanced carries a new base sha for the same tested head.
  for (const change of [
    d => { d.tip.commit.id = 'c'.repeat(40); },
    d => { d.live.base.sha = 'c'.repeat(40); },
    d => editPayload(d.history[1], p => { p.pull_request.base.sha = 'c'.repeat(40); }),
    d => editPayload(d.current, p => { p.pull_request.base.sha = 'c'.repeat(40); }),
  ]) {
    const data = fixture(); change(data); assert.equal(evaluate(data).reuse, true);
  }
  for (const change of [
    d => { d.live.base.ref = 'release'; },
    d => editPayload(d.history[1], p => { p.pull_request.base.ref = 'release'; }),
    d => { d.live.head.sha = 'c'.repeat(40); },
    d => editPayload(d.history[1], p => { p.pull_request.number = 43; }),
  ]) {
    const data = fixture(); change(data); assert.equal(evaluate(data).reuse, false);
  }
});

test('draft-skipped green never qualifies, but a draft event does not erase an earlier real verdict', () => {
  const data = fixture();
  editPayload(data.history[1], p => { p.pull_request.draft = true; });
  assert.equal(evaluate(data).reuse, false);
  data.history.push(run(108));
  // Positive skipped evidence, not a Draft flag standing in for unknown execution.
  // The negative assertion above still has no execution/skip proof at all.
  data.skippedJobs = ['quality', 'gitleaks', 'grype', 'semgrep'].map((name, i) => ({
    id: 211361 + i, run_id: 109, attempt: 1, name, status: 'skipped', task_id: 0,
  }));
  data.statuses = data.statuses.map(s => ({ ...s, target_url: s.target_url.replace('/runs/9/', '/runs/8/') }));
  assert.equal(evaluate(data).reuse, true);
});

test('a later failed, cancelled, waiting or running real run prevents reuse of older green', () => {
  for (const state of ['failure', 'cancelled', 'waiting', 'running']) {
    const data = fixture(); data.history[1].status = state; data.history.push(run(108));
    assert.equal(evaluate(data).reuse, false);
  }
  const newer = fixture(); newer.history.unshift(run(111));
  assert.equal(evaluate(newer).reuse, false, 'a newer event cannot be bypassed by an older queued lookup');
});

test('a newer run still queued behind this one is no barrier; started or finished newer work is', () => {
  for (const state of ['waiting', 'blocked']) {
    for (const started of ['1970-01-01T00:00:00Z', '0001-01-01T00:00:00Z']) {
      const data = fixture(); const queued = run(111);
      queued.status = state; queued.started = started; queued.stopped = started;
      data.history.unshift(queued);
      assert.equal(evaluate(data).reuse, true, `a queued ${state} edit waits behind this verdict`);
    }
  }
  for (const [state, started] of [['running', '2026-10-16T12:02:00Z'], ['waiting', '2026-10-16T12:02:00Z'],
    ['success', '2026-10-16T12:02:00Z'], ['failure', '2026-10-16T12:02:00Z'], ['cancelled', '1970-01-01T00:00:00Z']]) {
    const data = fixture(); const later = run(111);
    later.status = state; later.started = started;
    data.history.unshift(later);
    assert.equal(evaluate(data).reuse, false, `newer ${state} work remains a barrier`);
  }
});

test('a completed quick reuse run may have zero duration at Forgejo second precision', () => {
  const data = fixture();
  data.history[1].stopped = data.history[1].started;
  delete data.history[1].duration;
  data.statuses.forEach(s => { s.description = 'Successful in 0s'; });
  assert.equal(evaluate(data).reuse, true, 'ready/edit toggles keep the proven verdict');
});

test('missing provenance, fork or approval requirements, and unstarted runs run full CI', () => {
  for (const change of [
    d => { delete d.history[1].event_payload; },
    d => { d.history[1].event_payload = '{malformed'; },
    d => editPayload(d.history[1], p => { delete p.pull_request.base.sha; }),
    d => editPayload(d.history[1], p => { delete p.pull_request.draft; }),
    d => editPayload(d.history[1], p => { p.pull_request.head.repo.full_name = 'other/fork'; }),
    d => { d.history[1].is_fork_pull_request = true; },
    d => { d.history[1].need_approval = true; },
    d => { d.history[1].started = '1970-01-01T00:00:00Z'; },
    d => { d.history[1].duration = -1; },
    d => { d.history[1].stopped = '1970-01-01T00:00:00Z'; },
  ]) {
    const data = fixture(); change(data); assert.equal(evaluate(data).reuse, false);
  }
});

test('every required status must be successful, actually run, and bound to the same prior run', () => {
  for (const change of [
    d => { d.statuses.pop(); },
    d => { d.statuses[0].status = 'failure'; },
    d => { d.statuses[0].description = 'Has been skipped'; },
    d => { d.statuses[0].target_url = `/${repository}/actions/runs/8/jobs/1`; },
    d => { d.statuses[0].target_url = 'https://other.example/' + repository + '/actions/runs/9/jobs/1'; },
    d => { d.history[1].html_url = 'https://other.example/' + repository + '/actions/runs/9'; },
    d => { d.statuses[0].context = 'different / quality (pull_request)'; },
    d => { d.statuses.push({ ...d.statuses[0], id: 20, status: 'failure' }); },
  ]) {
    const data = fixture(); change(data); assert.equal(evaluate(data).reuse, false);
  }
});

test('optional docs lint must also have a completed success when enabled', () => {
  const data = fixture(); data.docsLint = true;
  assert.equal(evaluate(data).reuse, false);
  data.statuses.push(status('docs-lint', 5));
  assert.equal(evaluate(data).reuse, true);
});

test('API refusal, incomplete histories and bounded pagination run full CI', () => {
  for (const change of [
    d => { d.failPath = '/actions/runs'; },
    d => { d.total = 70; },
    d => { d.history.push({ ...d.history[1] }); },
    d => { d.history.shift(); },
    d => { d.statuses.unshift(...Array.from({ length: 200 }, (_, i) => status('quality', i, 1))); },
  ]) {
    const data = fixture(); change(data); const result = evaluate(data);
    assert.equal(result.reuse, false);
    assert.ok(result.reads.length <= 7, 'no unbounded page reads');
  }
});

test('closed, draft, or moved live PRs run full CI', () => {
  for (const change of [
    d => { d.live.state = 'closed'; },
    d => { d.live.draft = true; },
    d => { d.live.head.sha = 'c'.repeat(40); },
  ]) {
    const data = fixture(); change(data); assert.equal(evaluate(data).reuse, false);
  }
});

test('PR text remains data, never shell source or an output directive', () => {
  const data = fixture();
  for (const r of [data.current, data.history[1]]) {
    editPayload(r, p => { p.pull_request.title = '$(exit 99)'; p.pull_request.body = '\nreuse=true\n'; });
  }
  assert.equal(evaluate(data).reuse, true);
  assert.doesNotMatch(embedded[0], /\$\{\{[^\n]*(?:body|title)/);
  assert.doesNotMatch(source, /\beval\(|shell=True|subprocess/);
  assert.match(source, /class NoRedirect/);
  assert.match(source, /deadline = time\.monotonic\(\) \+ 25/);
  assert.match(source, /response\.read\(2 \* 1024 \* 1024 \+ 1\)/);
});

test('the shipped entry point turns API refusal into full CI without logging response details', () => {
  const result = spawnSync('python3', ['-c', `
import contextlib, io, json, os, sys, tempfile
namespace = {"__name__": "fixture"}
exec(compile(json.load(sys.stdin), "ci-gate.yml", "exec"), namespace)
class Refusal:
    def open(self, request, **kwargs):
        assert request.get_method() == "GET"
        raise PermissionError("PRIVATE-FIXTURE-DETAIL")
namespace["urllib"].request.build_opener = lambda *args: Refusal()
with tempfile.TemporaryDirectory(prefix="ci-verdict-fixture-") as folder:
    output = folder + "/output"
    os.environ.update({"VERDICT_API": "https://forge.example/api/v1",
        "VERDICT_REPOSITORY": "fulcrum-labs/fixture", "VERDICT_RUN_ID": "110",
        "VERDICT_TOKEN": "fixture-only", "GITHUB_OUTPUT": output})
    log = io.StringIO()
    with contextlib.redirect_stdout(log):
        namespace["main"]()
    with open(output) as file:
        print(json.dumps({"output": file.read(), "log": log.getvalue()}))
`], { input: JSON.stringify(source), encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.output, 'reuse=false\n');
  assert.match(data.log, /running the full gate/);
  assert.doesNotMatch(data.log, /PRIVATE-FIXTURE-DETAIL|fixture-only/);
});

test("the shipped reader names itself, because Cloudflare refuses Python-urllib's default User-Agent (Error 1010)", () => {
  const result = spawnSync('python3', ['-c', `
import json, os, sys, tempfile
namespace = {"__name__": "fixture"}
exec(compile(json.load(sys.stdin), "ci-gate.yml", "exec"), namespace)
seen = []
class Recorder:
    def open(self, request, **kwargs):
        seen.append(request.get_header("User-agent"))
        raise PermissionError("fixture refusal")
namespace["urllib"].request.build_opener = lambda *args: Recorder()
with tempfile.TemporaryDirectory(prefix="ci-verdict-fixture-") as folder:
    os.environ.update({"VERDICT_API": "https://forge.example/api/v1",
        "VERDICT_REPOSITORY": "fulcrum-labs/fixture", "VERDICT_RUN_ID": "110",
        "VERDICT_TOKEN": "fixture-only", "GITHUB_OUTPUT": folder + "/output"})
    namespace["main"]()
print(json.dumps(seen))
`], { input: JSON.stringify(source), encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const agents = JSON.parse(result.stdout.trim().split('\n').pop());
  assert.ok(agents.length > 0, 'the reader made at least one request');
  for (const agent of agents) {
    assert.equal(agent, 'platform-foundations-ci-verdict/1');
    assert.doesNotMatch(agent, /urllib/i);
  }
});

test('all original steps retain their conditions and run when reuse is absent', () => {
  const steps = workflow.split(/^      - /m).slice(1);
  assert.equal(steps.filter(s => s.startsWith('*prior-verdict')).length, 4);
  const guarded = steps.filter(s => !s.startsWith('*prior-verdict') && !s.startsWith('&prior-verdict') && !s.startsWith('name: Draft runs are never green') && !s.startsWith('name: Choose runner labels'));
  assert.equal(guarded.length, 33, 'all normal gate steps remain present');
  for (const step of guarded) assert.match(step, /^ {8}if: \$\{\{ steps\.prior-verdict\.outputs\.reuse != 'true'/m);
  assert.match(workflow, /if: \$\{\{ steps\.prior-verdict\.outputs\.reuse != 'true' && \(steps\.turbo-cache\.outputs\.eligible == 'true'\) \}\}/);
  assert.match(workflow, /^    if: \$\{\{ !cancelled\(\) && inputs\.enabled && inputs\.docs-lint-enabled \}\}/m);
});

test('metadata lifecycle preserves active CI while new heads still cancel stale work', () => {
  const expression = workflow.match(/cancel-in-progress: \$\{\{ (.+) \}\}/)[1];
  const cancel = (ref, action) => Function('github', `return ${expression}`)({ ref, event: { action } });
  for (const action of ['edited', 'ready_for_review', 'converted_to_draft']) {
    assert.equal(cancel('refs/pull/42/head', action), false);
  }
  assert.equal(cancel('refs/pull/42/head', 'synchronize'), true);
  assert.equal(cancel('refs/heads/main', ''), false);
});

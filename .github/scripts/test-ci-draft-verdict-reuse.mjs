import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../workflows/ci-gate.yml', import.meta.url), 'utf8');
const embedded = workflow.match(/          python3 - <<'PRIOR_VERDICT'\n([\s\S]+?)          PRIOR_VERDICT/);
assert.ok(embedded, 'exercise the shipped reader, never a second verifier');
const source = embedded[1].split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
const repository = 'fulcrum-labs/fixture';
const root = `/repos/${repository}`;
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const started = '2026-10-16T12:00:00Z';
const stopped = '2026-10-16T12:01:00Z';
const work = {
  quality: 'CI gate (typecheck + lint + test + build)',
  gitleaks: 'Gitleaks scan',
  grype: 'Grype vulnerability scan',
  semgrep: 'Semgrep scan',
  'docs-lint': 'Docs convention lint',
};

function run(id, draft) {
  return {
    id, index_in_repo: id - 100, workflow_id: 'ci.yml', commit_sha: head,
    repository: { full_name: repository }, trigger_event: 'pull_request',
    is_fork_pull_request: false, need_approval: false, status: 'success',
    started, stopped, duration: 60e9,
    html_url: `https://forge.example/${repository}/actions/runs/${id - 100}`,
    event_payload: JSON.stringify({ action: id === 110 ? 'ready_for_review' : 'synchronize',
      pull_request: { number: 42, draft, head: { sha: head, repo: { full_name: repository } },
        base: { sha: base, ref: 'main', repo: { full_name: repository } } } }),
  };
}

function fixture(docsLint = false) {
  const names = Object.keys(work).filter(name => docsLint || name !== 'docs-lint');
  // Exact v17 rehearsal wire types: the list is an ARRAY, attempts and task IDs
  // are integers, and a job detail adds numbered steps with nullable ISO times.
  // IDs survive a rerun; attempt and task_id identify its current execution.
  const jobs = names.map((name, index) => ({
    id: 211361 + index, run_id: 109, attempt: 3,
    handle: `fixture-job-${index}`, repo_id: 1, owner_id: 1, name,
    html_url: `https://forge.example/${repository}/actions/runs/9/jobs/${index}/attempt/3`,
    needs: [], runs_on: ['go-heavy'], task_id: 202062 + index, status: 'success',
  }));
  const details = Object.fromEntries(jobs.map(job => [job.id, { ...job, steps: [
    { number: 0, name: 'Set up job', status: 'success', started, stopped: started },
    { number: 1, name: 'Reuse completed CI for unchanged head and base', status: 'success', started, stopped: started },
    { number: 2, name: 'Checkout', status: 'success', started, stopped: started },
    { number: 3, name: work[job.name], status: 'success', started, stopped },
    { number: 4, name: 'Complete job', status: 'success', started: stopped, stopped },
  ] }]));
  return {
    current: run(110, false), history: [run(110, false), run(109, true)], jobs, details,
    statuses: names.map((name, index) => ({ id: index + 1,
      context: `CI / ${name} (pull_request)`, status: 'success', description: 'Successful in 1m0s',
      target_url: `/${repository}/actions/runs/9/jobs/${index}` })),
    live: { state: 'open', draft: false, head: { sha: head }, base: { sha: base, ref: 'main' } },
    tip: { commit: { id: base } }, docsLint,
  };
}

function editPayload(run, change) {
  const value = JSON.parse(run.event_payload); change(value); run.event_payload = JSON.stringify(value);
}

function olderGreen(data) {
  data.history.push(run(108, false));
  data.statuses.forEach(status => { status.target_url = status.target_url.replace('/runs/9/', '/runs/8/'); });
}

function evaluate(data) {
  const result = spawnSync('python3', ['-c', `
import json, sys, urllib.parse
data = json.load(sys.stdin)
namespace = {"__name__": "fixture"}
exec(compile(data.pop("source"), "ci-gate.yml", "exec"), namespace)
reads = []
job_reads = 0
def read(path):
    global job_reads
    reads.append(path)
    if data.get("failPath") and data["failPath"] in path:
        raise PermissionError("fixture refusal")
    url = urllib.parse.urlsplit(path)
    query = urllib.parse.parse_qs(url.query)
    page = int(query.get("page", [1])[0])
    start = (page - 1) * 50
    root = "/repos/fulcrum-labs/fixture"
    if url.path == root + "/actions/runs/110":
        return data["current"]
    if url.path == root + "/actions/runs":
        return {"workflow_runs": data["history"][start:start+50], "total_count": len(data["history"])}
    if url.path == root + "/actions/runs/109/jobs":
        job_reads += 1
        jobs = data.get("afterJobs", data["jobs"]) if job_reads > 1 else data["jobs"]
        return jobs[start:start+50] if isinstance(jobs, list) else jobs
    if url.path.startswith(root + "/actions/jobs/"):
        return data["details"][url.path.rsplit("/", 1)[1]]
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
except Exception as error:
    print(json.dumps({"reuse": False, "error": type(error).__name__, "reads": reads}))
`], { input: JSON.stringify({ source, ...data }), encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('a truly executed successful Draft verdict qualifies with all current job attempts and required work steps', () => {
  for (const docsLint of [false, true]) {
    const result = evaluate(fixture(docsLint));
    assert.equal(result.reuse, true, JSON.stringify(result));
    assert.equal(result.reads.at(-1), `${root}/pulls/42`);
    assert.equal(result.reads.filter(path => path.includes('/actions/jobs/')).length, docsLint ? 5 : 4);
    assert.equal(result.reads.filter(path => path.includes('/actions/runs/109/jobs')).length, 2,
      'recheck the current job/attempt snapshot after status proof');
  }
});

test('execution is proved by work steps, never elapsed duration or setup/reuse-only success', () => {
  const zero = fixture(); zero.history[1].duration = 0;
  for (const detail of Object.values(zero.details)) detail.steps[3].stopped = started;
  assert.equal(evaluate(zero).reuse, true, 'a real zero-second work step is still execution');
  for (const change of [
    d => { d.details[d.jobs[0].id].steps.splice(3, 1); },
    d => { const step = d.details[d.jobs[0].id].steps[3]; step.status = 'skipped'; step.started = null; step.stopped = null; },
    d => { d.details[d.jobs[0].id].steps[3].name = 'Set up job'; },
    d => { delete d.details[d.jobs[0].id].steps; },
  ]) {
    const data = fixture(); change(data); assert.equal(evaluate(data).reuse, false);
  }
});

test('each required job must exist exactly once, execute, and succeed', () => {
  for (const change of [
    d => { d.jobs.pop(); }, d => { d.jobs.push({ ...d.jobs[0] }); },
    d => { d.jobs[1].name = d.jobs[0].name; },
    d => { d.jobs[0].status = 'skipped'; d.jobs[0].task_id = 0; },
    d => { d.jobs[0].status = 'failure'; }, d => { d.jobs[0].status = 'running'; },
    d => { d.jobs[0].task_id = 0; }, d => { d.jobs[0].run_id = 108; },
    d => { d.jobs[0].id = '211361'; }, d => { d.jobs[0].attempt = true; },
    d => { d.jobs = { jobs: d.jobs }; }, d => { d.jobs = []; },
  ]) {
    const data = fixture(); change(data); assert.equal(evaluate(data).reuse, false);
  }
  const docs = fixture(true); docs.jobs.pop(); assert.equal(evaluate(docs).reuse, false);
});

test('job detail belongs to the same run, job, attempt, task and UI index', () => {
  for (const change of [
    job => { job.id += 1; }, job => { job.run_id = 108; },
    job => { job.attempt = 2; }, job => { job.task_id -= 1; },
    job => { job.name = 'other'; }, job => { job.html_url = job.html_url.replace('/jobs/0/', '/jobs/8/'); },
  ]) {
    const data = fixture(); change(data.details[data.jobs[0].id]); assert.equal(evaluate(data).reuse, false);
  }
  for (const change of [
    job => { job.html_url = job.html_url.replace('/attempt/3', '/attempt/2'); },
    job => { job.html_url = job.html_url.replace('forge.example', 'other.example'); },
    job => { job.html_url += '?unexpected=1'; },
  ]) {
    const data = fixture(); change(data.jobs[0]); data.details[data.jobs[0].id].html_url = data.jobs[0].html_url;
    assert.equal(evaluate(data).reuse, false);
  }
  const wrongIndex = fixture(); wrongIndex.statuses[0].target_url = wrongIndex.statuses[1].target_url;
  assert.equal(evaluate(wrongIndex).reuse, false, 'status must bind the actually executed job, not just its run');
  const duplicateIndex = fixture();
  duplicateIndex.jobs[1].html_url = duplicateIndex.jobs[0].html_url;
  duplicateIndex.details[duplicateIndex.jobs[1].id].html_url = duplicateIndex.jobs[1].html_url;
  duplicateIndex.statuses[1].target_url = duplicateIndex.statuses[0].target_url;
  assert.equal(evaluate(duplicateIndex).reuse, false, 'distinct jobs need distinct UI indices');
});

test('reruns cannot splice detail from a stale attempt or a changed final job snapshot', () => {
  for (const change of [
    job => { job.attempt += 1; job.task_id += 1; },
    job => { job.task_id += 1; }, job => { job.status = 'running'; },
  ]) {
    const data = fixture(); data.afterJobs = structuredClone(data.jobs); change(data.afterJobs[0]);
    assert.equal(evaluate(data).reuse, false);
  }
  const types = fixture();
  types.jobs[0].attempt = 1;
  types.jobs[0].html_url = types.jobs[0].html_url.replace('/attempt/3', '/attempt/1');
  types.details[types.jobs[0].id].attempt = 1;
  types.details[types.jobs[0].id].html_url = types.jobs[0].html_url;
  types.afterJobs = structuredClone(types.jobs); types.afterJobs[0].attempt = true;
  assert.equal(evaluate(types).reuse, false, 'integer attempt 1 cannot compare equal to JSON true');
});

test('work-step evidence must be unique, complete, successful and inside this run', () => {
  for (const change of [
    steps => { steps[3].status = 'failure'; }, steps => { steps[3].status = 'running'; },
    steps => { steps[3].started = null; }, steps => { steps[3].stopped = null; },
    steps => { steps[3].started = '1970-01-01T00:00:00Z'; },
    steps => { steps[3].stopped = '2026-10-16T12:02:00Z'; },
    steps => { steps[3].started = '2026-10-16T11:59:59Z'; },
    steps => { steps[3].started = '2026-10-16T12:00:00'; },
    steps => { steps.push({ ...steps[3], number: 5 }); },
    steps => { steps[3].number = steps[2].number; },
  ]) {
    const data = fixture(); change(data.details[data.jobs[0].id].steps); assert.equal(evaluate(data).reuse, false);
  }
});

test('a positively skipped Draft transition still preserves an earlier non-Draft verdict', () => {
  const data = fixture(); olderGreen(data);
  data.jobs.forEach(job => { job.status = 'skipped'; job.task_id = 0; });
  assert.equal(evaluate(data).reuse, true);
  delete data.jobs[0].task_id;
  assert.equal(evaluate(data).reuse, false, 'unknown execution cannot be labelled skipped');
});

test('a Draft run Forgejo aggregates as skipped is passed over without the per-run jobs API (Forgejo 15)', () => {
  // Forgejo 15 routes no /actions/runs/{id}/jobs or /actions/jobs/{id}, and hands a skipped job to a runner.
  const data = fixture(); olderGreen(data); data.history[1].status = 'skipped'; data.failPath = '/jobs';
  const result = evaluate(data);
  assert.equal(result.reuse, true);
  assert.ok(!result.reads.some(path => path.includes('/jobs')), 'no job read for a skipped run');
  const executed = fixture(); olderGreen(executed); executed.failPath = '/jobs';
  assert.equal(evaluate(executed).reuse, false, 'a successful Draft run still needs job evidence');
  const only = fixture(); only.history[1].status = 'skipped'; only.failPath = '/jobs';
  assert.equal(evaluate(only).reuse, false, 'a skipped Draft run is no verdict of its own');
});

test('newer failed, cancelled, incomplete or unknown Draft work cannot expose older non-Draft green', () => {
  for (const state of ['failure', 'cancelled', 'waiting', 'running', 'blocked']) {
    const data = fixture(); olderGreen(data); data.history[1].status = state;
    assert.equal(evaluate(data).reuse, false, state);
  }
  for (const change of [
    d => { delete d.details[d.jobs[0].id].steps; },
    d => { d.details[d.jobs[0].id].steps[3].status = 'failure'; },
    d => { d.jobs[0].status = 'running'; }, d => { d.failPath = '/jobs'; },
  ]) {
    const data = fixture(); olderGreen(data); change(data); assert.equal(evaluate(data).reuse, false);
  }
});

test('Draft execution proof does not relax immutable base/head/workflow/fork/live/status refusals', () => {
  for (const change of [
    d => { d.live.draft = true; },
    d => { d.live.head.sha = 'c'.repeat(40); }, d => { d.current.workflow_id = ''; },
    d => editPayload(d.history[1], p => { p.pull_request.base.ref = 'release'; }),
    d => editPayload(d.history[1], p => { p.pull_request.head.repo.full_name = 'other/fork'; }),
    d => { d.history[1].need_approval = true; }, d => { d.history[1].is_fork_pull_request = true; },
    d => { d.statuses[0].description = 'Has been skipped'; },
    d => { d.statuses[0].status = 'failure'; }, d => { d.statuses.pop(); },
  ]) {
    const data = fixture(); change(data); assert.equal(evaluate(data).reuse, false);
  }
});

test('unsupported or refused job APIs keep full CI, including the v15 absent-API case', () => {
  for (const path of ['/actions/runs', '/actions/runs/109/jobs', '/actions/jobs/']) {
    const data = fixture(); data.failPath = path; assert.equal(evaluate(data).reuse, false);
  }
  assert.match(source, /deadline = time\.monotonic\(\) \+ 25/);
  assert.match(source, /timeout=min\(5, remaining\)/);
  assert.match(source, /response\.read\(2 \* 1024 \* 1024 \+ 1\)/);
  assert.match(source, /class NoRedirect/);
  assert.doesNotMatch(source, /\/logs|write:|POST|eval\(|shell=True/);
});

test('execution witnesses name the actual managed work steps, each still guarded by the same proof', () => {
  for (const [name, step] of Object.entries(work)) {
    const start = workflow.indexOf(`\n  ${name}:`);
    assert.ok(start >= 0, name);
    const rest = workflow.slice(start + 1);
    const next = rest.slice(1).search(/^  [a-z][a-z-]*:$/m);
    const section = next < 0 ? rest : rest.slice(0, next + 1);
    assert.ok(section.includes(`      - name: ${step}\n`), `${name}: ${step}`);
    assert.ok(section.includes("      - name: " + step + "\n        if: ${{ steps.prior-verdict.outputs.reuse != 'true' }}"));
  }
});

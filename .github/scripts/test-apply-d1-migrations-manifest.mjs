import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Tests for apply-d1-migrations.mjs --manifest (delivery d1.migrate).
//
// The D1 here is a REAL SQLite database (node:sqlite, Node >= 22.13 / 24) behind
// a fixture HTTP server that speaks the ONE Cloudflare REST endpoint the mode is
// allowed to call (POST .../d1/database/{id}/query); any other request fails the run. A query request runs as one transaction and rolls back
// on any error, which is the D1 batch behaviour the mode relies on. Using real
// SQLite matters for the fronts-data R17 case: the non-idempotent ALTERs really
// do fail with "duplicate column name" if a replay ever reaches the database.

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'apply-d1-migrations.mjs');
const ACCOUNT = 'b8fd8daf73edd8fe6b6bd18eeaacf2bb';
const DB_ID = '11111111-2222-4333-8444-555555555555';
const LEDGER_READ_SQL = 'SELECT id, name FROM d1_migrations ORDER BY id';
const ledgerInsertSuffix = (id) => `\n;\nINSERT INTO d1_migrations (name, applied_at) VALUES ('${id}', CURRENT_TIMESTAMP);`;
const DB_NAME = 'fronts-data';
const HANDLE = 'grant-handle-not-a-real-token';

const { DatabaseSync } = await import('node:sqlite');

const cleanups = [];
after(() => {
  for (const fn of cleanups) fn();
});

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// ---- fixture D1 ------------------------------------------------------------

async function startD1({ ledger = 'create', seedLedger = [], seedSql = '', hooks = {} } = {}) {
  const db = new DatabaseSync(':memory:');
  if (ledger === 'create') {
    db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
    for (const name of seedLedger) db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name);
  }
  if (seedSql) db.exec(seedSql);
  const requests = [];
  let writes = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      const record = { method: req.method, path: url.pathname, search: url.search, auth: req.headers.authorization, sql: null };
      requests.push(record);
      const send = (status, json) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (hooks.redirectQuery && req.method === 'POST') {
        res.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' });
        res.end();
        return;
      }
      if (req.method === 'POST' && url.pathname === `/accounts/${ACCOUNT}/d1/database/${DB_ID}/query`) {
        const sql = JSON.parse(body).sql;
        record.sql = sql;
        const isRead = /^\s*SELECT\b/i.test(sql);
        if (isRead) {
          if (hooks.onRead) {
            const replaced = hooks.onRead(requests.filter((r) => r.sql && /^\s*SELECT\b/i.test(r.sql)).length);
            if (replaced) {
              send(200, { success: true, result: [{ success: true, results: replaced }] });
              return;
            }
          }
          try {
            send(200, { success: true, result: [{ success: true, results: db.prepare(sql).all() }] });
          } catch (error) {
            send(400, { success: false, errors: [{ code: 7500, message: `${error.message}` }], result: [] });
          }
          return;
        }
        writes += 1;
        const beforeExec = hooks.beforeWrite ? hooks.beforeWrite(writes, sql) : null;
        if (beforeExec === 'drop') {
          req.socket.destroy();
          return;
        }
        if (beforeExec === '502') {
          send(502, { success: false, errors: [{ message: 'bad gateway' }] });
          return;
        }
        try {
          db.exec('BEGIN');
          db.exec(sql);
          db.exec('COMMIT');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
          send(400, { success: false, errors: [{ code: 7500, message: `${error.message}` }], result: [] });
          return;
        }
        const afterExec = hooks.afterWrite ? hooks.afterWrite(writes, sql) : null;
        if (afterExec === 'drop') {
          req.socket.destroy();
          return;
        }
        send(200, { success: true, result: [{ success: true, results: [] }] });
        return;
      }
      send(404, { success: false, errors: [{ message: `unexpected ${req.method} ${url.pathname}` }] });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => { server.close(); server.closeAllConnections?.(); db.close(); });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    db,
    requests,
    writeRequests: () => requests.filter((r) => r.method === 'POST' && r.sql && !/^\s*SELECT\b/i.test(r.sql)),
    ledger: () => db.prepare('SELECT name FROM d1_migrations ORDER BY id').all().map((r) => r.name),
    tables: () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name),
    columns: (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name),
    close: () => server.close(),
  };
}

// ---- artifact --------------------------------------------------------------

// files: { relativePath: sqlText }; order: ids in apply order mapped to paths
function makeArtifact(entries, { extraFiles = {}, transform } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'd1-manifest-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const entry of entries) {
    mkdirSync(dirname(join(dir, entry.file)), { recursive: true });
    writeFileSync(join(dir, entry.file), entry.sql);
  }
  for (const [path, content] of Object.entries(extraFiles)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  let manifest = { schemaVersion: 1, entries: entries.map((e) => ({ id: e.id, file: e.file, sha256: sha256(e.sql) })) };
  if (transform) manifest = transform(manifest);
  writeFileSync(join(dir, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  return dir;
}

const E = (id, sql, dir = 'migrations') => ({ id, file: `${dir}/${id}.sql`, sql });

// ---- runner ----------------------------------------------------------------

function run(dir, server, { args = ['--manifest', 'manifest.json'], env = {}, resultPath } = {}) {
  return new Promise((resolve) => {
    const result = resultPath ?? join(dir, 'result.json');
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        D1_DATABASE_NAME: DB_NAME,
        D1_DATABASE_ID: DB_ID,
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
        CLOUDFLARE_API_TOKEN: HANDLE,
        CLOUDFLARE_API_BASE_URL: server.base,
        D1_MIGRATIONS_RESULT_PATH: result,
        D1_MIGRATIONS_REQUEST_TIMEOUT_MS: '5000',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => {
      let parsed = null;
      try { parsed = JSON.parse(readFileSync(result, 'utf8')); } catch { /* none written */ }
      resolve({ code, stdout, stderr, result: parsed });
    });
  });
}

const ALL_PATHS = (server) => [...new Set(server.requests.map((r) => `${r.method} ${r.path}`))].sort();

// ---- the happy path ---------------------------------------------------------

const TRIO = [
  E('0001_posts', 'CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT);'),
  E('0002_posts_author', 'ALTER TABLE posts ADD COLUMN author TEXT;'),
  E('0003_comments', 'CREATE TABLE comments (id INTEGER PRIMARY KEY, post_id INTEGER);\nCREATE INDEX comments_post ON comments(post_id)'),
];

test('applies every entry in order from an empty ledger, through the two allowed endpoints only, and verifies the ledger', async () => {
  const d1 = await startD1();
  const dir = makeArtifact(TRIO);
  const out = await run(dir, d1);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.deepEqual(d1.ledger(), ['0001_posts', '0002_posts_author', '0003_comments']);
  assert.deepEqual(d1.tables().filter((t) => !t.startsWith('sqlite')), ['comments', 'd1_migrations', 'posts']);
  assert.deepEqual(d1.columns('posts'), ['id', 'title', 'author']);
  assert.equal(out.result.status, 'applied');
  assert.deepEqual(out.result.applied, ['0001_posts', '0002_posts_author', '0003_comments']);
  assert.deepEqual(out.result.ledgerBefore, []);
  assert.equal(out.result.manifestSha256, sha256(readFileSync(join(dir, 'manifest.json'))));
  // the ONE query endpoint is the only thing ever called: no lookup, no listing, no wrangler
  assert.deepEqual(ALL_PATHS(d1), [`POST /accounts/${ACCOUNT}/d1/database/${DB_ID}/query`]);
  assert.ok(d1.requests.every((r) => r.search === ''));
  // the grant handle is what authenticates, and it never appears in output
  assert.ok(d1.requests.every((r) => r.auth === `Bearer ${HANDLE}`));
  assert.ok(!out.stdout.includes(HANDLE) && !out.stderr.includes(HANDLE));
  assert.ok(!JSON.stringify(out.result).includes(HANDLE));
  // one write request per entry, each EXACTLY the file's bytes plus the fixed ledger suffix
  const writes = d1.writeRequests();
  assert.equal(writes.length, 3);
  TRIO.forEach((entry, i) => {
    assert.equal(writes[i].sql, entry.sql + ledgerInsertSuffix(entry.id));
    // so a broker can recover the manifest digest from the wire body alone
    const prefix = writes[i].sql.slice(0, writes[i].sql.length - ledgerInsertSuffix(entry.id).length);
    assert.equal(sha256(prefix), sha256(entry.sql));
  });
  // and every read is the one fixed ledger statement
  const reads = d1.requests.filter((r) => r.sql && /^\s*SELECT\b/i.test(r.sql));
  assert.equal(reads.length, 2, 'the ledger is read once before and once after');
  assert.ok(reads.every((r) => r.sql === LEDGER_READ_SQL));
});

test('the wire carries the file bytes untouched: no trimming, no statement splitting, whatever the file ends with', async () => {
  const awkward = [
    E('0001_a', 'CREATE TABLE a (id INTEGER);\n\n  \n'),
    E('0002_b', 'CREATE TABLE b (id INTEGER) -- no semicolon, ends in a comment'),
    E('0003_c', '-- café ✓ multi-byte comment\nCREATE TABLE c (id INTEGER);'),
  ];
  const d1 = await startD1();
  const out = await run(makeArtifact(awkward), d1);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  const writes = d1.writeRequests();
  awkward.forEach((entry, i) => assert.equal(writes[i].sql, entry.sql + ledgerInsertSuffix(entry.id)));
  assert.deepEqual(d1.ledger(), ['0001_a', '0002_b', '0003_c']);
});

test('a migration file that is not valid UTF-8 is refused before anything is contacted', async () => {
  const d1 = await startD1();
  const dir = makeArtifact(TRIO);
  const bad = Buffer.from([0x43, 0x52, 0xff, 0xfe, 0x3b]);
  writeFileSync(join(dir, 'migrations/0002_posts_author.sql'), bad);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  manifest.entries[1].sha256 = createHash('sha256').update(bad).digest('hex');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  const out = await run(dir, d1);
  assert.equal(out.code, 2, out.stdout + out.stderr);
  assert.match(out.result.error, /not valid UTF-8/);
  assert.equal(d1.requests.length, 0);
});

test('resumes at the next entry: applied entries are never executed again', async () => {
  const d1 = await startD1({
    seedLedger: ['0001_posts', '0002_posts_author'],
    seedSql: 'CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT, author TEXT);',
  });
  const dir = makeArtifact(TRIO);
  const out = await run(dir, d1);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.equal(out.result.status, 'applied');
  assert.deepEqual(out.result.applied, ['0003_comments']);
  assert.deepEqual(out.result.ledgerBefore, ['0001_posts', '0002_posts_author']);
  const writes = d1.writeRequests();
  assert.equal(writes.length, 1);
  assert.ok(!writes.some((w) => w.sql.includes('CREATE TABLE posts') || w.sql.includes('ADD COLUMN author')));
});

test('historical ledger rows without the .sql suffix still match', async () => {
  const d1 = await startD1({ seedLedger: ['0001_posts'], seedSql: 'CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT);' });
  const dir = makeArtifact(TRIO.map((e) => ({ ...e, id: e.id, file: e.file })), {
    transform: (m) => ({ ...m, entries: m.entries.map((e) => ({ ...e, id: `${e.id}.sql` })) }),
  });
  const out = await run(dir, d1);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.deepEqual(out.result.applied, ['0002_posts_author.sql', '0003_comments.sql']);
});

test('nothing pending is a clean no-op with no writes', async () => {
  const d1 = await startD1({
    seedLedger: TRIO.map((e) => e.id),
    seedSql: 'CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT, author TEXT);',
  });
  const out = await run(makeArtifact(TRIO), d1);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.equal(out.result.status, 'noop');
  assert.equal(d1.writeRequests().length, 0);
});

test('dry run lists what would apply and writes nothing, but still refuses a divergence', async () => {
  const d1 = await startD1({ seedLedger: ['0001_posts'], seedSql: 'CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT);' });
  const dir = makeArtifact(TRIO);
  const out = await run(dir, d1, { env: { D1_MIGRATIONS_DRY_RUN: '1' } });
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.equal(out.result.status, 'dry-run');
  assert.deepEqual(out.result.pending, ['0002_posts_author', '0003_comments']);
  assert.equal(d1.writeRequests().length, 0);
  assert.deepEqual(d1.ledger(), ['0001_posts']);

  const diverged = await startD1({ seedLedger: ['0001_posts', '0003_comments'] });
  const out2 = await run(makeArtifact(TRIO), diverged, { env: { D1_MIGRATIONS_DRY_RUN: '1' } });
  assert.equal(out2.code, 3, out2.stdout + out2.stderr);
  assert.equal(out2.result.divergence.kind, 'gap');
});

// ---- divergence: never replays ----------------------------------------------

test('a gap (a later entry applied while an earlier one is not) is a divergence, exit 3, nothing written', async () => {
  const d1 = await startD1({ seedLedger: ['0001_posts', '0003_comments'] });
  const out = await run(makeArtifact(TRIO), d1);
  assert.equal(out.code, 3, out.stdout + out.stderr);
  assert.equal(out.result.status, 'divergence');
  assert.deepEqual(out.result.divergence, { kind: 'gap', index: 1, expected: '0002_posts_author', actual: '0003_comments' });
  assert.equal(d1.writeRequests().length, 0);
});

test('a reorder is a divergence', async () => {
  const d1 = await startD1({ seedLedger: ['0001_posts', '0003_comments', '0002_posts_author'] });
  const out = await run(makeArtifact(TRIO), d1);
  assert.equal(out.code, 3, out.stdout + out.stderr);
  assert.equal(out.result.divergence.kind, 'reorder');
  assert.equal(d1.writeRequests().length, 0);
});

test('an applied id the manifest does not know is a divergence, before or after the manifest prefix', async () => {
  for (const seed of [['0001_posts', '9999_mystery'], ['0001_posts', '0002_posts_author', '0003_comments', '0004_extra']]) {
    const d1 = await startD1({ seedLedger: seed });
    const out = await run(makeArtifact(TRIO), d1);
    assert.equal(out.code, 3, out.stdout + out.stderr);
    assert.equal(out.result.divergence.kind, 'unknown-applied');
    assert.equal(d1.writeRequests().length, 0);
  }
});

test('a missing ledger table is a divergence: the mode never guesses where the database is', async () => {
  const d1 = await startD1({ ledger: 'none' });
  const out = await run(makeArtifact(TRIO), d1);
  assert.equal(out.code, 3, out.stdout + out.stderr);
  assert.equal(out.result.divergence.kind, 'ledger-missing');
  assert.equal(d1.writeRequests().length, 0);
});

test('a digest mismatch is a divergence found before the database is contacted at all', async () => {
  const d1 = await startD1();
  const dir = makeArtifact(TRIO);
  writeFileSync(join(dir, 'migrations/0002_posts_author.sql'), 'ALTER TABLE posts ADD COLUMN tampered TEXT;');
  const out = await run(dir, d1);
  assert.equal(out.code, 3, out.stdout + out.stderr);
  assert.equal(out.result.divergence.kind, 'digest-mismatch');
  assert.equal(out.result.divergence.index, 1);
  assert.equal(d1.requests.length, 0);
});

// The fronts-data R17 case. @growth-labs/analytics migrations 0002-0004 were
// applied to fronts-data a second time as fronts 0029/0030/0032, each a
// non-idempotent ALTER. A name-set diff sees the analytics names as "pending"
// and replays them; the ALTERs then fail (or, on other engines, double-apply).
const ANALYTICS = [
  E('analytics-0002_add_views', 'ALTER TABLE events ADD COLUMN views INTEGER DEFAULT 0;', 'analytics'),
  E('analytics-0003_add_source', 'ALTER TABLE events ADD COLUMN source TEXT;', 'analytics'),
  E('analytics-0004_add_country', 'ALTER TABLE events ADD COLUMN country TEXT;', 'analytics'),
];
// the same effects, recorded under fronts' own names with different bytes
const FRONTS_DUPES = [
  E('0029_events_views', '-- fronts copy of analytics 0002\nALTER TABLE events ADD COLUMN views INTEGER DEFAULT 0;'),
  E('0030_events_source', '-- fronts copy of analytics 0003\nALTER TABLE events ADD COLUMN source TEXT;'),
  E('0032_events_country', '-- fronts copy of analytics 0004\nALTER TABLE events ADD COLUMN country TEXT;'),
];
const FRONTS_BASE = [E('0001_events', 'CREATE TABLE events (id INTEGER PRIMARY KEY, kind TEXT);')];
const R17_DB_SQL = 'CREATE TABLE events (id INTEGER PRIMARY KEY, kind TEXT, views INTEGER DEFAULT 0, source TEXT, country TEXT);';
const R17_LEDGER = ['0001_events', '0029_events_views', '0030_events_source', '0032_events_country'];

test('R17 trap: a manifest listing analytics 0002-0004 while the ledger holds fronts 0029/0030/0032 diverges and never replays the ALTERs', async () => {
  const d1 = await startD1({ seedLedger: R17_LEDGER, seedSql: R17_DB_SQL });
  const dir = makeArtifact([...FRONTS_BASE, ...ANALYTICS]);
  const out = await run(dir, d1);
  assert.equal(out.code, 3, out.stdout + out.stderr);
  assert.equal(out.result.divergence.kind, 'unknown-applied');
  assert.equal(out.result.divergence.actual, '0029_events_views');
  assert.equal(d1.writeRequests().length, 0, 'not one ALTER reached the database');
  assert.deepEqual(d1.columns('events'), ['id', 'kind', 'views', 'source', 'country']);
  assert.deepEqual(d1.ledger(), R17_LEDGER);
});

test('R17 trap: byte-identical SQL listed under two names is refused as an invalid manifest before any network call', async () => {
  const twin = (e, dir) => ({ ...e, id: `dup-${e.id}`, file: `${dir}/dup-${e.id}.sql` });
  const d1 = await startD1();
  const dir = makeArtifact([...FRONTS_BASE, ...ANALYTICS, twin(ANALYTICS[0], 'fronts')]);
  const out = await run(dir, d1);
  assert.equal(out.code, 2, out.stdout + out.stderr);
  assert.match(out.result.error, /same sha256/);
  assert.equal(d1.requests.length, 0);
});

test('R17: a correct fronts-data manifest (each effect once, in ledger order) applies only the new entry', async () => {
  const d1 = await startD1({ seedLedger: R17_LEDGER, seedSql: R17_DB_SQL });
  const newEntry = E('0033_events_index', 'CREATE INDEX events_kind ON events(kind);');
  const dir = makeArtifact([...FRONTS_BASE, ...FRONTS_DUPES, newEntry]);
  const out = await run(dir, d1);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.deepEqual(out.result.applied, ['0033_events_index']);
  assert.equal(d1.writeRequests().length, 1);
  assert.deepEqual(d1.ledger(), [...R17_LEDGER, '0033_events_index']);
});

// ---- failure and ambiguity ---------------------------------------------------

test('an entry the database refuses fails the run, rolls back the whole entry, and leaves the prefix intact for a corrected retry', async () => {
  const d1 = await startD1();
  const bad = E('0002_bad', 'CREATE TABLE half_done (id INTEGER);\nALTER TABLE does_not_exist ADD COLUMN x TEXT;');
  const dir = makeArtifact([TRIO[0], bad, TRIO[2]]);
  const out = await run(dir, d1);
  assert.equal(out.code, 1, out.stdout + out.stderr);
  assert.equal(out.result.status, 'failed');
  assert.equal(out.result.failedAt, '0002_bad');
  assert.deepEqual(out.result.applied, ['0001_posts']);
  assert.deepEqual(d1.ledger(), ['0001_posts']);
  assert.ok(!d1.tables().includes('half_done'), 'the batch is all-or-nothing: no half-applied entry');
  assert.equal(d1.writeRequests().length, 2, 'nothing after the failed entry is attempted');

  // corrected retry: the same ledger is still an exact prefix, entry 0001 is not replayed
  const fixed = E('0002_bad', 'CREATE TABLE half_done (id INTEGER);');
  const retry = makeArtifact([TRIO[0], fixed]);
  const out2 = await run(retry, d1);
  assert.equal(out2.code, 0, out2.stdout + out2.stderr);
  assert.deepEqual(out2.result.applied, ['0002_bad']);
});

test('a dropped connection after the database executed is ambiguous (exit 4), attempts nothing further, and the next run resolves it from the ledger', async () => {
  const d1 = await startD1({ hooks: { afterWrite: (n) => (n === 2 ? 'drop' : null) } });
  const dir = makeArtifact(TRIO);
  const out = await run(dir, d1);
  assert.equal(out.code, 4, out.stdout + out.stderr);
  assert.equal(out.result.status, 'ambiguous');
  assert.equal(out.result.ambiguousAt, '0002_posts_author');
  assert.deepEqual(out.result.applied, ['0001_posts']);
  assert.equal(d1.writeRequests().length, 2, 'entry 3 is never attempted after an unknown outcome');
  // the batch did commit: the ledger says so, and the next run continues from it
  assert.deepEqual(d1.ledger(), ['0001_posts', '0002_posts_author']);
  const next = await run(dir, d1);
  assert.equal(next.code, 0, next.stdout + next.stderr);
  assert.deepEqual(next.result.applied, ['0003_comments']);
  assert.deepEqual(d1.columns('posts'), ['id', 'title', 'author'], 'the ALTER ran exactly once');
});

test('a dropped connection before the database executed is ambiguous, and the retry applies the entry once', async () => {
  const d1 = await startD1({ hooks: { beforeWrite: (n) => (n === 2 ? 'drop' : null) } });
  const dir = makeArtifact(TRIO);
  const out = await run(dir, d1);
  assert.equal(out.code, 4, out.stdout + out.stderr);
  assert.equal(out.result.ambiguousAt, '0002_posts_author');
  assert.deepEqual(d1.ledger(), ['0001_posts']);
  const next = await run(dir, d1);
  assert.equal(next.code, 0, next.stdout + next.stderr);
  assert.deepEqual(d1.ledger(), TRIO.map((e) => e.id));
});

test('a 5xx answer is ambiguous, not failed', async () => {
  const d1 = await startD1({ hooks: { beforeWrite: (n) => (n === 1 ? '502' : null) } });
  const out = await run(makeArtifact(TRIO), d1);
  assert.equal(out.code, 4, out.stdout + out.stderr);
  assert.equal(out.result.ambiguousAt, '0001_posts');
  assert.equal(d1.writeRequests().length, 1);
});

test('a final ledger that is not the expected prefix is ambiguous even though every request answered success', async () => {
  // the third ledger read (after apply) is tampered: reads are (1) before, (2) after
  const d1 = await startD1({ hooks: { onRead: (n) => (n === 2 ? [{ id: 1, name: '0001_posts' }] : null) } });
  const out = await run(makeArtifact(TRIO), d1);
  assert.equal(out.code, 4, out.stdout + out.stderr);
  assert.equal(out.result.status, 'ambiguous');
  assert.deepEqual(out.result.applied, ['0001_posts', '0002_posts_author', '0003_comments']);
});

test('a redirect from the API host is refused, never followed', async () => {
  const d1 = await startD1({ hooks: { redirectQuery: true } });
  const out = await run(makeArtifact(TRIO), d1);
  assert.equal(out.code, 1, out.stdout + out.stderr);
  assert.equal(d1.requests.length, 1, 'the redirect target was never contacted');
  assert.equal(d1.writeRequests().length, 0);
});

// ---- invalid input: exit 2, nothing contacted ---------------------------------

function invalid(name, build, pattern) {
  test(`invalid manifest: ${name}`, async () => {
    const d1 = await startD1();
    const dir = build();
    const out = await run(dir, d1);
    assert.equal(out.code, 2, out.stdout + out.stderr);
    assert.equal(out.result.status, 'invalid');
    assert.match(out.result.error, pattern);
    assert.equal(d1.requests.length, 0);
  });
}

invalid('no entries', () => makeArtifact([], { transform: () => ({ schemaVersion: 1, entries: [] }) }), /no entries/);
invalid('not JSON', () => makeArtifact(TRIO, { transform: () => '{nope' }), /not valid JSON/);
invalid('unsupported schemaVersion', () => makeArtifact(TRIO, { transform: (m) => ({ ...m, schemaVersion: 2 }) }), /schemaVersion/);
invalid('unknown top-level field', () => makeArtifact(TRIO, { transform: (m) => ({ ...m, extra: 1 }) }), /unrecognized field/);
invalid('unknown entry field', () => makeArtifact(TRIO, { transform: (m) => ({ ...m, entries: m.entries.map((e) => ({ ...e, apply: false })) }) }), /unrecognized field/);
invalid('id with a quote', () => makeArtifact(TRIO, { transform: (m) => ({ ...m, entries: [{ ...m.entries[0], id: "0001'; DROP TABLE x; --" }] }) }), /invalid id/);
invalid('uppercase digest', () => makeArtifact(TRIO, { transform: (m) => ({ ...m, entries: m.entries.map((e) => ({ ...e, sha256: e.sha256.toUpperCase() })) }) }), /sha256 must be/);
invalid('absolute file', () => makeArtifact(TRIO, { transform: (m) => ({ ...m, entries: [{ ...m.entries[0], file: '/etc/passwd.sql' }] }) }), /relative/);
invalid('parent traversal', () => makeArtifact(TRIO, { transform: (m) => ({ ...m, entries: [{ ...m.entries[0], file: '../outside.sql' }] }) }), /no "\.\."/);
invalid('not a .sql file', () => makeArtifact(TRIO, { transform: (m) => ({ ...m, entries: [{ ...m.entries[0], file: 'manifest.json' }] }) }), /\.sql/);
invalid('missing file', () => makeArtifact(TRIO, { transform: (m) => ({ ...m, entries: [{ ...m.entries[0], file: 'migrations/absent.sql' }] }) }), /does not exist/);
invalid('duplicate id (with and without .sql)', () => makeArtifact(TRIO, { transform: (m) => ({ ...m, entries: [m.entries[0], { ...m.entries[1], id: `${m.entries[0].id}.sql` }] }) }), /repeats entry/);
invalid('same file twice', () => makeArtifact(TRIO, { transform: (m) => ({ ...m, entries: [m.entries[0], { ...m.entries[0], id: 'other' }] }) }), /repeats the file/);
invalid('symlinked file', () => {
  const dir = makeArtifact(TRIO, { extraFiles: { 'elsewhere/real.sql': 'SELECT 1;' } });
  rmSync(join(dir, 'migrations/0001_posts.sql'));
  symlinkSync(join(dir, 'elsewhere/real.sql'), join(dir, 'migrations/0001_posts.sql'));
  return dir;
}, /symlink/);

test('refuses to combine with reset-and-replay or a replay manifest, and needs a database uuid, account id and token; the database name is optional', async () => {
  const d1 = await startD1();
  const dir = makeArtifact(TRIO);
  for (const env of [
    { D1_MIGRATIONS_RESET_AND_REPLAY: '1' },
    { D1_MIGRATIONS_REPLAY_MANIFEST_PATH: 'manifest.json' },
    { D1_DATABASE_ID: 'not-a-uuid' },
    { D1_DATABASE_ID: '' },
    { CLOUDFLARE_ACCOUNT_ID: 'short' },
    { CLOUDFLARE_API_TOKEN: '' },
  ]) {
    const out = await run(dir, d1, { env });
    assert.equal(out.code, 2, `${JSON.stringify(env)}: ${out.stdout}${out.stderr}`);
  }
  assert.equal(d1.requests.length, 0);
  const nameless = await run(dir, d1, { env: { D1_DATABASE_NAME: '' } });
  assert.equal(nameless.code, 0, nameless.stdout + nameless.stderr);
});

test('--database-id: the flag alone addresses the database, and a conflict with D1_DATABASE_ID is refused', async () => {
  const d1 = await startD1();
  const dir = makeArtifact(TRIO);
  const byFlag = await run(dir, d1, { args: ['--manifest', 'manifest.json', '--database-id', DB_ID], env: { D1_DATABASE_ID: '' } });
  assert.equal(byFlag.code, 0, byFlag.stdout + byFlag.stderr);
  assert.equal(byFlag.result.database.id, DB_ID);
  const writesBefore = d1.requests.length;
  const conflict = await run(dir, d1, { args: ['--manifest', 'manifest.json', '--database-id', '99999999-2222-4333-8444-555555555555'] });
  assert.equal(conflict.code, 2, conflict.stdout + conflict.stderr);
  assert.match(conflict.result.error, /different databases/);
  const same = await run(dir, d1, { args: [`--database-id=${DB_ID}`, '--manifest=manifest.json'] });
  assert.equal(same.code, 0, same.stdout + same.stderr);
  assert.equal(d1.requests.length > writesBefore, true);
  for (const args of [['--manifest', 'manifest.json', '--database-id'], ['--manifest', 'manifest.json', '--database-id='], ['--manifest', 'manifest.json', '--database-id', DB_ID, '--database-id', DB_ID]]) {
    const out = await run(dir, d1, { args });
    assert.equal(out.code, 2, `${JSON.stringify(args)}: ${out.stdout}${out.stderr}`);
  }
});

test('--manifest flag parsing: missing, empty, repeated and unknown-alongside are refused; --manifest=path works', async () => {
  const d1 = await startD1();
  const dir = makeArtifact(TRIO);
  for (const args of [['--manifest'], ['--manifest', ''], ['--manifest=' ], ['--manifest', 'manifest.json', '--manifest', 'manifest.json'], ['--manifest', 'manifest.json', '--force']]) {
    const out = await run(dir, d1, { args });
    assert.equal(out.code, 2, `${JSON.stringify(args)}: ${out.stdout}${out.stderr}`);
  }
  assert.equal(d1.requests.length, 0);
  const ok = await run(dir, d1, { args: ['--manifest=manifest.json'] });
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
});

test('the result file is optional: without D1_MIGRATIONS_RESULT_PATH nothing is written and the run still succeeds', async () => {
  const d1 = await startD1();
  const dir = makeArtifact(TRIO);
  const out = await run(dir, d1, { env: { D1_MIGRATIONS_RESULT_PATH: '' }, resultPath: join(dir, 'never-written.json') });
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.equal(existsSync(join(dir, 'never-written.json')), false);
});

// ---- the legacy mode is untouched ---------------------------------------------

test('without --manifest the legacy path is unchanged: it still demands its own environment and ignores unrelated arguments', async () => {
  const d1 = await startD1();
  const dir = makeArtifact(TRIO);
  const out = await run(dir, d1, { args: ['--something-else'], env: { D1_DATABASE_NAME: '' } });
  assert.equal(out.code, 1);
  assert.match(out.stderr, /D1_DATABASE_NAME is required/);
  assert.equal(d1.requests.length, 0);
});

test('the reusable workflow never selects manifest mode: it does not pass --manifest, so its callers keep the legacy path', () => {
  const workflow = readFileSync(join(dirname(SCRIPT), '..', 'workflows', 'd1-migrations-apply.yml'), 'utf8');
  assert.ok(!workflow.includes('--manifest'));
});

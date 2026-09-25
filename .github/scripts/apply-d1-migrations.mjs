#!/usr/bin/env node
// Apply any unapplied D1 migrations to the configured database.
//
// Reads migrations/*.sql from the consumer repo's working directory,
// compares against the `d1_migrations` table on the remote D1, and for
// each missing file: runs `wrangler d1 execute --file=` then INSERTs
// into d1_migrations. Exits non-zero on the first failure so the GitHub
// workflow goes red.
//
// `d1_migrations` is the same registry that `wrangler d1 migrations
// apply` uses, but we don't call that command — some Fulcrum D1s have
// historical drift (entries missing for migrations applied manually).
// One-off drift is backfilled per-database before this workflow is
// enabled; from then on this script is the only thing that should
// INSERT into d1_migrations.
//
// Why this lives in shared-workflows: every Fulcrum producer repo has
// the same shape (migrations/*.sql + Cloudflare Builds deploy). Without
// auto-apply, every new column-add merge risks a fronts-style outage
// (KB fronts-d1-migration-and-monitoring-gap-2026-05-25). Consumer
// repos opt in by adding a thin wrapper workflow that calls
// fulcrum-labs/shared-workflows/.github/workflows/d1-migrations-apply.yml
// with their D1_DATABASE_NAME and CLOUDFLARE_ACCOUNT_ID.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const DB_NAME = process.env.D1_DATABASE_NAME;
const MIGRATIONS_DIR = process.env.D1_MIGRATIONS_DIR || "migrations";
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
// Optional: verified below, before any D1 interaction at all, whenever set.
// Existing callers that predate this input simply don't set it and get no
// verification, exactly as before this existed. A staging wrapper should
// always set it (platform-foundations' generator does), since name is
// otherwise the ONLY selector against the same account and the same token
// as prod -- a staging config block that accidentally carried prod's uuid
// would otherwise silently write prod.
const DATABASE_ID = process.env.D1_DATABASE_ID || "";
// List pending migrations and exit 0 without applying anything or writing
// to d1_migrations. Read-only end to end (the ledger SELECT above already
// runs either way) -- for a staging catch-up dispatch previewing what
// apply-missing would do before committing to it.
const DRY_RUN = process.env.D1_MIGRATIONS_DRY_RUN === "1";
// Reset-then-replay (M2-19 R17): drop every object in the target D1, then
// fall through to the normal apply-missing loop below against the now-empty
// ledger, so it applies every migration file from scratch. Never wired to
// anything but the platform-foundations staging wrapper -- the four guards
// immediately below exist because this drops data irreversibly and this
// script has no other caller today that should ever set it.
const RESET_AND_REPLAY = process.env.D1_MIGRATIONS_RESET_AND_REPLAY === "1";
// Required (and checked) only when RESET_AND_REPLAY is set; both stay
// unvalidated and unused for every existing apply-missing caller.
const CONFIRM = process.env.D1_MIGRATIONS_CONFIRM || "";
const PROD_DATABASE_NAME = process.env.D1_MIGRATIONS_PROD_DATABASE_NAME || "";
// M2-19 R17: only meaningful alongside RESET_AND_REPLAY -- see the guard
// below. A repo-relative path (resolved from the consumer repo's checkout
// root, same cwd every other relative path in this script already assumes)
// to a checked-in JSON file replacing the default "read MIGRATIONS_DIR
// alphabetically" behaviour with an explicit ordered list. Empty keeps every
// existing caller (and every apply-missing caller) reading MIGRATIONS_DIR
// alphabetically, exactly as before this existed.
const REPLAY_MANIFEST_PATH = process.env.D1_MIGRATIONS_REPLAY_MANIFEST_PATH || "";

if (!DB_NAME) throw new Error("D1_DATABASE_NAME is required");
if (!ACCOUNT_ID) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
if (!API_TOKEN) throw new Error("CLOUDFLARE_API_TOKEN is required");

// Guard 0: replay-manifest-path is only meaningful alongside reset-and-replay
// -- an apply-missing run against a possibly non-empty, real ledger has no
// safe reading of an apply:false "already covered by a differently-named
// entry" row (it would either insert a phantom ledger row for a migration
// this database never actually needed, or silently skip a real one). Checked
// unconditionally, before every other guard, so a caller can never combine
// the two incorrectly regardless of how reset-and-replay itself resolves.
if (REPLAY_MANIFEST_PATH && !RESET_AND_REPLAY) {
	throw new Error(
		"replay-manifest-path was supplied without reset-and-replay -- refusing: " +
			"it only has a safe reading for a full replay against an empty ledger",
	);
}

// Guard 1+2: name shape. Checked before any network call, even the
// database-id verification below -- a target that fails these two is wrong
// regardless of what its uuid turns out to be.
if (RESET_AND_REPLAY) {
	if (!/-staging$/.test(DB_NAME)) {
		throw new Error(
			`reset-and-replay refuses: database-name "${DB_NAME}" does not end in -staging`,
		);
	}
	if (!PROD_DATABASE_NAME) {
		throw new Error(
			"reset-and-replay refuses: prod-database-name was not supplied, so target != prod cannot be proven",
		);
	}
	if (DB_NAME === PROD_DATABASE_NAME) {
		throw new Error(
			`reset-and-replay refuses: database-name "${DB_NAME}" equals prod-database-name -- refusing to drop prod`,
		);
	}
	// Guard 3 (database-id == the id resolved from the name) is the existing
	// verifyDatabaseId() check below, made mandatory for this mode: an empty
	// DATABASE_ID silently no-ops that check for every other caller, which
	// reset-and-replay cannot tolerate.
	if (!DATABASE_ID) {
		throw new Error(
			"reset-and-replay refuses: database-id was not supplied, so it cannot be verified against database-name",
		);
	}
	// Guard 4: typed confirm, exact match, no normalization.
	if (CONFIRM !== DB_NAME) {
		throw new Error(
			`reset-and-replay refuses: confirm ("${CONFIRM}") does not exactly match database-name ("${DB_NAME}")`,
		);
	}
}

const log = (...parts) => console.log("[d1-migrations]", ...parts);

// wrangler resolves `database-name` to a database through the consumer's
// wrangler config; the name is the only selector it ever checks. Verify the
// name actually resolves to the uuid the caller declared, via the plain
// Cloudflare REST list endpoint (read-only, no wrangler needed) -- BEFORE
// any D1 interaction, including the ledger SELECT below, and regardless of
// DRY_RUN (the whole point of a preview is confirming the target is right
// before committing to anything).
// Overridable only so tests can point this at a local fixture server instead
// of the real Cloudflare API; every real caller gets the real base URL.
const CF_API_BASE =
	process.env.D1_MIGRATIONS_CF_API_BASE_FOR_TESTS_ONLY ||
	"https://api.cloudflare.com/client/v4";

async function verifyDatabaseId() {
	if (!DATABASE_ID) return;
	const url = `${CF_API_BASE}/accounts/${ACCOUNT_ID}/d1/database?name=${encodeURIComponent(DB_NAME)}`;
	const response = await fetch(url, {
		headers: { Authorization: `Bearer ${API_TOKEN}` },
	});
	if (!response.ok) {
		throw new Error(
			`D1 database lookup failed for "${DB_NAME}" on account ${ACCOUNT_ID}: HTTP ${response.status} ${await response.text()}`,
		);
	}
	const body = await response.json();
	// The list endpoint's `name` filter is a substring match, not exact --
	// confirmed live (querying "fronts-data" also returned
	// "fronts-data-staging" and "homefronts-data-staging"). Filter to the
	// exact name client-side; never trust the query param to have done it.
	const results = Array.isArray(body?.result) ? body.result : [];
	const match = results.find((db) => db.name === DB_NAME);
	if (!match) {
		throw new Error(
			`D1 database "${DB_NAME}" was not found (exact name) on account ${ACCOUNT_ID} -- refusing to apply against an unverified target`,
		);
	}
	if (match.uuid !== DATABASE_ID) {
		throw new Error(
			`D1 database "${DB_NAME}" resolves to uuid ${match.uuid}, but the caller declared database-id ${DATABASE_ID} -- ` +
				"refusing to apply against a mismatched target (this is exactly what a staging config block accidentally " +
				"carrying prod's uuid would otherwise let through silently)",
		);
	}
	log(`verified "${DB_NAME}" resolves to the declared uuid ${DATABASE_ID}`);
}

await verifyDatabaseId();

// The API-list verification above proves the ACCOUNT has a database named
// DB_NAME with uuid DATABASE_ID. It does NOT prove `wrangler d1 execute
// DB_NAME` actually TARGETS that uuid: wrangler resolves DB_NAME through
// the CONSUMER REPO's own checked-out wrangler.toml/json first, matching
// by database_name (or binding) and then using THAT entry's database_id --
// never re-resolving against the live account. A consumer's wrangler
// config mapping the staging name to prod's id would pass the check above
// and still write prod. Once DATABASE_ID is set, every wrangler d1 call
// below is pinned to a generated, minimal config containing ONLY the one
// verified {name, id} pair, so the consumer's own config can never
// intervene in what gets targeted.
const WRANGLER_CONFIG_ARGS = DATABASE_ID
	? (() => {
			const configDir = mkdtempSync(
				join(process.env.RUNNER_TEMP || tmpdir(), "d1-migrations-config-"),
			);
			// Self-hosted runners are persistent, not ephemeral containers --
			// nothing else removes a leftover mkdtempSync directory between
			// runs. Cleaned up unconditionally on exit (covers a thrown error
			// or an early process.exit(), not just the success path a bare
			// `finally` around the rest of the script would miss).
			process.on("exit", () => {
				rmSync(configDir, { recursive: true, force: true });
			});
			const configPath = join(configDir, "wrangler.json");
			writeFileSync(
				configPath,
				JSON.stringify({
					d1_databases: [
						{ binding: "DB", database_name: DB_NAME, database_id: DATABASE_ID },
					],
				}),
			);
			log(
				`pinning every wrangler d1 call to a generated config: database_name=${DB_NAME} database_id=${DATABASE_ID}`,
			);
			return ["--config", configPath];
		})()
	: [];

// Self-hosted runners do not expose the global npm bin dir on PATH, so a bare
// "wrangler" spawn ENOENTs there. The workflow resolves the absolute binary
// path at install time and passes it via WRANGLER_BIN.
const WRANGLER_BIN = process.env.WRANGLER_BIN || "wrangler";

const wranglerJson = (args) => {
	const out = execFileSync(WRANGLER_BIN, [...args, ...WRANGLER_CONFIG_ARGS], {
		encoding: "utf8",
		env: { ...process.env, NO_COLOR: "1" },
		stdio: ["ignore", "pipe", "inherit"],
	});
	// wrangler emits a banner before JSON; isolate the first '[' or '{'.
	const start = Math.min(
		...["[", "{"].map((c) => {
			const i = out.indexOf(c);
			return i === -1 ? Number.POSITIVE_INFINITY : i;
		}),
	);
	if (!Number.isFinite(start)) {
		throw new Error(`wrangler returned no JSON:\n${out}`);
	}
	return JSON.parse(out.slice(start));
};

const wrangler = (args) =>
	execFileSync(WRANGLER_BIN, [...args, ...WRANGLER_CONFIG_ARGS], {
		encoding: "utf8",
		env: { ...process.env, NO_COLOR: "1" },
		stdio: ["ignore", "inherit", "inherit"],
	});

const sqlEscape = (value) => value.replace(/'/g, "''");
const quoteIdentifier = (name) => `"${name.replace(/"/g, '""')}"`;

// A wrangler.d1.execute() read helper for the FK-graph queries below --
// same shape as wranglerJson, kept separate so those call sites read as
// "one FK-list read per table", not folded into the bigger enumeration call.
const fkListForTable = (table) =>
	wranglerJson([
		"d1",
		"execute",
		DB_NAME,
		"--remote",
		"--json",
		"--command",
		`PRAGMA foreign_key_list(${quoteIdentifier(table)})`,
	])?.[0]?.results || [];

// Kahn's algorithm: an order where, for every edge child->parent (the child
// holds a FK referencing the parent, so it must be dropped first), the
// child appears before the parent. Throws -- refusing the reset outright,
// never guessing -- on any cycle, since a cyclic FK graph among tables has
// no drop order that avoids violating one of them.
function topoSortDropOrder(tableNames, edges) {
	// SQLite table names are case-insensitive, but PRAGMA foreign_key_list's
	// `table` column is spelled exactly as written in the REFERENCES clause
	// -- `REFERENCES Users(id)` against an actual table `users` would
	// otherwise silently fail an exact-string Map lookup below and lose the
	// ordering constraint entirely (the reset would then abort partway,
	// loudly, but still abort). Resolve both sides of an edge through this
	// case-insensitive lookup; the DROP statements themselves still use
	// tableNames' own (real, as-enumerated) casing, untouched by this.
	const byLowerName = new Map(tableNames.map((t) => [t.toLowerCase(), t]));
	const inDegree = new Map(tableNames.map((t) => [t, 0]));
	const dependents = new Map(tableNames.map((t) => [t, []]));
	for (const { child, parent } of edges) {
		const childName = byLowerName.get(child.toLowerCase());
		const parentName = byLowerName.get(parent.toLowerCase());
		if (!childName || !parentName) continue; // references a table outside this drop set (already excluded/handled)
		if (childName === parentName) continue; // self-reference: no cross-table ordering constraint
		dependents.get(childName).push(parentName);
		inDegree.set(parentName, inDegree.get(parentName) + 1);
	}
	const queue = tableNames.filter((t) => inDegree.get(t) === 0);
	const order = [];
	while (queue.length > 0) {
		const node = queue.shift();
		order.push(node);
		for (const next of dependents.get(node)) {
			inDegree.set(next, inDegree.get(next) - 1);
			if (inDegree.get(next) === 0) queue.push(next);
		}
	}
	if (order.length !== tableNames.length) {
		const unresolved = tableNames.filter((t) => !order.includes(t));
		throw new Error(
			`reset-and-replay refuses: a foreign-key cycle among tables prevents a safe drop order (unresolved: ${unresolved.join(", ")})`,
		);
	}
	return order;
}

// Reset-and-replay's actual destructive step: enumerate every object in
// sqlite_master and drop them, INCLUDING d1_migrations -- emptying the
// database's contents without ever touching the D1 resource itself, so its
// uuid (and therefore every wrangler.toml/manifest binding pinned to it,
// including this script's own database-id verification above) never
// changes. Recreating the database instead of emptying it would mint a new
// uuid and break that pin.
//
// Excludes (escaped -- bare `_` is itself a LIKE wildcard, so an unescaped
// pattern is not the literal match it looks like): sqlite_% (SQLite's own
// bookkeeping, e.g. sqlite_sequence) and _cf_% (D1's own internal tables --
// D1 refuses a DROP on these with SQLITE_AUTH, which would abort the reset
// partway through if they were included).
//
// A DROP TABLE on an FTS5 virtual table cascades to its own shadow tables
// (e.g. `_fts_data`, `_fts_idx`) automatically; this enumeration lists those
// shadow tables too (they're ordinary rows in sqlite_master), but dropping
// them explicitly afterward is a harmless IF EXISTS no-op either way this
// enumeration or the cascade gets to them first -- no separate exclusion
// needed.
//
// Drop order: d1_migrations FIRST, on its own -- so that a failure ANYWHERE
// later in this same run still leaves a database with no ledger, and a
// later plain apply-missing dispatch fails loudly ("no such table:
// d1_migrations") instead of reading a stale-but-present ledger and
// silently declaring "nothing to apply" against a partially-dropped
// schema. Then triggers and views (neither blocks any other drop, and
// SQLite doesn't validate a view's referenced table until the view is
// queried), then indexes, then the remaining tables last, in FK-topological
// order (children before parents) -- refusing outright on a cycle rather
// than guessing.
async function resetDatabase() {
	const rawObjects =
		wranglerJson([
			"d1",
			"execute",
			DB_NAME,
			"--remote",
			"--json",
			"--command",
			"SELECT type, name FROM sqlite_master WHERE type IN ('table','view','index','trigger')" +
				" AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'" +
				" AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
		])?.[0]?.results || [];

	// Defence in depth alongside the (escaped, correct) SQL WHERE clause
	// above: a plain, unambiguous JS prefix check, not a re-implementation
	// of SQL LIKE semantics -- so a future edit that silently drops or
	// re-breaks the SQL-side ESCAPE clause still can't let a _cf_*/sqlite_*
	// name through to a DROP.
	const objects = rawObjects.filter(
		(o) => !o.name.startsWith("_cf_") && !o.name.startsWith("sqlite_"),
	);

	const withoutLedger = objects.filter((o) => !(o.type === "table" && o.name === "d1_migrations"));
	const ledgerPresent = withoutLedger.length !== objects.length;

	const triggers = withoutLedger.filter((o) => o.type === "trigger");
	const views = withoutLedger.filter((o) => o.type === "view");
	const indexes = withoutLedger.filter((o) => o.type === "index");
	const tableNames = withoutLedger.filter((o) => o.type === "table").map((o) => o.name);

	const fkEdges = [];
	for (const table of tableNames) {
		for (const row of fkListForTable(table)) {
			if (row.table) fkEdges.push({ child: table, parent: row.table });
		}
	}
	const orderedTableNames = topoSortDropOrder(tableNames, fkEdges);

	const dropStatements = [
		...(ledgerPresent ? [`DROP TABLE IF EXISTS ${quoteIdentifier("d1_migrations")}`] : []),
		...triggers.map((o) => `DROP TRIGGER IF EXISTS ${quoteIdentifier(o.name)}`),
		...views.map((o) => `DROP VIEW IF EXISTS ${quoteIdentifier(o.name)}`),
		...indexes.map((o) => `DROP INDEX IF EXISTS ${quoteIdentifier(o.name)}`),
		...orderedTableNames.map((name) => `DROP TABLE IF EXISTS ${quoteIdentifier(name)}`),
	];

	if (dropStatements.length === 0) {
		log("reset-and-replay: database already empty, nothing to drop");
	} else {
		log(
			`reset-and-replay: would drop ${dropStatements.length} object(s): ${[
				...(ledgerPresent ? ["table d1_migrations"] : []),
				...triggers.map((o) => `trigger ${o.name}`),
				...views.map((o) => `view ${o.name}`),
				...indexes.map((o) => `index ${o.name}`),
				...orderedTableNames.map((name) => `table ${name}`),
			].join(", ")}`,
		);
	}

	if (DRY_RUN) {
		log("dry run: not dropping anything (D1_MIGRATIONS_DRY_RUN=1)");
		process.exit(0);
	}

	// Every drop, the FK-defer PRAGMA, and the ledger re-create run from ONE
	// file via a single `wrangler d1 execute --file` call, under RUNNER_TEMP
	// (self-hosted runners are persistent, so this is removed explicitly on
	// exit, same as the generated wrangler-config pin elsewhere in this
	// script) -- not one call per statement, and not an inline --command
	// string. defer_foreign_keys is scoped to the transaction it runs in and
	// resets at that transaction's end, so it has to be the first statement
	// in this SAME file to matter at all -- and it only CAN matter if D1
	// runs this whole file as one transaction. If D1 instead auto-commits
	// each statement individually, defer_foreign_keys is a harmless no-op
	// here (there is no multi-statement transaction for it to defer within),
	// and the FK-topological drop order above is what actually makes the
	// drops safe either way -- kept regardless, since it costs nothing and
	// helps if the whole-file-as-one-transaction case does hold.
	const batchDir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "d1-reset-batch-"));
	process.on("exit", () => {
		rmSync(batchDir, { recursive: true, force: true });
	});
	const batchPath = join(batchDir, "reset.sql");
	const statements = [
		"PRAGMA defer_foreign_keys = true",
		...dropStatements,
		// Same shape wrangler's own `d1 migrations apply` creates it with, so
		// a migration file that itself queries d1_migrations (none do today,
		// but nothing stops one) sees the same schema either way.
		"CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
	];
	writeFileSync(batchPath, `${statements.join(";\n")};\n`);

	try {
		wrangler(["d1", "execute", DB_NAME, "--remote", "--file", batchPath]);
	} catch (error) {
		log(`RESET FAILED: ${error?.message || error}`);
		log(
			"reset-and-replay: the drop-and-recreate batch failed partway. d1_migrations was dropped FIRST " +
				"in this same file specifically so that, whatever this database's actual state is now, a " +
				"later plain apply-missing dispatch will fail loudly (no such table: d1_migrations) rather " +
				"than silently trusting a stale ledger against a partially-dropped schema -- but do NOT " +
				"dispatch one anyway. An operator must confirm this database's actual state by hand " +
				"(enumerate sqlite_master) before anything else runs against it.",
		);
		process.exit(1);
	}
	log("reset-and-replay: dropped and re-created an empty d1_migrations; replaying every migration from scratch");
}

// Loads and validates the checked-in replay manifest. Never guesses at a
// malformed shape -- an empty/missing entries array, or an entry with no
// (non-empty string) path, is a hard refusal, and (see the call site below)
// this runs BEFORE resetDatabase(), so a malformed manifest is caught before
// the irreversible drop, not after it.
function loadReplayManifest(manifestPath) {
	const resolved = resolve(manifestPath);
	const raw = JSON.parse(readFileSync(resolved, "utf8"));
	const entries = Array.isArray(raw) ? raw : raw?.entries;
	if (!Array.isArray(entries) || entries.length === 0) {
		throw new Error(`replay-manifest-path "${manifestPath}" contains no entries`);
	}
	return entries.map((entry, index) => {
		if (!entry || typeof entry.path !== "string" || entry.path === "") {
			throw new Error(
				`replay-manifest-path "${manifestPath}" entry ${index} has no path: ${JSON.stringify(entry)}`,
			);
		}
		return {
			path: entry.path,
			name: basename(entry.path),
			apply: entry.apply !== false,
			supersededBy: entry.supersededBy || "",
		};
	});
}

const migrationsDir = resolve(MIGRATIONS_DIR);
const usingReplayManifest = Boolean(REPLAY_MANIFEST_PATH);
// Loaded and validated up front -- before resetDatabase() runs below -- so a
// malformed manifest (bad JSON, no entries, an entry with no path) refuses
// loudly before anything is dropped, not after.
const manifestEntries = usingReplayManifest ? loadReplayManifest(REPLAY_MANIFEST_PATH) : null;

if (RESET_AND_REPLAY) {
	await resetDatabase();
}

const orderedEntries =
	manifestEntries ??
	readdirSync(migrationsDir)
		.filter((name) => name.endsWith(".sql"))
		.sort()
		.map((name) => ({ path: join(MIGRATIONS_DIR, name), name, apply: true, supersededBy: "" }));

log(
	usingReplayManifest
		? `${orderedEntries.length} migration entries from replay manifest ${REPLAY_MANIFEST_PATH}`
		: `${orderedEntries.length} migration file(s) on disk in ${MIGRATIONS_DIR}/`,
);

// Read the applied set from d1_migrations. Some historical entries on
// older Fulcrum D1s omit the .sql suffix (manual applications pre-
// workflow), so normalise to a Set keyed on the bare prefix for
// matching.
const appliedQuery = wranglerJson([
	"d1",
	"execute",
	DB_NAME,
	"--remote",
	"--json",
	"--command",
	"SELECT name FROM d1_migrations",
]);

const appliedRows = appliedQuery?.[0]?.results || [];
const appliedKeys = new Set(
	appliedRows.map((r) => r.name.replace(/\.sql$/, "")),
);
log(`${appliedKeys.size} migration(s) already recorded as applied`);

const pending = orderedEntries.filter(
	(entry) => !appliedKeys.has(entry.name.replace(/\.sql$/, "")),
);

if (pending.length === 0) {
	log("nothing to apply");
	process.exit(0);
}

log(`${pending.length} pending: ${pending.map((entry) => entry.name).join(", ")}`);

if (DRY_RUN) {
	log("dry run: not applying (D1_MIGRATIONS_DRY_RUN=1)");
	process.exit(0);
}

for (const entry of pending) {
	if (entry.apply) {
		const filePath = usingReplayManifest ? resolve(entry.path) : join(migrationsDir, entry.name);
		log(`applying ${entry.name}…`);
		try {
			wrangler(["d1", "execute", DB_NAME, "--remote", "--file", filePath]);
		} catch (error) {
			log(`FAILED applying ${entry.name}: ${error?.message || error}`);
			process.exit(1);
		}
	} else {
		// A ledger-only entry: its schema effect was already applied for real,
		// earlier in this same run, under a DIFFERENT name (entry.supersededBy)
		// -- byte-identical content, proven and recorded in the manifest's own
		// provenance, never re-derived here. Recording this name too keeps the
		// deploy-gate ledger tripwire (which checks every file name in both
		// migration directories has SOME ledger row) passing without ever
		// re-running SQL that already ran under the superseding entry.
		log(
			`recording ${entry.name} as ledger-only -- already applied for real as ${entry.supersededBy || "an earlier entry"}, not re-executing…`,
		);
	}

	try {
		wrangler([
			"d1",
			"execute",
			DB_NAME,
			"--remote",
			"--command",
			`INSERT INTO d1_migrations (name, applied_at) VALUES ('${sqlEscape(entry.name)}', CURRENT_TIMESTAMP)`,
		]);
	} catch (error) {
		log(
			`SCHEMA APPLIED but registry insert FAILED for ${entry.name}: ${error?.message || error}`,
		);
		log(
			"NOTE: schema is live, but the next run will try to re-apply this file. Backfill manually:",
		);
		log(
			`  wrangler d1 execute ${DB_NAME} --remote --command "INSERT INTO d1_migrations (name, applied_at) VALUES ('${entry.name}', CURRENT_TIMESTAMP)"`,
		);
		process.exit(1);
	}
	log(entry.apply ? `applied ${entry.name}` : `recorded ${entry.name} (ledger-only)`);
}

const appliedCount = pending.filter((entry) => entry.apply).length;
const ledgerOnlyCount = pending.length - appliedCount;
log(
	ledgerOnlyCount > 0
		? `done; applied ${appliedCount} migration(s), recorded ${ledgerOnlyCount} ledger-only`
		: `done; applied ${pending.length} migration(s)`,
);

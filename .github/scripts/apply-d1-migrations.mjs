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
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

if (!DB_NAME) throw new Error("D1_DATABASE_NAME is required");
if (!ACCOUNT_ID) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
if (!API_TOKEN) throw new Error("CLOUDFLARE_API_TOKEN is required");

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

// Reset-and-replay's actual destructive step: enumerate every object in
// sqlite_master and drop them, INCLUDING d1_migrations -- emptying the
// database's contents without ever touching the D1 resource itself, so its
// uuid (and therefore every wrangler.toml/manifest binding pinned to it,
// including this script's own database-id verification above) never
// changes. Recreating the database instead of emptying it would mint a new
// uuid and break that pin.
//
// Excludes sqlite_%  (SQLite's own bookkeeping, e.g. sqlite_sequence) and
// _cf_% (D1's own internal tables -- D1 refuses a DROP on these, which
// would abort the reset partway through if they were included).
//
// Drop order: triggers and views first (neither blocks any other drop, and
// SQLite doesn't validate a view's referenced table until the view is
// queried), then indexes, then tables last (DROP TABLE auto-drops any
// index/trigger still attached to it, so dropping tables first could race
// an explicit index/trigger drop that runs after -- ordering removes the
// need to reason about it). d1_migrations is just another table name this
// same query returns; no special-casing needed to include it.
async function resetDatabase() {
	const objects =
		wranglerJson([
			"d1",
			"execute",
			DB_NAME,
			"--remote",
			"--json",
			"--command",
			"SELECT type, name FROM sqlite_master WHERE type IN ('table','view','index','trigger') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
		])?.[0]?.results || [];

	const dropOrder = { trigger: 0, view: 1, index: 2, table: 3 };
	const drops = [...objects].sort((a, b) => dropOrder[a.type] - dropOrder[b.type]);

	if (drops.length === 0) {
		log("reset-and-replay: database already empty, nothing to drop");
	} else {
		log(
			`reset-and-replay: would drop ${drops.length} object(s): ${drops
				.map((o) => `${o.type} ${o.name}`)
				.join(", ")}`,
		);
	}

	if (DRY_RUN) {
		log("dry run: not dropping anything (D1_MIGRATIONS_DRY_RUN=1)");
		process.exit(0);
	}

	// Every drop, the FK-defer PRAGMA, and the ledger re-create run as ONE
	// wrangler d1 execute call -- a single multi-statement string, not one
	// call per statement -- so D1's own multi-statement/batch execution
	// (Cloudflare docs: batched statements are SQL transactions; a failing
	// statement aborts and rolls back the whole sequence) covers the entire
	// reset, not just each individual drop. PRAGMA defer_foreign_keys=true
	// (D1's own documented mechanism for a change that would otherwise
	// violate a foreign key mid-migration) is scoped to the transaction it
	// runs in, so it must be the first statement in this SAME call, not a
	// separate, earlier one -- a separate call would not carry it forward.
	const statements = [
		"PRAGMA defer_foreign_keys = true",
		...drops.map(
			({ type, name }) => `DROP ${type.toUpperCase()} IF EXISTS "${name.replace(/"/g, '""')}"`,
		),
		// Same shape wrangler's own `d1 migrations apply` creates it with, so
		// a migration file that itself queries d1_migrations (none do today,
		// but nothing stops one) sees the same schema either way. In the same
		// batch as the drops: the ledger-read loop right after this needs the
		// table to exist even if the batch's atomicity guarantee turns out
		// to matter here (see the catch below).
		"CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
	];

	try {
		wrangler(["d1", "execute", DB_NAME, "--remote", "--command", statements.join(";\n")]);
	} catch (error) {
		log(`RESET FAILED: ${error?.message || error}`);
		log(
			"reset-and-replay: the drop-and-recreate batch failed partway. D1 documents batched/multi-" +
				"statement execution as a single SQL transaction that rolls back the whole sequence on any " +
				"one statement's failure, so this database is EXPECTED to be unchanged from before this run " +
				"-- but an operator must confirm that (enumerate sqlite_master by hand) before trusting it. " +
				"Do NOT dispatch a plain apply-missing run against this database until that's confirmed: an " +
				"apply-missing run assumes whatever d1_migrations currently says is accurate, and would " +
				"silently complete against a partially-dropped schema if this rollback did not fully apply.",
		);
		process.exit(1);
	}
	log("reset-and-replay: dropped and re-created an empty d1_migrations; replaying every migration from scratch");
}

if (RESET_AND_REPLAY) {
	await resetDatabase();
}

const migrationsDir = resolve(MIGRATIONS_DIR);
const migrationFiles = readdirSync(migrationsDir)
	.filter((name) => name.endsWith(".sql"))
	.sort();

log(`${migrationFiles.length} migration file(s) on disk in ${MIGRATIONS_DIR}/`);

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

const pending = migrationFiles.filter(
	(name) => !appliedKeys.has(name.replace(/\.sql$/, "")),
);

if (pending.length === 0) {
	log("nothing to apply");
	process.exit(0);
}

log(`${pending.length} pending: ${pending.join(", ")}`);

if (DRY_RUN) {
	log("dry run: not applying (D1_MIGRATIONS_DRY_RUN=1)");
	process.exit(0);
}

for (const file of pending) {
	const filePath = join(migrationsDir, file);
	log(`applying ${file}…`);
	try {
		wrangler(["d1", "execute", DB_NAME, "--remote", "--file", filePath]);
	} catch (error) {
		log(`FAILED applying ${file}: ${error?.message || error}`);
		process.exit(1);
	}

	try {
		wrangler([
			"d1",
			"execute",
			DB_NAME,
			"--remote",
			"--command",
			`INSERT INTO d1_migrations (name, applied_at) VALUES ('${sqlEscape(file)}', CURRENT_TIMESTAMP)`,
		]);
	} catch (error) {
		log(
			`SCHEMA APPLIED but registry insert FAILED for ${file}: ${error?.message || error}`,
		);
		log(
			"NOTE: schema is live, but the next run will try to re-apply this file. Backfill manually:",
		);
		log(
			`  wrangler d1 execute ${DB_NAME} --remote --command "INSERT INTO d1_migrations (name, applied_at) VALUES ('${file}', CURRENT_TIMESTAMP)"`,
		);
		process.exit(1);
	}
	log(`applied ${file}`);
}

log(`done; applied ${pending.length} migration(s)`);

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
import { readdirSync } from "node:fs";
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

if (!DB_NAME) throw new Error("D1_DATABASE_NAME is required");
if (!ACCOUNT_ID) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
if (!API_TOKEN) throw new Error("CLOUDFLARE_API_TOKEN is required");

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

// Self-hosted runners do not expose the global npm bin dir on PATH, so a bare
// "wrangler" spawn ENOENTs there. The workflow resolves the absolute binary
// path at install time and passes it via WRANGLER_BIN.
const WRANGLER_BIN = process.env.WRANGLER_BIN || "wrangler";

const wranglerJson = (args) => {
	const out = execFileSync(WRANGLER_BIN, args, {
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
	execFileSync(WRANGLER_BIN, args, {
		encoding: "utf8",
		env: { ...process.env, NO_COLOR: "1" },
		stdio: ["ignore", "inherit", "inherit"],
	});

const sqlEscape = (value) => value.replace(/'/g, "''");

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

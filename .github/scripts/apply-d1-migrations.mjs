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

if (!DB_NAME) throw new Error("D1_DATABASE_NAME is required");
if (!ACCOUNT_ID) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
if (!API_TOKEN) throw new Error("CLOUDFLARE_API_TOKEN is required");

const wranglerJson = (args) => {
	const out = execFileSync("wrangler", args, {
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
	execFileSync("wrangler", args, {
		encoding: "utf8",
		env: { ...process.env, NO_COLOR: "1" },
		stdio: ["ignore", "inherit", "inherit"],
	});

const sqlEscape = (value) => value.replace(/'/g, "''");

const log = (...parts) => console.log("[d1-migrations]", ...parts);

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

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
//
// `--manifest <path>` (delivery, foundry d1.migrate): a stricter mode that
// replaces "apply whatever file names the ledger lacks" with an ORDERED
// per-database list [{id, file, sha256}]. The d1_migrations ledger must be an
// exact prefix of that list; a gap, reorder, unknown applied id, duplicate or
// digest mismatch is a divergence (exit 3) that never replays anything. See
// the MANIFEST MODE section below for the contract, exit codes and result file.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

// Hoisted (a function declaration) because MANIFEST_FLAG below is read at
// module top level. Returns null when --manifest is absent (every legacy
// caller); otherwise {path, databaseId} or {error} when a flag is malformed
// (missing value, repeated, unknown), so the mode refuses instead of silently
// running the legacy apply-missing path. `--database-id` is only meaningful
// alongside --manifest.
function manifestFlagFromArgv(argv) {
	if (!argv.some((arg) => arg === "--manifest" || arg.startsWith("--manifest="))) return null;
	const values = { manifest: null, "database-id": null };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const match = /^--(manifest|database-id)(?:=(.*))?$/.exec(arg);
		if (!match) return { error: `unknown argument ${JSON.stringify(arg)}` };
		const [, name, inline] = match;
		if (values[name] !== null) return { error: `--${name} was supplied more than once` };
		let value = inline;
		if (value === undefined) {
			if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) return { error: `--${name} requires a value` };
			value = argv[++i];
		}
		if (value === "") return { error: `--${name} requires a non-empty value` };
		values[name] = value;
	}
	return { path: values.manifest, databaseId: values["database-id"] || "" };
}

// ---------------------------------------------------------------------------
// MANIFEST MODE (`--manifest <path>`)
//
// What it is: apply the NEXT entries of an ORDERED per-database list, and
// refuse to do anything at all when the database is not exactly where that
// list says it is. It exists because "apply every file name the ledger lacks"
// (the legacy mode) silently replays or skips on a ledger that has drifted: the
// fronts-data R17 case, where @growth-labs/analytics migrations 0002-0004 were
// applied to fronts-data again as fronts 0029/0030/0032 with non-idempotent
// ALTERs, so a name-set diff sees "0002..0004 pending" and re-runs them.
//
// Manifest file (JSON; a bare array is also accepted):
//   {"schemaVersion":1,"entries":[{"id":"0001_init","file":"migrations/0001_init.sql","sha256":"<64 hex>"}, ...]}
//   - order is the apply order;
//   - `id` is the d1_migrations.name value (charset [A-Za-z0-9._-]); a trailing
//     ".sql" is ignored when comparing with the ledger, because historical
//     rows omit it, but the id is inserted exactly as written;
//   - `file` is relative to the working directory (the artifact root): no
//     absolute path, no "..", no symlink, must end in .sql and be a regular file;
//   - `sha256` is the lowercase hex digest of the file's bytes, and EVERY
//     entry's file is read and verified before any network call.
//
// Rules, all enforced before anything is written:
//   - the ledger (SELECT ... ORDER BY id) must be an EXACT PREFIX of the
//     manifest's ids. A gap (a later id applied while an earlier one is not),
//     a reorder, an applied id the manifest does not know, a duplicate ledger
//     row, a missing ledger table or a digest mismatch is a DIVERGENCE: exit 3,
//     nothing is applied, nothing is replayed, and no flag turns that off;
//   - the remaining entries apply strictly in order, each as ONE request to
//     the D1 query endpoint (see the wire format above), which D1 runs as a
//     single batch (all of it or none of it). The SQL is exactly the verified
//     bytes; no other script or command runs;
//   - after the last entry the ledger is read again and must equal the
//     manifest prefix through that entry, otherwise the run is ambiguous.
//
// Transport: plain Cloudflare REST, never wrangler, and ONE endpoint only:
// POST /accounts/{account}/d1/database/{id}/query. There is no database lookup
// or listing: the database is addressed by the id given as --database-id (or
// D1_DATABASE_ID), which the caller's registry owns, and every request goes to
// that one id. CLOUDFLARE_API_BASE_URL (wrangler's own variable) is the ONLY
// thing that selects the base, so the delivery broker can stand in for
// api.cloudflare.com and hand out a per-run grant handle as CLOUDFLARE_API_TOKEN;
// redirects are refused. The legacy mode's test-only base override is not read.
//
// Wire format (fixed, so a broker can check a request body exactly): only two
// shapes of {"sql": ...} are ever sent.
//   ledger read   sql = "SELECT id, name FROM d1_migrations ORDER BY id"
//   entry apply   sql = <the file's bytes, unmodified> + "\n;\nINSERT INTO
//                 d1_migrations (name, applied_at) VALUES ('<id>', CURRENT_TIMESTAMP);"
// so the sha256 of everything before the fixed suffix IS the manifest's
// sha256 for that entry. Files must be valid UTF-8. The whole entry apply is a
// single statement list that D1 runs as one batch: all of it or none of it.
//
// Not offered here, by design: reset-and-replay, the replay manifest and any
// "skip"/"force" escape hatch. Combining --manifest with either is refused.
//
// Exit codes:  0 applied / nothing pending / dry run     1 an entry failed (the
//   database refused it; nothing of that entry is applied)   2 invalid manifest,
//   arguments or environment (nothing was contacted)       3 divergence (never
//   replays)   4 ambiguous: the outcome of a request or the final ledger is
//   not known, so nothing further was attempted and nobody may assume success.
//
// Result file: with D1_MIGRATIONS_RESULT_PATH set, a JSON document is written
// there (atomically) on every exit path of this mode:
//   {schemaVersion:1, status: noop|applied|dry-run|divergence|failed|ambiguous|invalid,
//    database:{name,id}, manifestSha256, exitCode, ledgerBefore:[names],
//    applied:[ids], pending:[ids], failedAt, ambiguousAt,
//    divergence:{kind,index,expected,actual}, error}
// D1_MIGRATIONS_DRY_RUN=1 reads and verifies everything and lists what would
// apply, changing nothing.
// ---------------------------------------------------------------------------

const MANIFEST_EXIT = { ok: 0, failed: 1, invalid: 2, divergence: 3, ambiguous: 4 };
const MANIFEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const MANIFEST_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MANIFEST_LEDGER_READ_SQL = "SELECT id, name FROM d1_migrations ORDER BY id";
const manifestLedgerInsertSuffix = (id) =>
	`\n;\nINSERT INTO d1_migrations (name, applied_at) VALUES ('${id}', CURRENT_TIMESTAMP);`;
const MANIFEST_ENTRY_KEYS = new Set(["id", "file", "sha256"]);
const MANIFEST_DOC_KEYS = new Set(["schemaVersion", "entries"]);

class ManifestInvalid extends Error {}
class ManifestDivergence extends Error {
	constructor(message, detail) {
		super(message);
		this.detail = detail;
	}
}

const ledgerKey = (name) => String(name).replace(/\.sql$/, "");

function readManifest(manifestPath) {
	let raw;
	try {
		raw = readFileSync(resolve(manifestPath));
	} catch (error) {
		throw new ManifestInvalid(`manifest "${manifestPath}" cannot be read: ${error?.code || error?.message}`);
	}
	let doc;
	try {
		doc = JSON.parse(raw.toString("utf8"));
	} catch (error) {
		throw new ManifestInvalid(`manifest "${manifestPath}" is not valid JSON: ${error?.message}`);
	}
	let entries;
	if (Array.isArray(doc)) {
		entries = doc;
	} else if (doc && typeof doc === "object") {
		const unknown = Object.keys(doc).filter((key) => !MANIFEST_DOC_KEYS.has(key));
		if (unknown.length > 0) throw new ManifestInvalid(`manifest has unrecognized field(s): ${unknown.join(", ")}`);
		if ("schemaVersion" in doc && doc.schemaVersion !== 1) {
			throw new ManifestInvalid(`manifest schemaVersion ${JSON.stringify(doc.schemaVersion)} is not supported (want 1)`);
		}
		entries = doc.entries;
	}
	if (!Array.isArray(entries) || entries.length === 0) throw new ManifestInvalid("manifest contains no entries");

	const checkoutRoot = resolve(".");
	const realCheckoutRoot = realpathSync(".");
	const seenKeys = new Map();
	const seenFiles = new Map();
	const seenDigests = new Map();
	const parsed = entries.map((entry, index) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new ManifestInvalid(`manifest entry ${index} is not an object`);
		}
		const unknown = Object.keys(entry).filter((key) => !MANIFEST_ENTRY_KEYS.has(key));
		if (unknown.length > 0) throw new ManifestInvalid(`manifest entry ${index} has unrecognized field(s): ${unknown.join(", ")}`);
		const { id, file, sha256 } = entry;
		if (typeof id !== "string" || !MANIFEST_ID_PATTERN.test(id)) {
			throw new ManifestInvalid(`manifest entry ${index} has an invalid id: ${JSON.stringify(id)}`);
		}
		if (typeof file !== "string" || file === "" || !file.endsWith(".sql") || file.includes("\0")) {
			throw new ManifestInvalid(`manifest entry ${index} (${id}) file must be a non-empty .sql path: ${JSON.stringify(file)}`);
		}
		if (isAbsolute(file) || file.split(/[\\/]/).includes("..")) {
			throw new ManifestInvalid(`manifest entry ${index} (${id}) file must be relative with no "..": ${file}`);
		}
		if (typeof sha256 !== "string" || !MANIFEST_SHA256_PATTERN.test(sha256)) {
			throw new ManifestInvalid(`manifest entry ${index} (${id}) sha256 must be 64 lowercase hex characters`);
		}
		const key = ledgerKey(id);
		if (seenKeys.has(key)) {
			throw new ManifestInvalid(`manifest id "${id}" repeats entry ${seenKeys.get(key)} (ids are compared without a trailing .sql)`);
		}
		seenKeys.set(key, index);
		const resolved = resolve(file);
		if (!resolved.startsWith(checkoutRoot + sep)) {
			throw new ManifestInvalid(`manifest entry ${index} (${id}) file resolves outside the working directory: ${file}`);
		}
		if (seenFiles.has(resolved)) {
			throw new ManifestInvalid(`manifest entry ${index} (${id}) repeats the file of entry ${seenFiles.get(resolved)}: ${file}`);
		}
		seenFiles.set(resolved, index);
		let lstat;
		try {
			lstat = lstatSync(resolved);
		} catch {
			throw new ManifestInvalid(`manifest entry ${index} (${id}) file does not exist: ${file}`);
		}
		if (lstat.isSymbolicLink()) throw new ManifestInvalid(`manifest entry ${index} (${id}) file is a symlink, refused outright: ${file}`);
		if (!lstat.isFile()) throw new ManifestInvalid(`manifest entry ${index} (${id}) file is not a regular file: ${file}`);
		if (!realpathSync(resolved).startsWith(realCheckoutRoot + sep)) {
			throw new ManifestInvalid(`manifest entry ${index} (${id}) file resolves outside the working directory via a symlinked ancestor: ${file}`);
		}
		if (seenDigests.has(sha256)) {
			// Two entries with byte-identical SQL is the R17 shape (one set of
			// ALTERs listed under two names). The builder must list it once.
			throw new ManifestInvalid(
				`manifest entry ${index} (${id}) has the same sha256 as entry ${seenDigests.get(sha256)}: identical SQL listed twice would run twice`,
			);
		}
		seenDigests.set(sha256, index);
		return { index, id, file, sha256, path: resolved };
	});

	// Every digest is verified before any network call: the bytes that will run
	// are the bytes the manifest names, or nothing runs.
	for (const entry of parsed) {
		const bytes = readFileSync(entry.path);
		const actual = createHash("sha256").update(bytes).digest("hex");
		if (actual !== entry.sha256) {
			throw new ManifestDivergence(
				`digest mismatch for ${entry.id}: manifest says ${entry.sha256}, ${entry.file} is ${actual}`,
				{ kind: "digest-mismatch", index: entry.index, expected: entry.sha256, actual },
			);
		}
		try {
			entry.sql = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			throw new ManifestInvalid(`manifest entry ${entry.index} (${entry.id}) file is not valid UTF-8: ${entry.file}`);
		}
	}
	return { entries: parsed, manifestSha256: createHash("sha256").update(raw).digest("hex") };
}

// The ledger must be an exact prefix of the manifest. Returns the number of
// entries already applied; throws ManifestDivergence otherwise. Pure.
function checkLedgerPrefix(entries, ledgerNames) {
	const manifestIndex = new Map(entries.map((entry, index) => [ledgerKey(entry.id), index]));
	const seen = new Set();
	for (let i = 0; i < ledgerNames.length; i++) {
		const applied = ledgerNames[i];
		const key = ledgerKey(applied);
		if (seen.has(key)) {
			throw new ManifestDivergence(`ledger row ${i} "${applied}" duplicates an earlier ledger row`, {
				kind: "duplicate-applied", index: i, expected: i < entries.length ? entries[i].id : null, actual: applied,
			});
		}
		seen.add(key);
		const position = manifestIndex.get(key);
		if (position === undefined) {
			throw new ManifestDivergence(`applied migration "${applied}" (ledger row ${i}) is not in the manifest`, {
				kind: "unknown-applied", index: i, expected: i < entries.length ? entries[i].id : null, actual: applied,
			});
		}
		if (i >= entries.length || position !== i) {
			const expected = i < entries.length ? entries[i].id : null;
			// "reorder" when the entry the manifest wants here was applied LATER
			// (the ledger has both, in the wrong order); "gap" when it was not
			// applied at all while a later one was.
			const expectedAppliedLater = expected !== null && ledgerNames.slice(i + 1).some((later) => ledgerKey(later) === ledgerKey(expected));
			const kind = position > i && !expectedAppliedLater ? "gap" : "reorder";
			throw new ManifestDivergence(
				kind === "gap"
					? `ledger row ${i} is "${applied}" (manifest position ${position}) but "${expected}" is not applied: a gap, refusing to replay`
					: `ledger row ${i} is "${applied}" but the manifest puts it at position ${position}: reordered, refusing to replay`,
				{ kind, index: i, expected, actual: applied },
			);
		}
	}
	return ledgerNames.length;
}

async function runManifestMode(flag) {
	const mlog = (...parts) => console.log("[d1-migrations]", ...parts);
	const resultPath = process.env.D1_MIGRATIONS_RESULT_PATH || "";
	const result = {
		schemaVersion: 1,
		status: "invalid",
		database: { name: DB_NAME || "", id: flag.databaseId || DATABASE_ID },
		manifestSha256: "",
		exitCode: MANIFEST_EXIT.invalid,
		ledgerBefore: [],
		applied: [],
		pending: [],
		failedAt: null,
		ambiguousAt: null,
		divergence: null,
		error: "",
	};
	const finish = (status, exitCode, error = "") => {
		result.status = status;
		result.exitCode = exitCode;
		if (error) result.error = error;
		if (resultPath) {
			try {
				const tmp = `${resultPath}.tmp-${process.pid}`;
				writeFileSync(tmp, `${JSON.stringify(result)}\n`, { mode: 0o600 });
				renameSync(tmp, resultPath);
			} catch (writeError) {
				mlog(`could not write the result file: ${writeError?.message || writeError}`);
				if (exitCode === MANIFEST_EXIT.ok) return MANIFEST_EXIT.failed;
			}
		}
		return exitCode;
	};

	let phase = "preflight";
	try {
		if (flag.error) throw new ManifestInvalid(flag.error);
		if (RESET_AND_REPLAY || REPLAY_MANIFEST_PATH) {
			throw new ManifestInvalid("--manifest never combines with reset-and-replay or replay-manifest-path: replay is not offered in this mode");
		}
		if (!ACCOUNT_ID || !/^[0-9a-f]{32}$/.test(ACCOUNT_ID)) throw new ManifestInvalid("CLOUDFLARE_ACCOUNT_ID must be a 32-character hex account id");
		if (!API_TOKEN) throw new ManifestInvalid("CLOUDFLARE_API_TOKEN is required");
		if (flag.databaseId && DATABASE_ID && flag.databaseId !== DATABASE_ID) {
			throw new ManifestInvalid("--database-id and D1_DATABASE_ID name different databases");
		}
		const databaseId = flag.databaseId || DATABASE_ID;
		result.database.id = databaseId;
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(databaseId)) {
			throw new ManifestInvalid("--database-id (or D1_DATABASE_ID) must be the database uuid: manifest mode addresses the database by id only");
		}
		// The ONE knob for where the credential is sent is CLOUDFLARE_API_BASE_URL
		// (wrangler's own variable, set by the delivery unit to the broker). The
		// legacy mode's D1_MIGRATIONS_CF_API_BASE_FOR_TESTS_ONLY is deliberately
		// not read here: a second, higher-precedence redirect knob has no place in
		// a mode that carries a grant handle (sec-review, #75).
		const base = (process.env.CLOUDFLARE_API_BASE_URL || "https://api.cloudflare.com/client/v4").replace(/\/+$/, "");
		const timeoutMs = Number(process.env.D1_MIGRATIONS_REQUEST_TIMEOUT_MS || 120000);

		const { entries, manifestSha256 } = readManifest(flag.path);
		result.manifestSha256 = manifestSha256;
		mlog(`manifest ${flag.path}: ${entries.length} entries, sha256 ${manifestSha256}; every file digest verified`);

		const call = async (method, path, body) => {
			const response = await fetch(`${base}${path}`, {
				method,
				redirect: "manual",
				signal: AbortSignal.timeout(timeoutMs),
				headers: {
					Authorization: `Bearer ${API_TOKEN}`,
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			const text = await response.text();
			let json = null;
			try {
				json = JSON.parse(text);
			} catch {
				// not JSON: classified by status below
			}
			return { status: response.status, json, text };
		};

		const queryPath = `/accounts/${ACCOUNT_ID}/d1/database/${databaseId}/query`;
		const readLedger = async () => {
			const reply = await call("POST", queryPath, { sql: MANIFEST_LEDGER_READ_SQL });
			const errors = JSON.stringify(reply.json?.errors ?? reply.text ?? "");
			if (reply.status !== 200 || reply.json?.success !== true) {
				if (/no such table:?\s*d1_migrations/i.test(errors)) return { missing: true, names: [] };
				throw new Error(`ledger read failed: HTTP ${reply.status} ${errors.slice(0, 300)}`);
			}
			const rows = reply.json?.result?.[0]?.results;
			if (!Array.isArray(rows)) throw new Error("ledger read returned no result rows");
			return { missing: false, names: rows.map((row) => String(row.name)) };
		};

		const before = await readLedger();
		if (before.missing) {
			throw new ManifestDivergence("the d1_migrations ledger table does not exist: refusing to guess where this database is", {
				kind: "ledger-missing", index: 0, expected: entries[0].id, actual: null,
			});
		}
		result.ledgerBefore = before.names;
		const appliedCount = checkLedgerPrefix(entries, before.names);
		const pending = entries.slice(appliedCount);
		result.pending = pending.map((entry) => entry.id);
		mlog(`${appliedCount} of ${entries.length} entries applied; ledger is an exact prefix of the manifest`);

		if (pending.length === 0) {
			mlog("nothing to apply");
			return finish("noop", MANIFEST_EXIT.ok);
		}
		mlog(`${pending.length} pending: ${result.pending.join(", ")}`);
		if (DRY_RUN) {
			mlog("dry run: not applying (D1_MIGRATIONS_DRY_RUN=1)");
			return finish("dry-run", MANIFEST_EXIT.ok);
		}

		phase = "applying";
		for (const entry of pending) {
			mlog(`applying ${entry.id}…`);
			// exactly the verified bytes, then the fixed ledger suffix: nothing trimmed
			const batch = `${entry.sql}${manifestLedgerInsertSuffix(entry.id)}`;
			let reply;
			try {
				reply = await call("POST", queryPath, { sql: batch });
			} catch (error) {
				// The request may or may not have been executed.
				result.ambiguousAt = entry.id;
				mlog(`AMBIGUOUS applying ${entry.id}: no response (${error?.name || "error"}); not retrying`);
				return finish("ambiguous", MANIFEST_EXIT.ambiguous, `no response for ${entry.id}: ${error?.message || error}`);
			}
			if (reply.status === 200 && reply.json?.success === true) {
				result.applied.push(entry.id);
				mlog(`applied ${entry.id}`);
				continue;
			}
			const detail = JSON.stringify(reply.json?.errors ?? reply.text ?? "").slice(0, 500);
			if (reply.json && reply.json.success === false && reply.status >= 400 && reply.status < 500) {
				// The database answered and refused: the batch did not commit.
				result.failedAt = entry.id;
				mlog(`FAILED applying ${entry.id}: HTTP ${reply.status} ${detail}`);
				return finish("failed", MANIFEST_EXIT.failed, `${entry.id} refused by the database: HTTP ${reply.status} ${detail}`);
			}
			// 5xx, a redirect, or an answer we cannot read: unknown outcome.
			result.ambiguousAt = entry.id;
			mlog(`AMBIGUOUS applying ${entry.id}: HTTP ${reply.status} ${detail}; not retrying`);
			return finish("ambiguous", MANIFEST_EXIT.ambiguous, `unreadable answer for ${entry.id}: HTTP ${reply.status}`);
		}

		// Never inferred: read the ledger back and require the exact prefix.
		let after;
		try {
			after = await readLedger();
		} catch (error) {
			mlog(`AMBIGUOUS: applied ${result.applied.length} entries but the final ledger read failed: ${error?.message || error}`);
			return finish("ambiguous", MANIFEST_EXIT.ambiguous, `final ledger read failed: ${error?.message || error}`);
		}
		const want = entries.map((entry) => ledgerKey(entry.id));
		const got = after.names.map(ledgerKey);
		if (after.missing || got.length !== want.length || got.some((name, i) => name !== want[i])) {
			mlog("AMBIGUOUS: after applying, the ledger is not the manifest prefix it should be");
			return finish("ambiguous", MANIFEST_EXIT.ambiguous, "the ledger after applying is not the expected prefix");
		}
		mlog(`done; applied ${result.applied.length} migration(s), ledger verified`);
		return finish("applied", MANIFEST_EXIT.ok);
	} catch (error) {
		if (error instanceof ManifestInvalid) {
			mlog(`INVALID: ${error.message}`);
			return finish("invalid", MANIFEST_EXIT.invalid, error.message);
		}
		if (error instanceof ManifestDivergence) {
			result.divergence = error.detail;
			mlog(`DIVERGENCE (${error.detail.kind}): ${error.message}; nothing was applied or replayed`);
			return finish("divergence", MANIFEST_EXIT.divergence, error.message);
		}
		const message = error?.message || String(error);
		if (phase === "applying") {
			mlog(`AMBIGUOUS: unexpected error while applying: ${message}`);
			return finish("ambiguous", MANIFEST_EXIT.ambiguous, message);
		}
		mlog(`FAILED: ${message}`);
		return finish("failed", MANIFEST_EXIT.failed, message);
	}
}

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
// `--manifest <path>` / `--manifest=<path>`: see the MANIFEST MODE section.
// Only the CLI flag selects the mode, never an environment variable, so an
// inherited environment can never silently switch an existing caller into it.
const MANIFEST_FLAG = manifestFlagFromArgv(process.argv.slice(2));

// Manifest mode validates its own environment (exit 2, not a stack trace) and
// always ends the process; everything below is the legacy apply-missing path,
// untouched by it.
if (MANIFEST_FLAG) {
	process.exit(await runManifestMode(MANIFEST_FLAG));
}

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
		// Team-lead LOW: a dry run that only shows the DROP side leaves the
		// REPLAY side (what would apply, in what order, and what's ledger-only)
		// entirely unverified until a real, irreversible run -- print the
		// validated manifest plan here too, before this same early exit.
		// usingReplayManifest/manifestEntries are declared later in this file
		// (module scope, referenced here by closure) but always initialized
		// before resetDatabase() is ever CALLED -- see the RESET_AND_REPLAY
		// call site below.
		if (usingReplayManifest) {
			log(`replay manifest plan (${manifestEntries.length} entries from ${REPLAY_MANIFEST_PATH}):`);
			for (const entry of manifestEntries) {
				log(
					entry.apply
						? `  apply  ${entry.name}`
						: `  ledger-only  ${entry.name}  (covered by ${entry.supersededBy})`,
				);
			}
		}
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
// Recognized per-entry keys. Anything else is refused (guard 4) -- a typo'd
// key (e.g. "supercededBy") would otherwise silently do nothing, and the
// entry it was meant to qualify would behave as if that key were absent.
const KNOWN_ENTRY_KEYS = new Set(["path", "apply", "supersededBy"]);

function loadReplayManifest(manifestPath) {
	const resolved = resolve(manifestPath);
	const raw = JSON.parse(readFileSync(resolved, "utf8"));
	const rawEntries = Array.isArray(raw) ? raw : raw?.entries;
	if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
		throw new Error(`replay-manifest-path "${manifestPath}" contains no entries`);
	}

	// The checkout root every entry's path must resolve inside. Computed once,
	// as an absolute, trailing-separator-qualified prefix, so a startsWith
	// check below can't be fooled by a sibling directory that merely shares a
	// string prefix (e.g. "/repo" vs "/repo-evil"). Two forms: the lexical
	// one (cheap, catches a bare absolute path or a literal ".." before any
	// filesystem call) and the REAL one (resolves any symlinked ancestor
	// directory too) -- an entry must pass both.
	const checkoutRoot = resolve(".") + sep;
	const realCheckoutRoot = realpathSync(".") + sep;

	const entries = rawEntries.map((entry, index) => {
		if (!entry || typeof entry !== "object") {
			throw new Error(`replay-manifest-path "${manifestPath}" entry ${index} is not an object: ${JSON.stringify(entry)}`);
		}

		// Guard 4a: unknown fields refused, never silently ignored.
		const unknownKeys = Object.keys(entry).filter((key) => !KNOWN_ENTRY_KEYS.has(key));
		if (unknownKeys.length > 0) {
			throw new Error(
				`replay-manifest-path "${manifestPath}" entry ${index} has unrecognized field(s): ${unknownKeys.join(", ")}`,
			);
		}

		if (typeof entry.path !== "string" || entry.path === "") {
			throw new Error(
				`replay-manifest-path "${manifestPath}" entry ${index} has no path: ${JSON.stringify(entry)}`,
			);
		}

		// Guard 4b: `apply` must be a real boolean when present -- "false", 0,
		// and a missing field are three different things a loose truthiness
		// check would otherwise conflate into "apply" (this script's own
		// `entry.apply !== false` used to do exactly that for the string
		// "false" and the number 0, both of which are !== the boolean false).
		// Computed BEFORE guard 1 below, which branches on it.
		if ("apply" in entry && typeof entry.apply !== "boolean") {
			throw new Error(
				`replay-manifest-path "${manifestPath}" entry ${index}'s apply must be a real boolean, got ${JSON.stringify(entry.apply)}`,
			);
		}
		const apply = "apply" in entry ? entry.apply : true;

		// Guard 1: the path must resolve to a real .sql file INSIDE the
		// checkout -- no absolute path, no `..` escaping it, and no symlink
		// escaping it either. `resolve()` is purely LEXICAL -- it defeats a
		// bare absolute path or a literal `..`, but a committed symlink
		// (`migrations/x.sql -> /outside/evil.sql`) resolves lexically to a
		// path that still starts with the checkout root, then `statSync`
		// FOLLOWS the link to whatever it points at (reviewer-foundry, SW#63
		// re-review). Two checks close this: `lstatSync` (never follows
		// links) to refuse a symlink outright, and `realpathSync` (resolves
		// every remaining path component, including any symlinked ANCESTOR
		// directory) compared against the checkout root's own realpath --
		// not `resolve('.')`, which is exactly as lexical as `resolve(entry.path)`
		// and would miss a symlinked directory two levels up just as easily.
		//
		// apply:false is exempt from the FILESYSTEM half of this guard
		// (existence, lstat, realpath) -- reviewer-foundry/team-lead, SW#63
		// re-review: this workflow never runs `pnpm install`, so a
		// dependency's own migrations_dir (e.g. node_modules/@growth-labs/
		// analytics/migrations, exactly where every ledger-only entry in a
		// project like Fronts' 116-name historical set lives) does not exist
		// on disk in this job at all. An apply:false entry never executes
		// its file -- only its basename is ever read (for the ledger INSERT)
		// -- so there is nothing to protect by requiring the file to exist,
		// while a real prod dependency version bump would otherwise refuse a
		// perfectly safe manifest outright. The lexical half (.sql suffix,
		// no absolute path, no `..`) still applies to EVERY entry regardless
		// of apply -- a nonsense or escaping path is refused either way,
		// it's only the "does this actually exist" filesystem check that's
		// apply:true-only.
		if (!entry.path.endsWith(".sql")) {
			throw new Error(
				`replay-manifest-path "${manifestPath}" entry ${index}'s path does not end in .sql: ${entry.path}`,
			);
		}
		const resolvedEntryPath = resolve(entry.path);
		if (resolvedEntryPath !== checkoutRoot.slice(0, -1) && !resolvedEntryPath.startsWith(checkoutRoot)) {
			throw new Error(
				`replay-manifest-path "${manifestPath}" entry ${index}'s path resolves outside the checkout: ${entry.path}`,
			);
		}
		if (apply) {
			let lstat;
			try {
				lstat = lstatSync(resolvedEntryPath);
			} catch {
				throw new Error(
					`replay-manifest-path "${manifestPath}" entry ${index}'s path does not exist: ${entry.path}`,
				);
			}
			if (lstat.isSymbolicLink()) {
				throw new Error(
					`replay-manifest-path "${manifestPath}" entry ${index}'s path is a symlink, refused outright: ${entry.path}`,
				);
			}
			if (!lstat.isFile()) {
				throw new Error(
					`replay-manifest-path "${manifestPath}" entry ${index}'s path is not a regular file: ${entry.path}`,
				);
			}
			const realEntryPath = realpathSync(resolvedEntryPath);
			if (realEntryPath !== realCheckoutRoot.slice(0, -1) && !realEntryPath.startsWith(realCheckoutRoot)) {
				throw new Error(
					`replay-manifest-path "${manifestPath}" entry ${index}'s path resolves outside the checkout `
						+ `via a symlinked ancestor directory: ${entry.path}`,
				);
			}
		}

		// Guard 3: apply:false requires supersededBy, and it must name an
		// EARLIER entry in this same manifest (checked in a second pass below,
		// once every entry's name is known) -- a forward or dangling reference
		// would silently record a superseded name with no real entry to back
		// the claim "this schema effect already ran". supersededBy is matched
		// against that earlier entry's PATH, exact string, byte for byte --
		// never just a basename (two different directories can share one).
		if (!apply && (typeof entry.supersededBy !== "string" || entry.supersededBy === "")) {
			throw new Error(
				`replay-manifest-path "${manifestPath}" entry ${index} is apply:false but has no supersededBy: ${entry.path}`,
			);
		}

		return {
			path: entry.path,
			name: basename(entry.path),
			apply,
			supersededBy: entry.supersededBy || "",
		};
	});

	// Guard 2: basenames must be unique. The ledger is keyed on basename
	// (d1_migrations.name is UNIQUE) -- a duplicate wouldn't fail until the
	// SECOND entry's ledger INSERT, after its SQL (if apply:true) already ran
	// against the live database. Checked here, before any D1 interaction.
	const seenAt = new Map();
	for (const entry of entries) {
		if (seenAt.has(entry.name)) {
			throw new Error(
				`replay-manifest-path "${manifestPath}" has a duplicate basename "${entry.name}": `
					+ `${seenAt.get(entry.name)} and ${entry.path}`,
			);
		}
		seenAt.set(entry.name, entry.path);
	}

	// Guard 3 (continued): supersededBy must reference an entry that (a)
	// exists in this manifest and (b) is apply:true and (c) appears EARLIER
	// -- "this was already applied for real" can't be true of something that
	// hasn't run yet.
	const applyTruePathsSeenSoFar = new Set();
	for (const entry of entries) {
		if (!entry.apply && entry.supersededBy) {
			if (!applyTruePathsSeenSoFar.has(entry.supersededBy)) {
				throw new Error(
					`replay-manifest-path "${manifestPath}" entry ${entry.path}'s supersededBy `
						+ `(${entry.supersededBy}) is not an EARLIER apply:true entry in this manifest`,
				);
			}
		}
		if (entry.apply) applyTruePathsSeenSoFar.add(entry.path);
	}

	return entries;
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
		// -- COVERED BY that earlier entry (M2-19 R17(B): a project's manifest
		// may cover many ledger-only names with one real entry, e.g. 116 names
		// covered by one committed baseline -- never assumed byte-identical
		// 1:1), proven and recorded in the manifest's own provenance, never
		// re-derived here. Recording this name too keeps the
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

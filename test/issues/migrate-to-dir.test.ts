// test/issues/migrate-to-dir.test.ts
//
// Unit tests for migrateIssuesToDir (scripts/cam/migrate-issues-schema.ts).
//
// Oracle assertions (US-006, CAM-90):
//   AC#1: Migration produces ONE commit containing N issue-file writes plus the
//         issues.local.json deletion.
//   AC#2: Idempotency -- re-run when issues.local.json is absent = no commit.
//   AC#3: Multi-issue array migrates to N files with ids intact and
//         CAM-90 -> CAM-0090.json (4-digit padded filename, unpadded id field).

import { describe, expect, test } from "bun:test";
import type { SpawnSyncReturns } from "node:child_process";
import {
	migrateIssuesToDir,
	type MigrateIssuesToDirResult,
} from "../../scripts/cam/migrate-issues-schema.ts";
import type { SpawnFn } from "../../src/git/on-main.ts";
import type { IssueEntry } from "../../src/issues/types.ts";

// ---------------------------------------------------------------------------
// Shared stubs
// ---------------------------------------------------------------------------

function ok(stdout = ""): SpawnSyncReturns<string> {
	return { pid: 1, output: [null, stdout, ""], stdout, stderr: "", status: 0, signal: null };
}

function fail(stderr = "not found"): SpawnSyncReturns<string> {
	return { pid: 1, output: [null, "", stderr], stdout: "", stderr, status: 1, signal: null };
}

const CWD = "/fake/repo";
const MAIN_SHA = "mainsha1111111111111111111111111111111111";
const BLOB_SHA = "blobsha0000000000000000000000000000000000";
const TREE_SHA = "treesha000000000000000000000000000000000";
const COMMIT_SHA = "commitsha00000000000000000000000000000000";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeEntry(id: string): IssueEntry {
	return {
		id,
		title: `Issue ${id}`,
		stage: "idea",
		status: "open",
		blockedBy: [],
		createdAt: "2026-01-01T00:00:00Z",
	};
}

/** Build the issues.local.json content for N entries. */
function makeIssuesLocalJson(entries: IssueEntry[]): string {
	return JSON.stringify({ next_id: entries.length + 1, issues: entries }, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Happy-path SpawnFn factory
//
// Handles:
//   git show main:scripts/cam/issues.local.json  -> issuesLocalContent (or fail)
//   git rev-parse main                            -> MAIN_SHA
//   git read-tree main                            -> ok
//   git update-index --force-remove ...           -> ok  (records the removal)
//   git hash-object ...                           -> BLOB_SHA
//   git update-index --add --cacheinfo ...        -> ok  (records cacheinfo path)
//   git write-tree                                -> TREE_SHA
//   git commit-tree ...                           -> COMMIT_SHA
//   git update-ref ...                            -> ok
// ---------------------------------------------------------------------------

interface CallRecord {
	sub: string;
	args: string[];
}

function makeHappySpawn(issuesLocalContent: string | null): {
	spawnFn: SpawnFn;
	calls: CallRecord[];
} {
	const calls: CallRecord[] = [];

	const spawnFn: SpawnFn = (_cmd, args, _opts) => {
		// Determine the git subcommand (args pattern: ['-C', cwd, <sub>, ...rest])
		const sub = args[2] ?? "";
		calls.push({ sub, args: [...args] });

		if (sub === "show") {
			// git show main:scripts/cam/issues.local.json
			if (issuesLocalContent === null) return fail("not found on main");
			return ok(issuesLocalContent);
		}
		if (sub === "rev-parse") return ok(MAIN_SHA + "\n");
		if (sub === "read-tree") return ok();
		if (sub === "hash-object") return ok(BLOB_SHA + "\n");
		if (sub === "update-index") return ok();
		if (sub === "write-tree") return ok(TREE_SHA + "\n");
		if (sub === "commit-tree") return ok(COMMIT_SHA + "\n");
		if (sub === "update-ref") return ok();
		return ok();
	};

	return { spawnFn, calls };
}

// ---------------------------------------------------------------------------
// AC#2: Idempotency -- no-op when issues.local.json is absent
// ---------------------------------------------------------------------------

describe("migrateIssuesToDir -- AC#2 idempotency", () => {
	test("returns noOp:true when issues.local.json is absent on main", () => {
		const { spawnFn } = makeHappySpawn(null);
		const result: MigrateIssuesToDirResult = migrateIssuesToDir(CWD, spawnFn);
		expect(result.noOp).toBe(true);
		expect(result.issueCount).toBe(0);
		expect(result.sha).toBeUndefined();
	});

	test("no commit is made when issues.local.json is absent", () => {
		const { spawnFn, calls } = makeHappySpawn(null);
		migrateIssuesToDir(CWD, spawnFn);
		const commitCalls = calls.filter(
			(c) => c.sub === "commit-tree" || c.sub === "update-ref",
		);
		expect(commitCalls.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// AC#1: One atomic commit with N writes + 1 deletion
// ---------------------------------------------------------------------------

describe("migrateIssuesToDir -- AC#1 atomic commit", () => {
	test("produces exactly one commit-tree call for a 3-issue backlog", () => {
		const entries = [makeEntry("CAM-1"), makeEntry("CAM-2"), makeEntry("CAM-3")];
		const { spawnFn, calls } = makeHappySpawn(makeIssuesLocalJson(entries));

		migrateIssuesToDir(CWD, spawnFn);

		const commitTreeCalls = calls.filter((c) => c.sub === "commit-tree");
		expect(commitTreeCalls.length).toBe(1);
	});

	test("produces exactly one write-tree call (all writes land in one tree)", () => {
		const entries = [makeEntry("CAM-1"), makeEntry("CAM-2"), makeEntry("CAM-3")];
		const { spawnFn, calls } = makeHappySpawn(makeIssuesLocalJson(entries));

		migrateIssuesToDir(CWD, spawnFn);

		const writeTreeCalls = calls.filter((c) => c.sub === "write-tree");
		expect(writeTreeCalls.length).toBe(1);
	});

	test("hash-object called once per issue (3 entries -> 3 hash-object calls)", () => {
		const entries = [makeEntry("CAM-1"), makeEntry("CAM-2"), makeEntry("CAM-3")];
		const { spawnFn, calls } = makeHappySpawn(makeIssuesLocalJson(entries));

		migrateIssuesToDir(CWD, spawnFn);

		const hashCalls = calls.filter((c) => c.sub === "hash-object");
		expect(hashCalls.length).toBe(entries.length);
	});

	test("issues.local.json deletion uses update-index --force-remove", () => {
		const entries = [makeEntry("CAM-1"), makeEntry("CAM-2")];
		const { spawnFn, calls } = makeHappySpawn(makeIssuesLocalJson(entries));

		migrateIssuesToDir(CWD, spawnFn);

		const removeCalls = calls.filter(
			(c) =>
				c.sub === "update-index" &&
				c.args.includes("--force-remove") &&
				c.args.includes("scripts/cam/issues.local.json"),
		);
		expect(removeCalls.length).toBe(1);
	});

	test("update-index --force-remove fires before the first hash-object (deletion in same commit)", () => {
		const entries = [makeEntry("CAM-1"), makeEntry("CAM-2")];
		const { spawnFn, calls } = makeHappySpawn(makeIssuesLocalJson(entries));

		migrateIssuesToDir(CWD, spawnFn);

		const removeIdx = calls.findIndex(
			(c) => c.sub === "update-index" && c.args.includes("--force-remove"),
		);
		const firstHashIdx = calls.findIndex((c) => c.sub === "hash-object");

		expect(removeIdx).toBeGreaterThanOrEqual(0);
		expect(firstHashIdx).toBeGreaterThanOrEqual(0);
		expect(removeIdx).toBeLessThan(firstHashIdx);
	});

	test("returns noOp:false with sha and correct issueCount", () => {
		const entries = [makeEntry("CAM-10"), makeEntry("CAM-20")];
		const { spawnFn } = makeHappySpawn(makeIssuesLocalJson(entries));

		const result = migrateIssuesToDir(CWD, spawnFn);

		expect(result.noOp).toBe(false);
		expect(result.issueCount).toBe(2);
		expect(typeof result.sha).toBe("string");
		expect((result.sha ?? "").length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// AC#3: Filename padding and id field preservation
// ---------------------------------------------------------------------------

describe("migrateIssuesToDir -- AC#3 filename and id field", () => {
	test("CAM-90 maps to filename scripts/cam/issues/CAM-0090.json", () => {
		const entries = [makeEntry("CAM-90")];
		const { spawnFn, calls } = makeHappySpawn(makeIssuesLocalJson(entries));

		migrateIssuesToDir(CWD, spawnFn);

		// The cacheinfo update-index call should reference the padded filename.
		const cacheinfoCalls = calls.filter(
			(c) =>
				c.sub === "update-index" &&
				c.args.some((a) => a.startsWith("100644,")),
		);
		const paths = cacheinfoCalls
			.map((c) => c.args.find((a) => a.startsWith("100644,")))
			.map((entry) => entry?.split(",")[2]);

		expect(paths).toContain("scripts/cam/issues/CAM-0090.json");
	});

	test("id field inside the committed JSON is unpadded (CAM-90, not CAM-0090)", () => {
		const entries = [makeEntry("CAM-90")];
		const inputMap = new Map<string, string>();

		const spawnFn: SpawnFn = (_cmd, args, opts) => {
			const sub = args[2] ?? "";

			if (sub === "show") {
				return ok(makeIssuesLocalJson(entries));
			}
			if (sub === "rev-parse") return ok(MAIN_SHA + "\n");
			if (sub === "read-tree") return ok();
			if (sub === "hash-object") {
				// Capture the stdin content (the JSON we're writing).
				if (opts.input !== undefined) {
					inputMap.set("cam-90", opts.input);
				}
				return ok(BLOB_SHA + "\n");
			}
			if (sub === "update-index") return ok();
			if (sub === "write-tree") return ok(TREE_SHA + "\n");
			if (sub === "commit-tree") return ok(COMMIT_SHA + "\n");
			if (sub === "update-ref") return ok();
			return ok();
		};

		migrateIssuesToDir(CWD, spawnFn);

		const written = inputMap.get("cam-90");
		expect(written).toBeDefined();
		const parsed = JSON.parse(written ?? "{}") as { id: string };
		expect(parsed.id).toBe("CAM-90"); // unpadded id field
	});

	test("3-digit id (CAM-999) maps to CAM-0999.json", () => {
		const entries = [makeEntry("CAM-999")];
		const { spawnFn, calls } = makeHappySpawn(makeIssuesLocalJson(entries));

		migrateIssuesToDir(CWD, spawnFn);

		const cacheinfoCalls = calls.filter(
			(c) =>
				c.sub === "update-index" &&
				c.args.some((a) => a.startsWith("100644,")),
		);
		const paths = cacheinfoCalls
			.map((c) => c.args.find((a) => a.startsWith("100644,")))
			.map((entry) => entry?.split(",")[2]);

		expect(paths).toContain("scripts/cam/issues/CAM-0999.json");
	});

	test("4-digit id (CAM-1000) maps to CAM-1000.json (no truncation)", () => {
		const entries = [makeEntry("CAM-1000")];
		const { spawnFn, calls } = makeHappySpawn(makeIssuesLocalJson(entries));

		migrateIssuesToDir(CWD, spawnFn);

		const cacheinfoCalls = calls.filter(
			(c) =>
				c.sub === "update-index" &&
				c.args.some((a) => a.startsWith("100644,")),
		);
		const paths = cacheinfoCalls
			.map((c) => c.args.find((a) => a.startsWith("100644,")))
			.map((entry) => entry?.split(",")[2]);

		expect(paths).toContain("scripts/cam/issues/CAM-1000.json");
	});

	test("N-issue array produces exactly N cacheinfo (write) calls", () => {
		const entries = Array.from({ length: 5 }, (_, i) => makeEntry(`CAM-${i + 1}`));
		const { spawnFn, calls } = makeHappySpawn(makeIssuesLocalJson(entries));

		migrateIssuesToDir(CWD, spawnFn);

		const cacheinfoCalls = calls.filter(
			(c) =>
				c.sub === "update-index" &&
				c.args.some((a) => a.startsWith("100644,")),
		);
		expect(cacheinfoCalls.length).toBe(entries.length);
	});
});

import { describe, expect, test } from "bun:test";
import type { SpawnSyncReturns } from "node:child_process";
import type { IssueEntry } from "../../src/issues/types.ts";
import { selectPlannableIssue, selectPlannableFromFile } from "../../src/issues/select.ts";
import type { BacklogSpawnFn } from "../../src/issues/backlog.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(
	overrides: Partial<IssueEntry> & { id: string },
): IssueEntry {
	return {
		title: "Test issue",
		stage: "specified",
		status: "open",
		blockedBy: [],
		createdAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Filter: only 'specified' + 'open' + unblocked entries qualify
// ---------------------------------------------------------------------------

describe("selectPlannableIssue — filter gate", () => {
	test("returns null for an empty backlog", () => {
		expect(selectPlannableIssue([])).toBeNull();
	});

	test("returns null when all entries are filtered out", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-1", stage: "idea" }),
			makeIssue({ id: "CAM-2", stage: "planned" }),
			makeIssue({ id: "CAM-3", stage: "shipped" }),
			makeIssue({ id: "CAM-4", status: "abandoned" }),
		];
		expect(selectPlannableIssue(backlog)).toBeNull();
	});

	test("idea-stage issue is invisible (never selected)", () => {
		const backlog: IssueEntry[] = [makeIssue({ id: "CAM-1", stage: "idea" })];
		expect(selectPlannableIssue(backlog)).toBeNull();
	});

	test("planned-stage issue is invisible (never selected)", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-1", stage: "planned" }),
		];
		expect(selectPlannableIssue(backlog)).toBeNull();
	});

	test("shipped-stage issue is invisible (never selected)", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-1", stage: "shipped" }),
		];
		expect(selectPlannableIssue(backlog)).toBeNull();
	});

	test("abandoned issue is excluded", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-1", status: "abandoned" }),
		];
		expect(selectPlannableIssue(backlog)).toBeNull();
	});

	test("blocked issue is excluded", () => {
		// CAM-2 is specified+open but blocks on CAM-1 which is not shipped.
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-1", stage: "specified" }),
			makeIssue({ id: "CAM-2", blockedBy: ["CAM-1"] }),
		];
		// CAM-1 qualifies (no blockers); CAM-2 is blocked.
		const result = selectPlannableIssue(backlog);
		expect(result?.id).toBe("CAM-1");
	});

	test("unblocked issue is selected when blocker is shipped", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-1", stage: "shipped" }),
			makeIssue({ id: "CAM-2", blockedBy: ["CAM-1"] }),
		];
		// CAM-1 is shipped so CAM-2 is no longer blocked.
		const result = selectPlannableIssue(backlog);
		expect(result?.id).toBe("CAM-2");
	});

	test("missing blocker id does not block the dependent", () => {
		// isBlocked only considers present, non-shipped deps.
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-5", blockedBy: ["CAM-MISSING"] }),
		];
		const result = selectPlannableIssue(backlog);
		expect(result?.id).toBe("CAM-5");
	});

	test("returns single qualifying entry", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-7", stage: "idea" }),
			makeIssue({ id: "CAM-8" }),
			makeIssue({ id: "CAM-9", stage: "shipped" }),
		];
		const result = selectPlannableIssue(backlog);
		expect(result?.id).toBe("CAM-8");
	});
});

// ---------------------------------------------------------------------------
// Sorting: ranked before unranked, then by rank, then by numeric id
// ---------------------------------------------------------------------------

describe("selectPlannableIssue — sort order", () => {
	test("ranked entries sort before unranked ones", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-5" }), // no rank
			makeIssue({ id: "CAM-3", rank: 2 }),
		];
		const result = selectPlannableIssue(backlog);
		expect(result?.id).toBe("CAM-3");
	});

	test("lower rank value wins over higher rank value", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-1", rank: 10 }),
			makeIssue({ id: "CAM-2", rank: 1 }),
		];
		const result = selectPlannableIssue(backlog);
		expect(result?.id).toBe("CAM-2");
	});

	test("when no entry has a rank, ordering is purely by numeric id", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-12" }),
			makeIssue({ id: "CAM-9" }),
			makeIssue({ id: "CAM-20" }),
		];
		const result = selectPlannableIssue(backlog);
		expect(result?.id).toBe("CAM-9");
	});

	test("ties by rank are broken numerically by id (CAM-9 before CAM-12)", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-12", rank: 1 }),
			makeIssue({ id: "CAM-9", rank: 1 }),
		];
		const result = selectPlannableIssue(backlog);
		expect(result?.id).toBe("CAM-9");
	});

	test("ranked entries all sort before unranked, then unranked by numeric id", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-3" }), // unranked
			makeIssue({ id: "CAM-1", rank: 5 }), // ranked
			makeIssue({ id: "CAM-2" }), // unranked
		];
		// Expected order: CAM-1 (ranked), CAM-2 (unranked id=2), CAM-3 (unranked id=3)
		const result = selectPlannableIssue(backlog);
		expect(result?.id).toBe("CAM-1");
	});

	test("all qualified entries with ranks: returns lowest rank first", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-4", rank: 3 }),
			makeIssue({ id: "CAM-5", rank: 1 }),
			makeIssue({ id: "CAM-6", rank: 2 }),
		];
		const result = selectPlannableIssue(backlog);
		expect(result?.id).toBe("CAM-5");
	});

	test("id with non-numeric suffix gets Infinity rank and sorts last among unranked", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-abc" }), // non-numeric -> Infinity
			makeIssue({ id: "CAM-5" }), // numeric -> 5
		];
		const result = selectPlannableIssue(backlog);
		expect(result?.id).toBe("CAM-5");
	});
});

// ---------------------------------------------------------------------------
// Edge cases: backlog not mutated, null propagation
// ---------------------------------------------------------------------------

describe("selectPlannableIssue — edge cases", () => {
	test("does not mutate the original backlog array", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-3", rank: 2 }),
			makeIssue({ id: "CAM-1", rank: 1 }),
		];
		const copy = [...backlog];
		selectPlannableIssue(backlog);
		expect(backlog.map((e) => e.id)).toEqual(copy.map((e) => e.id));
	});

	test("returns null when all backlog entries are shipped (all blocked)", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-1", stage: "shipped" }),
			makeIssue({ id: "CAM-2", stage: "shipped" }),
		];
		expect(selectPlannableIssue(backlog)).toBeNull();
	});

	test("complex mixed backlog: picks the correct winner", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-10", stage: "idea" }), // filtered: wrong stage
			makeIssue({ id: "CAM-11", status: "abandoned" }), // filtered: abandoned
			makeIssue({ id: "CAM-12", stage: "specified", rank: 2 }), // candidate, rank 2
			makeIssue({ id: "CAM-9", stage: "specified", rank: 1 }), // candidate, rank 1
			makeIssue({ id: "CAM-13", blockedBy: ["CAM-12"] }), // blocked by CAM-12
		];
		const result = selectPlannableIssue(backlog);
		expect(result?.id).toBe("CAM-9");
	});
});

// ---------------------------------------------------------------------------
// selectPlannableFromFile -- dir-backed fixture (injectable spawnFn)
// ---------------------------------------------------------------------------

/** Minimal SpawnSyncReturns<string> stub. */
function stubReturn(stdout: string): SpawnSyncReturns<string> {
	return {
		stdout,
		stderr: "",
		status: 0,
		output: [],
		pid: 0,
		signal: null,
		error: undefined,
	};
}

/**
 * Build the framed output that `git cat-file --batch` would emit for the
 * given entries (same format as test/issues/backlog.test.ts).
 */
function makeBatchOutput(entries: IssueEntry[]): string {
	let output = "";
	for (const entry of entries) {
		const content = JSON.stringify(entry);
		const size = Buffer.byteLength(content, "utf8");
		output += `deadbeef0000000000000000000000000000000000 blob ${size}\n${content}\n`;
	}
	return output;
}

/**
 * Build a fake BacklogSpawnFn that serves ls-tree paths on the first call
 * and cat-file batch output on the second call.
 */
function makeSpawnFn(entries: IssueEntry[]): BacklogSpawnFn {
	const paths = entries.map(
		(e) =>
			`scripts/cam/issues/CAM-${String(parseInt(e.id.split("-").at(-1) ?? "0", 10)).padStart(4, "0")}.json`,
	);
	const lsTreeOut = paths.join("\n") + (paths.length > 0 ? "\n" : "");
	const batchOut = makeBatchOutput(entries);

	return (_cmd, args, _opts) => {
		// git -C <cwd> <subCmd> ...  => subCmd is at index 2
		const subCmd = args[2] ?? "";
		if (subCmd === "ls-tree") {
			return stubReturn(lsTreeOut);
		}
		if (subCmd === "cat-file") {
			return stubReturn(batchOut);
		}
		return stubReturn("");
	};
}

describe("selectPlannableFromFile -- dir-backed fixture", () => {
	test("returns null when the dir is empty (no issues)", () => {
		const spawn = makeSpawnFn([]);
		expect(selectPlannableFromFile("/repo", spawn)).toBeNull();
	});

	test("returns the single plannable issue from a dir-backed fixture", () => {
		const entries: IssueEntry[] = [
			makeIssue({ id: "CAM-7", stage: "idea" }),
			makeIssue({ id: "CAM-8" }),
			makeIssue({ id: "CAM-9", stage: "shipped" }),
		];
		const spawn = makeSpawnFn(entries);
		const result = selectPlannableFromFile("/repo", spawn);
		expect(result?.id).toBe("CAM-8");
	});

	test("dir-backed result matches array-backed result for an equivalent fixture", () => {
		// Build a fixture that matches the complex mixed backlog test above.
		const entries: IssueEntry[] = [
			makeIssue({ id: "CAM-10", stage: "idea" }),
			makeIssue({ id: "CAM-11", status: "abandoned" }),
			makeIssue({ id: "CAM-12", stage: "specified", rank: 2 }),
			makeIssue({ id: "CAM-9", stage: "specified", rank: 1 }),
			makeIssue({ id: "CAM-13", blockedBy: ["CAM-12"] }),
		];

		// Array-backed (pure function):
		const arrayResult = selectPlannableIssue(entries);

		// Dir-backed (I/O seam with injected spawnFn):
		const spawn = makeSpawnFn(entries);
		const dirResult = selectPlannableFromFile("/repo", spawn);

		expect(dirResult?.id).toBe(arrayResult?.id);
		expect(dirResult?.id).toBe("CAM-9");
	});

	test("returns null when spawnFn throws", () => {
		const throwingSpawn: BacklogSpawnFn = () => {
			throw new Error("git not found");
		};
		expect(selectPlannableFromFile("/repo", throwingSpawn)).toBeNull();
	});
});

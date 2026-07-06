import { describe, expect, test } from "bun:test";
import type { SpawnSyncReturns } from "node:child_process";
import type { IssueEntry } from "../../src/issues/types.ts";
import {
	selectPlannableIssue,
	selectPlannableFromFile,
	selectPlannableById,
	selectPlanTargetFromFile,
} from "../../src/issues/select.ts";
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
	test("an unranked candidate WITHOUT wsjf still loses to every ranked one (WSJF 0 never beats a ranked candidate)", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-5" }), // no rank, no wsjf -> WSJF 0
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
// WSJF competition: unranked issues compete by WSJF (US-001, CAM-203)
// ---------------------------------------------------------------------------

describe("selectPlannableIssue — unranked-vs-ranked WSJF competition", () => {
	test("an unranked issue with WSJF 5.0 beats a ranked (rank:13) issue with WSJF 2.0 (CAM-201 vs CAM-66 regression)", () => {
		const backlog: IssueEntry[] = [
			makeIssue({
				id: "CAM-66",
				rank: 13,
				wsjf: { value: 2, timeCriticality: 0, riskReduction: 0, jobSize: 1 },
			}),
			makeIssue({
				id: "CAM-201",
				wsjf: { value: 5, timeCriticality: 0, riskReduction: 0, jobSize: 1 },
			}),
		];
		const result = selectPlannableIssue(backlog);
		expect(result?.id).toBe("CAM-201");
	});

	test("when both candidates are ranked, rank ascending stays authoritative regardless of WSJF", () => {
		const backlog: IssueEntry[] = [
			makeIssue({
				id: "CAM-1",
				rank: 1,
				wsjf: { value: 1, timeCriticality: 0, riskReduction: 0, jobSize: 1 },
			}),
			makeIssue({
				id: "CAM-2",
				rank: 2,
				wsjf: { value: 9, timeCriticality: 0, riskReduction: 0, jobSize: 1 },
			}),
		];
		const result = selectPlannableIssue(backlog);
		expect(result?.id).toBe("CAM-1");
	});

	test("an unranked candidate with wsjf absent is treated as WSJF 0 and never beats a ranked candidate", () => {
		const backlog: IssueEntry[] = [
			makeIssue({
				id: "CAM-1",
				rank: 1,
				wsjf: { value: 0.5, timeCriticality: 0, riskReduction: 0, jobSize: 1 },
			}),
			makeIssue({ id: "CAM-2" }), // no wsjf field -> WSJF 0
		];
		const result = selectPlannableIssue(backlog);
		expect(result?.id).toBe("CAM-1");
	});

	test("an unranked candidate with jobSize <= 0 is treated as WSJF 0 and never beats a ranked candidate", () => {
		const backlog: IssueEntry[] = [
			makeIssue({
				id: "CAM-1",
				rank: 1,
				wsjf: { value: 0.5, timeCriticality: 0, riskReduction: 0, jobSize: 1 },
			}),
			makeIssue({
				id: "CAM-2",
				wsjf: { value: 99, timeCriticality: 0, riskReduction: 0, jobSize: 0 },
			}),
		];
		const result = selectPlannableIssue(backlog);
		expect(result?.id).toBe("CAM-1");
	});

	test("on a WSJF tie between the ranked champion and the unranked champion, the ranked candidate wins", () => {
		const backlog: IssueEntry[] = [
			makeIssue({
				id: "CAM-1",
				rank: 1,
				wsjf: { value: 3, timeCriticality: 0, riskReduction: 0, jobSize: 1 },
			}),
			makeIssue({
				id: "CAM-2",
				wsjf: { value: 3, timeCriticality: 0, riskReduction: 0, jobSize: 1 },
			}),
		];
		const result = selectPlannableIssue(backlog);
		expect(result?.id).toBe("CAM-1");
	});

	test("an unranked candidate beats a ranked candidate only when strictly higher WSJF", () => {
		const backlog: IssueEntry[] = [
			makeIssue({
				id: "CAM-1",
				rank: 1,
				wsjf: { value: 3, timeCriticality: 0, riskReduction: 0, jobSize: 1 },
			}),
			makeIssue({
				id: "CAM-2",
				wsjf: { value: 3.01, timeCriticality: 0, riskReduction: 0, jobSize: 1 },
			}),
		];
		const result = selectPlannableIssue(backlog);
		expect(result?.id).toBe("CAM-2");
	});

	test("numeric id suffix remains the final deterministic tie-break among unranked champions", () => {
		const backlog: IssueEntry[] = [
			makeIssue({
				id: "CAM-12",
				wsjf: { value: 5, timeCriticality: 0, riskReduction: 0, jobSize: 1 },
			}),
			makeIssue({
				id: "CAM-9",
				wsjf: { value: 5, timeCriticality: 0, riskReduction: 0, jobSize: 1 },
			}),
		];
		const result = selectPlannableIssue(backlog);
		expect(result?.id).toBe("CAM-9");
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

	test("matches selectPlannableIssue for the unranked-high-WSJF fixture (CAM-201 vs CAM-66)", () => {
		const entries: IssueEntry[] = [
			makeIssue({
				id: "CAM-66",
				rank: 13,
				wsjf: { value: 2, timeCriticality: 0, riskReduction: 0, jobSize: 1 },
			}),
			makeIssue({
				id: "CAM-201",
				wsjf: { value: 5, timeCriticality: 0, riskReduction: 0, jobSize: 1 },
			}),
		];

		const arrayResult = selectPlannableIssue(entries);
		const spawn = makeSpawnFn(entries);
		const dirResult = selectPlannableFromFile("/repo", spawn);

		expect(dirResult?.id).toBe(arrayResult?.id);
		expect(dirResult?.id).toBe("CAM-201");
	});
});

// ---------------------------------------------------------------------------
// selectPlannableById -- target-aware selector (US-001, CAM-154)
// ---------------------------------------------------------------------------

describe("selectPlannableById", () => {
	test("returns the exact issue when plannable", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-1", rank: 5 }),
			makeIssue({ id: "CAM-9", rank: 1 }), // top-of-queue winner
		];
		// CAM-1 is plannable but not top-of-queue; should return it anyway.
		const result = selectPlannableById(backlog, "CAM-1");
		expect(result?.id).toBe("CAM-1");
	});

	test("returns null when target id is absent from the backlog", () => {
		const backlog: IssueEntry[] = [makeIssue({ id: "CAM-1" })];
		expect(selectPlannableById(backlog, "CAM-999")).toBeNull();
	});

	test("returns null when target issue has wrong stage (not plannable)", () => {
		const backlog: IssueEntry[] = [makeIssue({ id: "CAM-1", stage: "idea" })];
		expect(selectPlannableById(backlog, "CAM-1")).toBeNull();
	});

	test("returns null when target issue has wrong status (abandoned)", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-1", status: "abandoned" }),
		];
		expect(selectPlannableById(backlog, "CAM-1")).toBeNull();
	});

	test("returns null when target issue is blocked by an unshipped dep", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-1", stage: "specified" }),
			makeIssue({ id: "CAM-2", blockedBy: ["CAM-1"] }),
		];
		// CAM-2 is blocked; never falls back to CAM-1.
		expect(selectPlannableById(backlog, "CAM-2")).toBeNull();
	});

	test("NEVER falls back to a different issue when target is non-plannable", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-1", rank: 1 }), // plannable top-of-queue
			makeIssue({ id: "CAM-2", stage: "idea" }), // non-plannable target
		];
		// Must return null, not CAM-1.
		expect(selectPlannableById(backlog, "CAM-2")).toBeNull();
	});

	test("matches on exact id string equality, not numeric suffix", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "PRJ-1" }),
			makeIssue({ id: "CAM-1" }),
		];
		// "CAM-1" !== "PRJ-1" even though numeric suffix is the same.
		expect(selectPlannableById(backlog, "PRJ-1")?.id).toBe("PRJ-1");
	});

	test("returns null for an empty backlog", () => {
		expect(selectPlannableById([], "CAM-1")).toBeNull();
	});

	test("returns entry when target is unblocked after its dep ships", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-1", stage: "shipped" }),
			makeIssue({ id: "CAM-2", blockedBy: ["CAM-1"] }),
		];
		expect(selectPlannableById(backlog, "CAM-2")?.id).toBe("CAM-2");
	});
});

// ---------------------------------------------------------------------------
// selectPlanTargetFromFile -- file-backed target-aware selector (US-001, CAM-154)
// ---------------------------------------------------------------------------

describe("selectPlanTargetFromFile -- no targetId (preserves top-of-queue)", () => {
	test("undefined targetId returns top-of-queue", () => {
		const entries: IssueEntry[] = [
			makeIssue({ id: "CAM-1", rank: 2 }),
			makeIssue({ id: "CAM-2", rank: 1 }),
		];
		const spawn = makeSpawnFn(entries);
		const result = selectPlanTargetFromFile("/repo", undefined, spawn);
		expect(result?.id).toBe("CAM-2"); // top-of-queue (rank 1)
	});

	test("null targetId returns top-of-queue", () => {
		const entries: IssueEntry[] = [makeIssue({ id: "CAM-5", rank: 1 })];
		const spawn = makeSpawnFn(entries);
		const result = selectPlanTargetFromFile("/repo", null, spawn);
		expect(result?.id).toBe("CAM-5");
	});

	test("returns null when no plannable issues exist and targetId is undefined", () => {
		const entries: IssueEntry[] = [makeIssue({ id: "CAM-1", stage: "idea" })];
		const spawn = makeSpawnFn(entries);
		expect(selectPlanTargetFromFile("/repo", undefined, spawn)).toBeNull();
	});
});

describe("selectPlanTargetFromFile -- with targetId (target-aware)", () => {
	test("non-empty targetId returns the exact plannable issue", () => {
		const entries: IssueEntry[] = [
			makeIssue({ id: "CAM-1", rank: 5 }),
			makeIssue({ id: "CAM-9", rank: 1 }),
		];
		const spawn = makeSpawnFn(entries);
		const result = selectPlanTargetFromFile("/repo", "CAM-1", spawn);
		expect(result?.id).toBe("CAM-1");
	});

	test("non-empty targetId returns null when target is non-plannable (NEVER falls back)", () => {
		const entries: IssueEntry[] = [
			makeIssue({ id: "CAM-1", rank: 1 }), // top-of-queue, plannable
			makeIssue({ id: "CAM-2", stage: "idea" }), // non-plannable target
		];
		const spawn = makeSpawnFn(entries);
		// Must not fall back to CAM-1.
		expect(selectPlanTargetFromFile("/repo", "CAM-2", spawn)).toBeNull();
	});

	test("non-empty targetId returns null when absent from backlog (NEVER falls back)", () => {
		const entries: IssueEntry[] = [makeIssue({ id: "CAM-1", rank: 1 })];
		const spawn = makeSpawnFn(entries);
		expect(selectPlanTargetFromFile("/repo", "CAM-999", spawn)).toBeNull();
	});

	test("returns null when spawnFn throws (error safety)", () => {
		const throwingSpawn: BacklogSpawnFn = () => {
			throw new Error("git not found");
		};
		expect(
			selectPlanTargetFromFile("/repo", "CAM-1", throwingSpawn),
		).toBeNull();
	});
});

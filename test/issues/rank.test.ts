import { test, expect, describe } from "bun:test";
import { rankIssues } from "../../src/issues/rank.ts";
import type { IssueEntry } from "../../src/issues/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(
	id: string,
	opts: {
		stage?: IssueEntry["stage"];
		status?: IssueEntry["status"];
		blockedBy?: string[];
		wsjf?: { value: number; timeCriticality: number; riskReduction: number; jobSize: number };
	} = {},
): IssueEntry {
	return {
		id,
		title: id,
		stage: opts.stage ?? "specified",
		status: opts.status ?? "open",
		blockedBy: opts.blockedBy ?? [],
		createdAt: "2026-01-01T00:00:00.000Z",
		wsjf: opts.wsjf,
	};
}

// WSJF helper: (value+timeCriticality+riskReduction)/jobSize
function wsjf(value: number, tc: number, rr: number, js: number) {
	return { value, timeCriticality: tc, riskReduction: rr, jobSize: js };
}

// ---------------------------------------------------------------------------
// Universe filter
// ---------------------------------------------------------------------------

describe("universe filter", () => {
	test("includes only stage:specified + status:open", () => {
		const issues: IssueEntry[] = [
			makeIssue("CAM-1", { stage: "specified", status: "open", wsjf: wsjf(3, 1, 1, 1) }),
			makeIssue("CAM-2", { stage: "idea", status: "open", wsjf: wsjf(3, 1, 1, 1) }),
			makeIssue("CAM-3", { stage: "shipped", status: "open", wsjf: wsjf(3, 1, 1, 1) }),
			makeIssue("CAM-4", { stage: "specified", status: "abandoned", wsjf: wsjf(3, 1, 1, 1) }),
		];
		const result = rankIssues(issues);
		expect(result.ranked).toHaveLength(1);
		expect(result.ranked[0]?.id).toBe("CAM-1");
	});

	test("empty backlog returns empty result", () => {
		const result = rankIssues([]);
		expect(result.ranked).toHaveLength(0);
		expect(result.warnings).toHaveLength(0);
		expect(result.residualIds).toHaveLength(0);
	});

	test("all issues non-qualifying returns empty result", () => {
		const issues: IssueEntry[] = [
			makeIssue("CAM-1", { stage: "idea" }),
			makeIssue("CAM-2", { stage: "shipped" }),
		];
		const result = rankIssues(issues);
		expect(result.ranked).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Kahn layering
// ---------------------------------------------------------------------------

describe("Kahn topological layering", () => {
	test("independent issues: all in layer 1, ordered by WSJF desc", () => {
		const issues: IssueEntry[] = [
			makeIssue("CAM-1", { wsjf: wsjf(2, 0, 0, 1) }), // WSJF 2
			makeIssue("CAM-2", { wsjf: wsjf(5, 0, 0, 1) }), // WSJF 5
			makeIssue("CAM-3", { wsjf: wsjf(3, 0, 0, 1) }), // WSJF 3
		];
		const result = rankIssues(issues);
		expect(result.ranked.map((r) => r.id)).toEqual(["CAM-2", "CAM-3", "CAM-1"]);
		expect(result.ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
	});

	test("blocker must rank before the blocked issue (different layers)", () => {
		// CAM-2 blockedBy CAM-1: CAM-1 must come first
		const issues: IssueEntry[] = [
			makeIssue("CAM-1", { wsjf: wsjf(1, 0, 0, 1) }), // WSJF 1
			makeIssue("CAM-2", { blockedBy: ["CAM-1"], wsjf: wsjf(9, 0, 0, 1) }), // WSJF 9 but blocked
		];
		const result = rankIssues(issues);
		expect(result.ranked[0]?.id).toBe("CAM-1");
		expect(result.ranked[1]?.id).toBe("CAM-2");
		expect(result.ranked[0]?.rank).toBe(1);
		expect(result.ranked[1]?.rank).toBe(2);
	});

	test("chain: A -> B -> C ranks in dependency order", () => {
		// CAM-3 blocked by CAM-2, CAM-2 blocked by CAM-1
		const issues: IssueEntry[] = [
			makeIssue("CAM-1", { wsjf: wsjf(1, 0, 0, 1) }),
			makeIssue("CAM-2", { blockedBy: ["CAM-1"], wsjf: wsjf(1, 0, 0, 1) }),
			makeIssue("CAM-3", { blockedBy: ["CAM-2"], wsjf: wsjf(1, 0, 0, 1) }),
		];
		const result = rankIssues(issues);
		expect(result.ranked.map((r) => r.id)).toEqual(["CAM-1", "CAM-2", "CAM-3"]);
	});

	test("two independent chains: high-WSJF layer members interleave correctly", () => {
		// Layer 1: CAM-1 (WSJF 5) and CAM-3 (WSJF 3)
		// Layer 2: CAM-2 (blocked by CAM-1) and CAM-4 (blocked by CAM-3)
		const issues: IssueEntry[] = [
			makeIssue("CAM-1", { wsjf: wsjf(5, 0, 0, 1) }),
			makeIssue("CAM-2", { blockedBy: ["CAM-1"], wsjf: wsjf(10, 0, 0, 1) }),
			makeIssue("CAM-3", { wsjf: wsjf(3, 0, 0, 1) }),
			makeIssue("CAM-4", { blockedBy: ["CAM-3"], wsjf: wsjf(10, 0, 0, 1) }),
		];
		const result = rankIssues(issues);
		// Layer 1: CAM-1 (WSJF 5) then CAM-3 (WSJF 3)
		expect(result.ranked[0]?.id).toBe("CAM-1");
		expect(result.ranked[1]?.id).toBe("CAM-3");
		// Layer 2: CAM-2 and CAM-4 both WSJF 10, tie broken by numeric id
		expect(result.ranked[2]?.id).toBe("CAM-2");
		expect(result.ranked[3]?.id).toBe("CAM-4");
	});
});

// ---------------------------------------------------------------------------
// Shipped blockers treated as satisfied
// ---------------------------------------------------------------------------

describe("shipped blockers are satisfied edges", () => {
	test("shipped blocker does not count as in-degree", () => {
		const issues: IssueEntry[] = [
			makeIssue("CAM-1", { stage: "shipped", status: "open" }),
			makeIssue("CAM-2", { blockedBy: ["CAM-1"], wsjf: wsjf(5, 0, 0, 1) }),
		];
		// CAM-1 is shipped: not in the universe; CAM-2 should be rank 1
		const result = rankIssues(issues);
		expect(result.ranked).toHaveLength(1);
		expect(result.ranked[0]?.id).toBe("CAM-2");
		expect(result.ranked[0]?.rank).toBe(1);
	});

	test("blocker outside the universe (stage:idea) is treated as satisfied", () => {
		const issues: IssueEntry[] = [
			makeIssue("CAM-1", { stage: "idea" }),
			makeIssue("CAM-2", { blockedBy: ["CAM-1"], wsjf: wsjf(5, 0, 0, 1) }),
		];
		const result = rankIssues(issues);
		expect(result.ranked).toHaveLength(1);
		expect(result.ranked[0]?.id).toBe("CAM-2");
	});

	test("unknown blockedBy id treated as satisfied (dangling ref)", () => {
		const issues: IssueEntry[] = [
			makeIssue("CAM-1", { blockedBy: ["CAM-999"], wsjf: wsjf(5, 0, 0, 1) }),
		];
		const result = rankIssues(issues);
		expect(result.ranked).toHaveLength(1);
		expect(result.ranked[0]?.id).toBe("CAM-1");
	});
});

// ---------------------------------------------------------------------------
// WSJF computation
// ---------------------------------------------------------------------------

describe("WSJF computation", () => {
	test("WSJF = (value + timeCriticality + riskReduction) / jobSize", () => {
		const issues: IssueEntry[] = [
			makeIssue("CAM-1", { wsjf: wsjf(3, 2, 1, 2) }), // (3+2+1)/2 = 3
			makeIssue("CAM-2", { wsjf: wsjf(4, 4, 2, 2) }), // (4+4+2)/2 = 5
		];
		const result = rankIssues(issues);
		expect(result.ranked[0]?.id).toBe("CAM-2");
		expect(result.ranked[0]?.wsjf).toBeCloseTo(5, 5);
		expect(result.ranked[1]?.id).toBe("CAM-1");
		expect(result.ranked[1]?.wsjf).toBeCloseTo(3, 5);
	});

	test("missing wsjf field => WSJF 0 + warning, no throw", () => {
		const issues: IssueEntry[] = [
			makeIssue("CAM-1"), // no wsjf
		];
		expect(() => rankIssues(issues)).not.toThrow();
		const result = rankIssues(issues);
		expect(result.ranked[0]?.wsjf).toBe(0);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("CAM-1");
		expect(result.warnings[0]).toContain("wsjf field absent");
	});

	test("jobSize = 0 => WSJF 0 + warning, no throw (no divide-by-zero)", () => {
		const issues: IssueEntry[] = [
			makeIssue("CAM-1", { wsjf: wsjf(5, 3, 2, 0) }), // jobSize 0
		];
		expect(() => rankIssues(issues)).not.toThrow();
		const result = rankIssues(issues);
		expect(result.ranked[0]?.wsjf).toBe(0);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("CAM-1");
		expect(result.warnings[0]).toContain("jobSize=0");
	});

	test("jobSize < 0 => WSJF 0 + warning, no throw", () => {
		const issues: IssueEntry[] = [
			makeIssue("CAM-1", { wsjf: wsjf(5, 3, 2, -1) }), // jobSize -1
		];
		const result = rankIssues(issues);
		expect(result.ranked[0]?.wsjf).toBe(0);
		expect(result.warnings).toHaveLength(1);
	});

	test("multiple issues with missing wsjf: each gets one warning", () => {
		const issues: IssueEntry[] = [
			makeIssue("CAM-1"),
			makeIssue("CAM-2"),
		];
		const result = rankIssues(issues);
		expect(result.warnings).toHaveLength(2);
	});

	test("missing-wsjf issue sorts last in its layer (WSJF 0 = lowest)", () => {
		const issues: IssueEntry[] = [
			makeIssue("CAM-1"), // no wsjf -> WSJF 0
			makeIssue("CAM-2", { wsjf: wsjf(1, 0, 0, 1) }), // WSJF 1
		];
		const result = rankIssues(issues);
		expect(result.ranked[0]?.id).toBe("CAM-2"); // higher WSJF first
		expect(result.ranked[1]?.id).toBe("CAM-1");
	});
});

// ---------------------------------------------------------------------------
// Numeric id tie-break
// ---------------------------------------------------------------------------

describe("numeric id tie-break", () => {
	test("CAM-9 ranks before CAM-12 when WSJF is equal", () => {
		const issues: IssueEntry[] = [
			makeIssue("CAM-12", { wsjf: wsjf(3, 0, 0, 1) }),
			makeIssue("CAM-9", { wsjf: wsjf(3, 0, 0, 1) }),
		];
		const result = rankIssues(issues);
		expect(result.ranked[0]?.id).toBe("CAM-9");
		expect(result.ranked[1]?.id).toBe("CAM-12");
	});

	test("non-numeric id suffix sorts to the end (Infinity)", () => {
		const issues: IssueEntry[] = [
			makeIssue("CAM-abc", { wsjf: wsjf(3, 0, 0, 1) }),
			makeIssue("CAM-1", { wsjf: wsjf(3, 0, 0, 1) }),
		];
		const result = rankIssues(issues);
		expect(result.ranked[0]?.id).toBe("CAM-1");
		expect(result.ranked[1]?.id).toBe("CAM-abc");
	});

	test("mirrors selectPlannableIssue tie-break: multi-digit vs single-digit", () => {
		const issues: IssueEntry[] = [
			makeIssue("CAM-10", { wsjf: wsjf(2, 0, 0, 1) }),
			makeIssue("CAM-9", { wsjf: wsjf(2, 0, 0, 1) }),
			makeIssue("CAM-2", { wsjf: wsjf(2, 0, 0, 1) }),
		];
		const result = rankIssues(issues);
		expect(result.ranked.map((r) => r.id)).toEqual(["CAM-2", "CAM-9", "CAM-10"]);
	});
});

// ---------------------------------------------------------------------------
// Dense 1-based rank
// ---------------------------------------------------------------------------

describe("dense 1-based rank", () => {
	test("ranks are 1..N with no gaps", () => {
		const issues: IssueEntry[] = [
			makeIssue("CAM-1", { wsjf: wsjf(3, 0, 0, 1) }),
			makeIssue("CAM-2", { wsjf: wsjf(2, 0, 0, 1) }),
			makeIssue("CAM-3", { wsjf: wsjf(1, 0, 0, 1) }),
		];
		const result = rankIssues(issues);
		expect(result.ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
	});
});

// ---------------------------------------------------------------------------
// Cycle detection (residualIds)
// ---------------------------------------------------------------------------

describe("cycle detection via residualIds", () => {
	test("acyclic graph produces empty residualIds", () => {
		const issues: IssueEntry[] = [
			makeIssue("CAM-1", { wsjf: wsjf(5, 0, 0, 1) }),
			makeIssue("CAM-2", { blockedBy: ["CAM-1"], wsjf: wsjf(3, 0, 0, 1) }),
		];
		const result = rankIssues(issues);
		expect(result.residualIds).toHaveLength(0);
	});

	test("cycle: two issues blocking each other leaves both in residualIds", () => {
		// CAM-1 blocked by CAM-2, CAM-2 blocked by CAM-1 -> cycle
		const issues: IssueEntry[] = [
			makeIssue("CAM-1", { blockedBy: ["CAM-2"], wsjf: wsjf(5, 0, 0, 1) }),
			makeIssue("CAM-2", { blockedBy: ["CAM-1"], wsjf: wsjf(3, 0, 0, 1) }),
		];
		const result = rankIssues(issues);
		expect(result.ranked).toHaveLength(0);
		expect(result.residualIds.sort()).toEqual(["CAM-1", "CAM-2"]);
	});

	test("partial cycle: non-cycle members still rank, cycle members go to residual", () => {
		// CAM-1 free; CAM-2 <-> CAM-3 cycle
		const issues: IssueEntry[] = [
			makeIssue("CAM-1", { wsjf: wsjf(5, 0, 0, 1) }),
			makeIssue("CAM-2", { blockedBy: ["CAM-3"], wsjf: wsjf(3, 0, 0, 1) }),
			makeIssue("CAM-3", { blockedBy: ["CAM-2"], wsjf: wsjf(2, 0, 0, 1) }),
		];
		const result = rankIssues(issues);
		expect(result.ranked).toHaveLength(1);
		expect(result.ranked[0]?.id).toBe("CAM-1");
		expect(result.residualIds.sort()).toEqual(["CAM-2", "CAM-3"]);
	});
});

// ---------------------------------------------------------------------------
// Return shape
// ---------------------------------------------------------------------------

describe("return shape", () => {
	test("ranked entries have id, rank, wsjf, stage fields", () => {
		const issues: IssueEntry[] = [
			makeIssue("CAM-1", { wsjf: wsjf(5, 0, 0, 1) }),
		];
		const result = rankIssues(issues);
		expect(result.ranked[0]).toMatchObject({
			id: "CAM-1",
			rank: 1,
			wsjf: 5,
			stage: "specified",
		});
	});
});

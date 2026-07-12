import { describe, expect, test } from "bun:test";
import type { IssueEntry } from "../../src/issues/types.ts";
import { deriveBacklogJson, deriveBacklogView } from "../../src/issues/list.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(
	overrides: Partial<IssueEntry> & { id: string },
): IssueEntry {
	return {
		title: "Test issue",
		stage: "idea",
		status: "open",
		blockedBy: [],
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Grouping: lifecycle order, shipped/abandoned excluded by default
// ---------------------------------------------------------------------------

describe("deriveBacklogView — grouping", () => {
	test("empty backlog yields 3 empty groups in lifecycle order", () => {
		const view = deriveBacklogView([]);
		expect(view.map((g) => g.stage)).toEqual(["idea", "specified", "planned"]);
		for (const group of view) {
			expect(group.entries).toEqual([]);
		}
	});

	test("mixed-stage fixture: group membership and counts", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-1", stage: "idea" }),
			makeIssue({ id: "CAM-2", stage: "idea" }),
			makeIssue({ id: "CAM-3", stage: "specified" }),
			makeIssue({ id: "CAM-4", stage: "planned" }),
			makeIssue({ id: "CAM-5", stage: "shipped" }),
		];
		const view = deriveBacklogView(backlog);
		expect(view.map((g) => g.stage)).toEqual(["idea", "specified", "planned"]);

		const idea = view.find((g) => g.stage === "idea");
		const specified = view.find((g) => g.stage === "specified");
		const planned = view.find((g) => g.stage === "planned");

		expect(idea?.entries.map((e) => e.issue.id)).toEqual(["CAM-1", "CAM-2"]);
		expect(specified?.entries.map((e) => e.issue.id)).toEqual(["CAM-3"]);
		expect(planned?.entries.map((e) => e.issue.id)).toEqual(["CAM-4"]);
	});

	test("stage:shipped entries are excluded from the default view (no shipped group)", () => {
		const backlog: IssueEntry[] = [makeIssue({ id: "CAM-1", stage: "shipped" })];
		const view = deriveBacklogView(backlog);
		expect(view.some((g) => g.stage === "shipped")).toBe(false);
		for (const group of view) {
			expect(group.entries.find((e) => e.issue.id === "CAM-1")).toBeUndefined();
		}
	});

	test("status:abandoned entries are excluded by default", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-1", stage: "idea", status: "abandoned" }),
		];
		const view = deriveBacklogView(backlog);
		const idea = view.find((g) => g.stage === "idea");
		expect(idea?.entries).toEqual([]);
	});

	test("includeShipped appends a shipped group (excluding abandoned)", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-1", stage: "shipped" }),
			makeIssue({ id: "CAM-2", stage: "shipped", status: "abandoned" }),
			makeIssue({ id: "CAM-3", stage: "idea" }),
		];
		const view = deriveBacklogView(backlog, { includeShipped: true });
		expect(view.map((g) => g.stage)).toEqual([
			"idea",
			"specified",
			"planned",
			"shipped",
		]);
		const shipped = view.find((g) => g.stage === "shipped");
		expect(shipped?.entries.map((e) => e.issue.id)).toEqual(["CAM-1"]);
	});
});

// ---------------------------------------------------------------------------
// Regression: filter keys on stage, never on status (CAM-139)
// ---------------------------------------------------------------------------

describe("deriveBacklogView — CAM-139 regression (stage, never status)", () => {
	test("a shipped issue with status:'open' does NOT appear in the default view", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-140", stage: "shipped", status: "open" }),
			makeIssue({ id: "CAM-1", stage: "idea", status: "open" }),
		];
		const view = deriveBacklogView(backlog);
		const allIds = view.flatMap((g) => g.entries.map((e) => e.issue.id));
		expect(allIds).toEqual(["CAM-1"]);
	});

	test("a shipped issue with status:'open' also does not leak into includeShipped's non-shipped groups", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-140", stage: "shipped", status: "open" }),
		];
		const view = deriveBacklogView(backlog, { includeShipped: true });
		const idea = view.find((g) => g.stage === "idea");
		const specified = view.find((g) => g.stage === "specified");
		const planned = view.find((g) => g.stage === "planned");
		const shipped = view.find((g) => g.stage === "shipped");
		expect(idea?.entries).toEqual([]);
		expect(specified?.entries).toEqual([]);
		expect(planned?.entries).toEqual([]);
		expect(shipped?.entries.map((e) => e.issue.id)).toEqual(["CAM-140"]);
	});
});

// ---------------------------------------------------------------------------
// Sort order within a stage group (mirrors selectPlannableIssue semantics)
// ---------------------------------------------------------------------------

describe("deriveBacklogView — sort order", () => {
	test("ranked entries sort before unranked ones", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-5", stage: "idea" }), // no rank
			makeIssue({ id: "CAM-3", stage: "idea", rank: 2 }),
		];
		const view = deriveBacklogView(backlog);
		const idea = view.find((g) => g.stage === "idea");
		expect(idea?.entries.map((e) => e.issue.id)).toEqual(["CAM-3", "CAM-5"]);
	});

	test("lower rank value wins over higher rank value", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-1", stage: "planned", rank: 10 }),
			makeIssue({ id: "CAM-2", stage: "planned", rank: 1 }),
		];
		const view = deriveBacklogView(backlog);
		const planned = view.find((g) => g.stage === "planned");
		expect(planned?.entries.map((e) => e.issue.id)).toEqual(["CAM-2", "CAM-1"]);
	});

	test("ties by rank are broken numerically by id (CAM-9 before CAM-12)", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-12", stage: "specified", rank: 1 }),
			makeIssue({ id: "CAM-9", stage: "specified", rank: 1 }),
		];
		const view = deriveBacklogView(backlog);
		const specified = view.find((g) => g.stage === "specified");
		expect(specified?.entries.map((e) => e.issue.id)).toEqual([
			"CAM-9",
			"CAM-12",
		]);
	});

	test("when no entry has a rank, ordering is purely by numeric id", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-12", stage: "idea" }),
			makeIssue({ id: "CAM-9", stage: "idea" }),
			makeIssue({ id: "CAM-20", stage: "idea" }),
		];
		const view = deriveBacklogView(backlog);
		const idea = view.find((g) => g.stage === "idea");
		expect(idea?.entries.map((e) => e.issue.id)).toEqual([
			"CAM-9",
			"CAM-12",
			"CAM-20",
		]);
	});

	test("does not mutate the original backlog array", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-3", stage: "idea", rank: 2 }),
			makeIssue({ id: "CAM-1", stage: "idea", rank: 1 }),
		];
		const copy = [...backlog];
		deriveBacklogView(backlog);
		expect(backlog.map((e) => e.id)).toEqual(copy.map((e) => e.id));
	});
});

// ---------------------------------------------------------------------------
// Unmet blockers annotation (isBlocked semantics)
// ---------------------------------------------------------------------------

describe("deriveBacklogView — unmet blockers", () => {
	test("an entry blocked by an unshipped dep exposes it in unmetBlockers", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-1", stage: "specified" }),
			makeIssue({ id: "CAM-2", stage: "specified", blockedBy: ["CAM-1"] }),
		];
		const view = deriveBacklogView(backlog);
		const specified = view.find((g) => g.stage === "specified");
		const entry2 = specified?.entries.find((e) => e.issue.id === "CAM-2");
		expect(entry2?.unmetBlockers).toEqual(["CAM-1"]);
	});

	test("a dep that has shipped is NOT an unmet blocker", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-1", stage: "shipped" }),
			makeIssue({ id: "CAM-2", stage: "specified", blockedBy: ["CAM-1"] }),
		];
		const view = deriveBacklogView(backlog);
		const specified = view.find((g) => g.stage === "specified");
		const entry2 = specified?.entries.find((e) => e.issue.id === "CAM-2");
		expect(entry2?.unmetBlockers).toEqual([]);
	});

	test("a missing (unknown) blockedBy id is NOT reported as an unmet blocker", () => {
		const backlog: IssueEntry[] = [
			makeIssue({
				id: "CAM-5",
				stage: "specified",
				blockedBy: ["CAM-MISSING"],
			}),
		];
		const view = deriveBacklogView(backlog);
		const specified = view.find((g) => g.stage === "specified");
		const entry = specified?.entries.find((e) => e.issue.id === "CAM-5");
		expect(entry?.unmetBlockers).toEqual([]);
	});

	test("an entry with no blockedBy has an empty unmetBlockers array", () => {
		const backlog: IssueEntry[] = [makeIssue({ id: "CAM-1", stage: "idea" })];
		const view = deriveBacklogView(backlog);
		const idea = view.find((g) => g.stage === "idea");
		expect(idea?.entries[0]?.unmetBlockers).toEqual([]);
	});

	test("multiple unmet blockers are all reported", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-1", stage: "idea" }),
			makeIssue({ id: "CAM-2", stage: "specified" }),
			makeIssue({
				id: "CAM-3",
				stage: "planned",
				blockedBy: ["CAM-1", "CAM-2"],
			}),
		];
		const view = deriveBacklogView(backlog);
		const planned = view.find((g) => g.stage === "planned");
		const entry3 = planned?.entries.find((e) => e.issue.id === "CAM-3");
		expect(entry3?.unmetBlockers).toEqual(["CAM-1", "CAM-2"]);
	});
});

// ---------------------------------------------------------------------------
// deriveBacklogJson (US-002, CAM-222): { counts, plannable, byStage }
// ---------------------------------------------------------------------------

describe("deriveBacklogJson — shape + counts", () => {
	test("empty backlog yields zero counts, no plannable, empty byStage groups", () => {
		const json = deriveBacklogJson([]);
		expect(json).toEqual({
			counts: { idea: 0, specified: 0, planned: 0 },
			plannable: [],
			byStage: { idea: [], specified: [], planned: [] },
		});
	});

	test("counts only status:'open' entries per stage; shipped absent without --all", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-1", stage: "idea" }),
			makeIssue({ id: "CAM-2", stage: "idea" }),
			makeIssue({ id: "CAM-3", stage: "specified" }),
			makeIssue({ id: "CAM-4", stage: "planned" }),
			makeIssue({ id: "CAM-5", stage: "shipped" }),
		];
		const json = deriveBacklogJson(backlog);
		expect(json.counts).toEqual({ idea: 2, specified: 1, planned: 1 });
		expect(json.counts.shipped).toBeUndefined();
	});

	test("--all (includeShipped) adds shipped to both counts and byStage", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-1", stage: "shipped" }),
			makeIssue({ id: "CAM-2", stage: "idea" }),
		];
		const json = deriveBacklogJson(backlog, { includeShipped: true });
		expect(json.counts.shipped).toBe(1);
		expect(json.byStage.shipped?.map((r) => r.id)).toEqual(["CAM-1"]);
	});
});

describe("deriveBacklogJson — status:'abandoned' zombie exclusion (CAM-99/103/130/184)", () => {
	test("a stage:'specified' + status:'abandoned' fixture appears NOWHERE in the output", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-99", stage: "specified", status: "abandoned" }),
			makeIssue({ id: "CAM-1", stage: "specified" }),
		];
		const json = deriveBacklogJson(backlog, { includeShipped: true });
		const serialized = JSON.stringify(json);
		expect(serialized.includes("CAM-99")).toBe(false);
	});

	test("abandoned entries are excluded from counts even in the shipped group", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-1", stage: "shipped" }),
			makeIssue({ id: "CAM-2", stage: "shipped", status: "abandoned" }),
		];
		const json = deriveBacklogJson(backlog, { includeShipped: true });
		expect(json.counts.shipped).toBe(1);
		expect(json.byStage.shipped?.map((r) => r.id)).toEqual(["CAM-1"]);
	});
});

describe("deriveBacklogJson — plannable membership (isPlannable) + ordering", () => {
	test("plannable is specified + open + not blocked; a blocked entry is excluded", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-1", stage: "specified" }),
			makeIssue({ id: "CAM-2", stage: "specified", blockedBy: ["CAM-1"] }),
		];
		const json = deriveBacklogJson(backlog);
		expect(json.plannable.map((r) => r.id)).toEqual(["CAM-1"]);
		// The blocked entry is still present in byStage.specified.
		expect(json.byStage.specified.map((r) => r.id)).toEqual(["CAM-1", "CAM-2"]);
	});

	test("idea/planned entries never appear in plannable", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-1", stage: "idea" }),
			makeIssue({ id: "CAM-2", stage: "planned" }),
		];
		const json = deriveBacklogJson(backlog);
		expect(json.plannable).toEqual([]);
	});

	test("plannable is ordered ranked-first ascending rank, then unranked by numeric id", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-9", stage: "specified" }),
			makeIssue({ id: "CAM-3", stage: "specified", rank: 2 }),
			makeIssue({ id: "CAM-1", stage: "specified", rank: 1 }),
			makeIssue({ id: "CAM-5", stage: "specified" }),
		];
		const json = deriveBacklogJson(backlog);
		expect(json.plannable.map((r) => r.id)).toEqual(["CAM-1", "CAM-3", "CAM-5", "CAM-9"]);
	});

	test("row shape is exactly { id, title, rank }; rank is null when unranked", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-1", stage: "specified", title: "Fix the thing" }),
		];
		const json = deriveBacklogJson(backlog);
		expect(json.plannable).toEqual([
			{ id: "CAM-1", title: "Fix the thing", rank: null, createdAt: "2026-01-01T00:00:00Z" },
		]);
	});

	test("row shape carries the numeric rank when present", () => {
		const backlog: IssueEntry[] = [
			makeIssue({ id: "CAM-1", stage: "specified", rank: 3 }),
		];
		const json = deriveBacklogJson(backlog);
		expect(json.plannable).toEqual([
			{ id: "CAM-1", title: "Test issue", rank: 3, createdAt: "2026-01-01T00:00:00Z" },
		]);
	});
});

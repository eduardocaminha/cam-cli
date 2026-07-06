import { describe, expect, test } from "bun:test";
import type { IssueEntry } from "../../src/issues/types.ts";
import { deriveBacklogView } from "../../src/issues/list.ts";

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

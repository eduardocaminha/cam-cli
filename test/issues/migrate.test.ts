import { describe, expect, test } from "bun:test";
import { migrateBacklog } from "../../scripts/cam/migrate-issues-schema.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeOldEntry(overrides: Record<string, unknown>) {
	return {
		id: "CAM-1",
		title: "Test issue",
		createdAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

function makeFile(issues: unknown[], nextId = issues.length + 1) {
	return { next_id: nextId, issues };
}

// ---------------------------------------------------------------------------
// State -> stage/status mapping
// ---------------------------------------------------------------------------

describe("migrateBacklog — state mapping", () => {
	test("closed state maps to shipped stage with status open", () => {
		const result = migrateBacklog(makeFile([makeOldEntry({ state: "closed" })]));
		const entry = result.issues[0]!;
		expect(entry.stage).toBe("shipped");
		expect(entry.status).toBe("open");
	});

	test("done state maps to shipped stage with status open", () => {
		const result = migrateBacklog(makeFile([makeOldEntry({ state: "done" })]));
		const entry = result.issues[0]!;
		expect(entry.stage).toBe("shipped");
		expect(entry.status).toBe("open");
	});

	test("open state maps to idea stage with status open", () => {
		const result = migrateBacklog(makeFile([makeOldEntry({ state: "open" })]));
		const entry = result.issues[0]!;
		expect(entry.stage).toBe("idea");
		expect(entry.status).toBe("open");
	});

	test("canceled state maps to shipped stage with status abandoned", () => {
		const result = migrateBacklog(
			makeFile([makeOldEntry({ state: "canceled" })]),
		);
		const entry = result.issues[0]!;
		expect(entry.stage).toBe("shipped");
		expect(entry.status).toBe("abandoned");
	});

	test("abandoned state maps to shipped stage with status abandoned", () => {
		const result = migrateBacklog(
			makeFile([makeOldEntry({ state: "abandoned" })]),
		);
		const entry = result.issues[0]!;
		expect(entry.stage).toBe("shipped");
		expect(entry.status).toBe("abandoned");
	});
});

// ---------------------------------------------------------------------------
// Priority drift: all shapes are dropped
// ---------------------------------------------------------------------------

describe("migrateBacklog — priority field dropped", () => {
	test("string priority 'P2' is dropped", () => {
		const result = migrateBacklog(
			makeFile([makeOldEntry({ state: "closed", priority: "P2" })]),
		);
		expect("priority" in result.issues[0]!).toBe(false);
	});

	test("integer priority 2 is dropped", () => {
		const result = migrateBacklog(
			makeFile([makeOldEntry({ state: "closed", priority: 2 })]),
		);
		expect("priority" in result.issues[0]!).toBe(false);
	});

	test("absent priority remains absent after migration", () => {
		const result = migrateBacklog(
			makeFile([makeOldEntry({ state: "open" })]),
		);
		expect("priority" in result.issues[0]!).toBe(false);
	});

	test("string priority 'P0' is dropped", () => {
		const result = migrateBacklog(
			makeFile([makeOldEntry({ state: "closed", priority: "P0" })]),
		);
		expect("priority" in result.issues[0]!).toBe(false);
	});

	test("integer priority 3 is dropped", () => {
		const result = migrateBacklog(
			makeFile([makeOldEntry({ state: "open", priority: 3 })]),
		);
		expect("priority" in result.issues[0]!).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// blockedBy and state field cleanup
// ---------------------------------------------------------------------------

describe("migrateBacklog — field cleanup", () => {
	test("sets blockedBy: [] when absent", () => {
		const result = migrateBacklog(makeFile([makeOldEntry({ state: "open" })]));
		expect(result.issues[0]!.blockedBy).toEqual([]);
	});

	test("preserves existing blockedBy array", () => {
		const result = migrateBacklog(
			makeFile([makeOldEntry({ state: "open", blockedBy: ["CAM-5", "CAM-7"] })]),
		);
		expect(result.issues[0]!.blockedBy).toEqual(["CAM-5", "CAM-7"]);
	});

	test("old state field is removed from output", () => {
		const result = migrateBacklog(makeFile([makeOldEntry({ state: "open" })]));
		expect("state" in result.issues[0]!).toBe(false);
	});

	test("closedAt field is removed from output", () => {
		const result = migrateBacklog(
			makeFile([makeOldEntry({ state: "closed", closedAt: "2026-01-02T00:00:00Z" })]),
		);
		expect("closedAt" in result.issues[0]!).toBe(false);
	});

	test("description is preserved", () => {
		const result = migrateBacklog(
			makeFile([makeOldEntry({ state: "open", description: "some desc" })]),
		);
		expect(result.issues[0]!.description).toBe("some desc");
	});
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("migrateBacklog — idempotency", () => {
	test("already-migrated entry (has stage, no state, no priority) is unchanged", () => {
		const alreadyMigrated = {
			id: "CAM-5",
			title: "already new schema",
			stage: "idea" as const,
			status: "open" as const,
			blockedBy: [] as string[],
			createdAt: "2026-01-01T00:00:00Z",
		};
		const result = migrateBacklog(makeFile([alreadyMigrated]));
		expect(result.issues[0]).toEqual(alreadyMigrated);
	});

	test("shipped+abandoned entry is left unchanged on re-run", () => {
		const alreadyMigrated = {
			id: "CAM-6",
			title: "shipped issue",
			stage: "shipped" as const,
			status: "abandoned" as const,
			blockedBy: [] as string[],
			createdAt: "2026-01-01T00:00:00Z",
		};
		const result = migrateBacklog(makeFile([alreadyMigrated]));
		expect(result.issues[0]).toEqual(alreadyMigrated);
	});

	test("re-running migrateBacklog on its own output returns equivalent backlog", () => {
		const input = makeFile([
			makeOldEntry({ id: "CAM-1", state: "closed", priority: "P2" }),
			makeOldEntry({ id: "CAM-2", state: "open" }),
			makeOldEntry({ id: "CAM-3", state: "canceled", priority: 2 }),
		]);
		const firstPass = migrateBacklog(input);
		const secondPass = migrateBacklog(firstPass);
		expect(secondPass).toEqual(firstPass);
	});
});

// ---------------------------------------------------------------------------
// Generic iteration (no hardcoded counts)
// ---------------------------------------------------------------------------

describe("migrateBacklog — generic iteration", () => {
	test("iterates the actual issues array regardless of length", () => {
		const issues = Array.from({ length: 10 }, (_, i) =>
			makeOldEntry({ id: `CAM-${i + 1}`, state: i % 2 === 0 ? "closed" : "open" }),
		);
		const result = migrateBacklog(makeFile(issues));
		expect(result.issues).toHaveLength(10);
		expect(result.issues[0]!.stage).toBe("shipped"); // closed -> shipped
		expect(result.issues[1]!.stage).toBe("idea"); // open -> idea
	});

	test("empty backlog is handled without error", () => {
		const result = migrateBacklog(makeFile([]));
		expect(result.issues).toHaveLength(0);
	});

	test("preserves next_id from the source file", () => {
		const result = migrateBacklog({ next_id: 99, issues: [] });
		expect(result.next_id).toBe(99);
	});

	test("mixed backlog with all state variants is migrated correctly", () => {
		const input = makeFile([
			makeOldEntry({ id: "CAM-1", state: "closed", priority: "P3" }),
			makeOldEntry({ id: "CAM-2", state: "open", priority: "P2" }),
			makeOldEntry({ id: "CAM-3", state: "canceled", priority: 1 }),
		]);
		const result = migrateBacklog(input);
		const [a, b, c] = result.issues;
		expect(a!.stage).toBe("shipped");
		expect(a!.status).toBe("open");
		expect(b!.stage).toBe("idea");
		expect(b!.status).toBe("open");
		expect(c!.stage).toBe("shipped");
		expect(c!.status).toBe("abandoned");
		for (const entry of result.issues) {
			expect("priority" in entry).toBe(false);
			expect("state" in entry).toBe(false);
		}
	});
});

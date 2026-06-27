import { expect, test, describe } from "bun:test";
import { validateSpec, validateWsjf } from "../../src/issues/spec.ts";

// ---------------------------------------------------------------------------
// validateSpec
// ---------------------------------------------------------------------------

describe("validateSpec", () => {
	test("valid spec passes", () => {
		const result = validateSpec({
			acceptanceCriteria: ["AC1", "AC2"],
			scope: "Add X to Y",
			gotchas: [],
			domainTerms: [],
		});
		expect(result).toEqual({ ok: true, errors: [] });
	});

	test("rejects null", () => {
		const result = validateSpec(null);
		expect(result.ok).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});

	test("rejects array", () => {
		const result = validateSpec([]);
		expect(result.ok).toBe(false);
		expect(result.errors[0]).toMatch(/non-null object/);
	});

	test("rejects non-object primitive", () => {
		const result = validateSpec("string");
		expect(result.ok).toBe(false);
		expect(result.errors[0]).toMatch(/non-null object/);
	});

	test("rejects missing acceptanceCriteria", () => {
		const result = validateSpec({ scope: "some scope", gotchas: [], domainTerms: [] });
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("acceptanceCriteria"))).toBe(true);
	});

	test("rejects empty acceptanceCriteria array", () => {
		const result = validateSpec({
			acceptanceCriteria: [],
			scope: "some scope",
			gotchas: [],
			domainTerms: [],
		});
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("acceptanceCriteria"))).toBe(true);
	});

	test("rejects missing scope", () => {
		const result = validateSpec({ acceptanceCriteria: ["AC1"], gotchas: [], domainTerms: [] });
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("scope"))).toBe(true);
	});

	test("rejects empty string scope", () => {
		const result = validateSpec({
			acceptanceCriteria: ["AC1"],
			scope: "   ",
			gotchas: [],
			domainTerms: [],
		});
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("scope"))).toBe(true);
	});

	test("accumulates multiple errors", () => {
		const result = validateSpec({ gotchas: [], domainTerms: [] });
		expect(result.ok).toBe(false);
		expect(result.errors.length).toBeGreaterThanOrEqual(2);
	});
});

// ---------------------------------------------------------------------------
// validateWsjf
// ---------------------------------------------------------------------------

describe("validateWsjf", () => {
	test("valid wsjf passes", () => {
		const result = validateWsjf({
			value: 3,
			timeCriticality: 2,
			riskReduction: 1,
			jobSize: 5,
		});
		expect(result).toEqual({ ok: true, errors: [] });
	});

	test("rejects null", () => {
		const result = validateWsjf(null);
		expect(result.ok).toBe(false);
		expect(result.errors[0]).toMatch(/non-null object/);
	});

	test("rejects array", () => {
		const result = validateWsjf([]);
		expect(result.ok).toBe(false);
		expect(result.errors[0]).toMatch(/non-null object/);
	});

	test("rejects non-object primitive", () => {
		const result = validateWsjf(42);
		expect(result.ok).toBe(false);
		expect(result.errors[0]).toMatch(/non-null object/);
	});

	test("rejects missing value field", () => {
		const result = validateWsjf({ timeCriticality: 1, riskReduction: 1, jobSize: 1 });
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("wsjf.value"))).toBe(true);
	});

	test("rejects missing timeCriticality field", () => {
		const result = validateWsjf({ value: 1, riskReduction: 1, jobSize: 1 });
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("wsjf.timeCriticality"))).toBe(true);
	});

	test("rejects missing riskReduction field", () => {
		const result = validateWsjf({ value: 1, timeCriticality: 1, jobSize: 1 });
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("wsjf.riskReduction"))).toBe(true);
	});

	test("rejects missing jobSize field", () => {
		const result = validateWsjf({ value: 1, timeCriticality: 1, riskReduction: 1 });
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("wsjf.jobSize"))).toBe(true);
	});

	test("rejects non-numeric field (string)", () => {
		const result = validateWsjf({
			value: "high",
			timeCriticality: 1,
			riskReduction: 1,
			jobSize: 1,
		});
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("wsjf.value"))).toBe(true);
	});

	test("accumulates all four errors when all fields are missing", () => {
		const result = validateWsjf({});
		expect(result.ok).toBe(false);
		expect(result.errors.length).toBe(4);
	});
});

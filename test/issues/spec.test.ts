import { expect, test, describe } from "bun:test";
import { validateSpec, validateSpecSource, validateWsjf } from "../../src/issues/spec.ts";

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

// ---------------------------------------------------------------------------
// validateSpecSource
// ---------------------------------------------------------------------------

describe("validateSpecSource", () => {
	// --- Structural guards ---
	test("rejects null", () => {
		const result = validateSpecSource(null);
		expect(result.ok).toBe(false);
		expect(result.errors[0]).toMatch(/non-null object/);
	});

	test("rejects array", () => {
		const result = validateSpecSource([]);
		expect(result.ok).toBe(false);
		expect(result.errors[0]).toMatch(/non-null object/);
	});

	test("rejects non-object primitive", () => {
		const result = validateSpecSource("derived");
		expect(result.ok).toBe(false);
		expect(result.errors[0]).toMatch(/non-null object/);
	});

	// --- Invariant 1: specSource enum guard ---
	test("invalid specSource value fails", () => {
		const result = validateSpecSource({ stage: "specified", specSource: "manual" });
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("specSource"))).toBe(true);
	});

	// --- Legacy enum value 'grill' is no longer valid ---
	test("legacy specSource=grill value now fails, with error listing the new triad", () => {
		const result = validateSpecSource({ stage: "specified", specSource: "grill" });
		expect(result.ok).toBe(false);
		expect(result.errors).toContain('specSource must be one of: "interview", "derived", "operator"');
	});

	// --- Back-compat: absent specSource on stage:specified treated as interview ---
	test("absent specSource on stage:specified treated as interview (passes)", () => {
		const result = validateSpecSource({ stage: "specified" });
		expect(result).toEqual({ ok: true, errors: [] });
	});

	// --- Valid combinations ---
	test("valid specSource=interview passes", () => {
		const result = validateSpecSource({ stage: "specified", specSource: "interview" });
		expect(result).toEqual({ ok: true, errors: [] });
	});

	test("valid specSource=derived with derivedFrom and description passes", () => {
		const result = validateSpecSource({
			stage: "specified",
			specSource: "derived",
			derivedFrom: ["CAM-1"],
			description: "Consolidated from CAM-1.",
		});
		expect(result).toEqual({ ok: true, errors: [] });
	});

	test("valid specSource=operator with description passes", () => {
		const result = validateSpecSource({
			stage: "specified",
			specSource: "operator",
			description: "Hand-filed by operator.",
		});
		expect(result).toEqual({ ok: true, errors: [] });
	});

	// --- Invariant 2: derivedFrom required when specSource=derived ---
	test("specSource=derived without derivedFrom fails", () => {
		const result = validateSpecSource({
			stage: "specified",
			specSource: "derived",
			description: "Some description.",
		});
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("derivedFrom"))).toBe(true);
	});

	test("specSource=derived with empty derivedFrom fails", () => {
		const result = validateSpecSource({
			stage: "specified",
			specSource: "derived",
			derivedFrom: [],
			description: "Some description.",
		});
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("derivedFrom"))).toBe(true);
	});

	// --- Invariant 3: description required when specSource=derived or operator ---
	test("specSource=derived with absent description fails", () => {
		const result = validateSpecSource({
			stage: "specified",
			specSource: "derived",
			derivedFrom: ["CAM-1"],
		});
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("description"))).toBe(true);
	});

	test("specSource=derived with empty description fails", () => {
		const result = validateSpecSource({
			stage: "specified",
			specSource: "derived",
			derivedFrom: ["CAM-1"],
			description: "",
		});
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("description"))).toBe(true);
	});

	test("specSource=operator with absent description fails", () => {
		const result = validateSpecSource({
			stage: "specified",
			specSource: "operator",
		});
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("description"))).toBe(true);
	});

	test("specSource=operator with empty description fails", () => {
		const result = validateSpecSource({
			stage: "specified",
			specSource: "operator",
			description: "   ",
		});
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("description"))).toBe(true);
	});

	// --- specSource=interview does NOT require description ---
	test("specSource=interview without description passes", () => {
		const result = validateSpecSource({ stage: "specified", specSource: "interview" });
		expect(result).toEqual({ ok: true, errors: [] });
	});

	// --- derivedFrom with multiple parents ---
	test("specSource=derived with multiple derivedFrom entries passes", () => {
		const result = validateSpecSource({
			specSource: "derived",
			derivedFrom: ["CAM-1", "CAM-2"],
			description: "Consolidated from two parent issues.",
		});
		expect(result).toEqual({ ok: true, errors: [] });
	});
});

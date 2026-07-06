import { describe, expect, test } from "bun:test";
import {
	adrFilename,
	mergeContextMd,
	nextAdrNumber,
	renderAdr,
	slugifyAdrTitle,
	validateDomainDocsPayload,
} from "../../src/domain-docs/render.ts";

// ---------------------------------------------------------------------------
// validateDomainDocsPayload
// ---------------------------------------------------------------------------

describe("validateDomainDocsPayload", () => {
	test("accepts empty payload as a valid no-op", () => {
		const result = validateDomainDocsPayload({ terms: [], adrs: [] });
		expect(result).toEqual({ ok: true, errors: [] });
	});

	test("accepts a payload with valid terms and adrs", () => {
		const result = validateDomainDocsPayload({
			terms: [{ term: "Order", definition: "A customer's request to purchase." }],
			adrs: [
				{
					title: "Use event sourcing",
					context: "We need an audit trail.",
					decision: "Adopt event sourcing for the write model.",
					consequences: "Reads are projected separately.",
				},
			],
		});
		expect(result).toEqual({ ok: true, errors: [] });
	});

	test("rejects null", () => {
		const result = validateDomainDocsPayload(null);
		expect(result.ok).toBe(false);
		expect(result.errors[0]).toMatch(/non-null object/);
	});

	test("rejects array", () => {
		const result = validateDomainDocsPayload([]);
		expect(result.ok).toBe(false);
		expect(result.errors[0]).toMatch(/non-null object/);
	});

	test("rejects non-object primitive", () => {
		const result = validateDomainDocsPayload("nope");
		expect(result.ok).toBe(false);
		expect(result.errors[0]).toMatch(/non-null object/);
	});

	test("rejects missing terms/adrs arrays", () => {
		const result = validateDomainDocsPayload({});
		expect(result.ok).toBe(false);
		expect(result.errors).toContain("terms must be an array");
		expect(result.errors).toContain("adrs must be an array");
	});

	test("rejects term entry missing term", () => {
		const result = validateDomainDocsPayload({ terms: [{ definition: "x" }], adrs: [] });
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("terms[0].term"))).toBe(true);
	});

	test("rejects term entry missing definition", () => {
		const result = validateDomainDocsPayload({ terms: [{ term: "Order" }], adrs: [] });
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("terms[0].definition"))).toBe(true);
	});

	test("rejects term entry with blank strings", () => {
		const result = validateDomainDocsPayload({ terms: [{ term: "  ", definition: " " }], adrs: [] });
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("terms[0].term"))).toBe(true);
		expect(result.errors.some((e) => e.includes("terms[0].definition"))).toBe(true);
	});

	test("rejects non-object term entry", () => {
		const result = validateDomainDocsPayload({ terms: ["not an object"], adrs: [] });
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("terms[0] must be a non-null object"))).toBe(true);
	});

	test("rejects adr entry missing each required field individually", () => {
		const base = { title: "T", context: "C", decision: "D", consequences: "Q" };
		for (const field of ["title", "context", "decision", "consequences"] as const) {
			const adr = { ...base, [field]: "" };
			const result = validateDomainDocsPayload({ terms: [], adrs: [adr] });
			expect(result.ok).toBe(false);
			expect(result.errors.some((e) => e.includes(`adrs[0].${field}`))).toBe(true);
		}
	});

	test("rejects non-object adr entry", () => {
		const result = validateDomainDocsPayload({ terms: [], adrs: [42] });
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("adrs[0] must be a non-null object"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// mergeContextMd
// ---------------------------------------------------------------------------

describe("mergeContextMd", () => {
	test("creates a fresh glossary-only CONTEXT.md when existing is null", () => {
		const out = mergeContextMd(null, [{ term: "Order", definition: "A request to purchase." }]);
		expect(out).toBe("# Context\n\n## Language\n\n**Order**:\nA request to purchase.\n");
	});

	test("creates a fresh CONTEXT.md skeleton with no terms", () => {
		const out = mergeContextMd(null, []);
		expect(out).toBe("# Context\n\n## Language\n");
	});

	test("appends new terms to an existing CONTEXT.md", () => {
		const existing = "# Context\n\n## Language\n\n**Order**:\nA request to purchase.\n";
		const out = mergeContextMd(existing, [{ term: "Invoice", definition: "A request for payment." }]);
		expect(out).toBe(
			"# Context\n\n## Language\n\n**Order**:\nA request to purchase.\n\n**Invoice**:\nA request for payment.\n",
		);
	});

	test("updates the definition in place when the term already exists", () => {
		const existing =
			"# Context\n\n## Language\n\n**Order**:\nOld definition.\n\n**Invoice**:\nA request for payment.\n";
		const out = mergeContextMd(existing, [{ term: "Order", definition: "New definition." }]);
		expect(out).toBe(
			"# Context\n\n## Language\n\n**Order**:\nNew definition.\n\n**Invoice**:\nA request for payment.\n",
		);
	});

	test("preserves a preamble description on an existing CONTEXT.md", () => {
		const existing =
			"# Billing\n\nHandles invoices and payments.\n\n## Language\n\n**Invoice**:\nA request for payment.\n";
		const out = mergeContextMd(existing, [{ term: "Payment", definition: "Money transferred to settle an invoice." }]);
		expect(out).toBe(
			"# Billing\n\nHandles invoices and payments.\n\n## Language\n\n**Invoice**:\nA request for payment.\n\n**Payment**:\nMoney transferred to settle an invoice.\n",
		);
	});

	test("is idempotent: merging the same payload twice yields byte-identical output", () => {
		const terms = [
			{ term: "Order", definition: "A request to purchase." },
			{ term: "Invoice", definition: "A request for payment." },
		];
		const first = mergeContextMd(null, terms);
		const second = mergeContextMd(first, terms);
		expect(second).toBe(first);
	});

	test("no-op merge (empty terms) leaves existing content untouched", () => {
		const existing = "# Context\n\n## Language\n\n**Order**:\nA request to purchase.\n";
		const out = mergeContextMd(existing, []);
		expect(out).toBe(existing);
	});
});

// ---------------------------------------------------------------------------
// renderAdr
// ---------------------------------------------------------------------------

describe("renderAdr", () => {
	test("produces the section skeleton", () => {
		const out = renderAdr("0010", {
			title: "Use event sourcing",
			context: "We need an audit trail.",
			decision: "Adopt event sourcing for the write model.",
			consequences: "Reads are projected separately.",
		});
		expect(out).toBe(
			[
				"# ADR 0010: Use event sourcing",
				"",
				"## Context",
				"",
				"We need an audit trail.",
				"",
				"## Decision",
				"",
				"Adopt event sourcing for the write model.",
				"",
				"## Consequences",
				"",
				"Reads are projected separately.",
				"",
			].join("\n"),
		);
	});

	test("trims whitespace from every field", () => {
		const out = renderAdr("0001", {
			title: "  Title  ",
			context: "  Context.  ",
			decision: "  Decision.  ",
			consequences: "  Consequences.  ",
		});
		expect(out).toContain("# ADR 0001: Title");
		expect(out).toContain("\nContext.\n");
		expect(out).toContain("\nDecision.\n");
		expect(out).toContain("\nConsequences.\n");
	});
});

// ---------------------------------------------------------------------------
// nextAdrNumber
// ---------------------------------------------------------------------------

describe("nextAdrNumber", () => {
	test("returns '0001' for an empty list", () => {
		expect(nextAdrNumber([])).toBe("0001");
	});

	test("returns max + 1 zero-padded to 4 digits", () => {
		expect(
			nextAdrNumber([
				"0001-issue-system-redesign.md",
				"0002-fast-track-plan-ready.md",
				"0009-ship-phase-deterministic-sidecar-runner.md",
			]),
		).toBe("0010");
	});

	test("ignores filenames without a 4-digit prefix", () => {
		expect(nextAdrNumber(["README.md", "0003-foo.md", "not-numbered.md"])).toBe("0004");
	});

	test("handles unordered input", () => {
		expect(nextAdrNumber(["0005-foo.md", "0001-bar.md", "0003-baz.md"])).toBe("0006");
	});
});

// ---------------------------------------------------------------------------
// slugifyAdrTitle / adrFilename
// ---------------------------------------------------------------------------

describe("slugifyAdrTitle / adrFilename", () => {
	test("slugifies a title", () => {
		expect(slugifyAdrTitle("Use Event Sourcing!")).toBe("use-event-sourcing");
	});

	test("collapses punctuation and trims edge hyphens", () => {
		expect(slugifyAdrTitle("  --Weird__Title??  ")).toBe("weird-title");
	});

	test("builds the target filename NNNN-<slug>.md", () => {
		expect(adrFilename("0010", "Use Event Sourcing")).toBe("0010-use-event-sourcing.md");
	});
});

// ---------------------------------------------------------------------------
// no em-dash in rendered/merged output (project rule)
// ---------------------------------------------------------------------------

describe("no em-dash in rendered output", () => {
	test("mergeContextMd output has no em-dash", () => {
		const out = mergeContextMd(null, [{ term: "Order", definition: "A request to purchase, not a transaction." }]);
		expect(out).not.toContain("—");
	});

	test("renderAdr output has no em-dash", () => {
		const out = renderAdr("0001", {
			title: "Use event sourcing",
			context: "We need an audit trail.",
			decision: "Adopt event sourcing for the write model.",
			consequences: "Reads are projected separately.",
		});
		expect(out).not.toContain("—");
	});
});

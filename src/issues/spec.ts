import type { WsjfScore } from "./types.ts";

/**
 * Structured deep-spec written by the grill (acceptanceCriteria + scope +
 * gotchas + domainTerms). Distinct from the free-text description captured
 * at stage:idea.
 */
export interface Spec {
	acceptanceCriteria: string[];
	scope: string;
	gotchas: string[];
	domainTerms: string[];
}

/**
 * Validation result shape -- mirrors checkReferentialIntegrity in graph.ts.
 */
export interface ValidationResult {
	ok: boolean;
	errors: string[];
}

/**
 * Validates a Spec value. Returns { ok: true, errors: [] } on success.
 *
 * Rejects:
 *   - x is not an object (or is null / array)
 *   - acceptanceCriteria is missing or empty
 *   - scope is missing or empty string
 */
export function validateSpec(x: unknown): ValidationResult {
	const errors: string[] = [];

	if (x === null || typeof x !== "object" || Array.isArray(x)) {
		errors.push("spec must be a non-null object");
		return { ok: false, errors };
	}

	const candidate = x as Record<string, unknown>;

	const ac = candidate["acceptanceCriteria"];
	if (!Array.isArray(ac) || ac.length === 0) {
		errors.push("acceptanceCriteria must be a non-empty array");
	}

	const scope = candidate["scope"];
	if (typeof scope !== "string" || scope.trim() === "") {
		errors.push("scope must be a non-empty string");
	}

	return { ok: errors.length === 0, errors };
}

/** Returns true when v is one of the three valid specSource enum values. */
function isValidSpecSourceEnum(v: unknown): boolean {
	return v === "grill" || v === "derived" || v === "operator";
}

/** Returns true when v is a non-empty (non-blank) string. */
function isNonEmptyString(v: unknown): boolean {
	return typeof v === "string" && v.trim() !== "";
}

/**
 * Validates the specSource/derivedFrom invariants on an issue entry.
 * Mirrors validateSpec/validateWsjf style: accepts unknown, returns {ok, errors}.
 *
 * Invariants enforced:
 *   1. specSource, when present, must be one of: grill, derived, operator.
 *   2. Absent specSource on a stage:specified issue is treated as "grill" (back-compat, passes).
 *   3. derivedFrom must be a non-empty array when specSource === "derived".
 *   4. description must be a non-empty string when specSource is "derived" or "operator".
 */
export function validateSpecSource(x: unknown): ValidationResult {
	const errors: string[] = [];

	if (x === null || typeof x !== "object" || Array.isArray(x)) {
		errors.push("entry must be a non-null object");
		return { ok: false, errors };
	}

	const candidate = x as Record<string, unknown>;
	const specSource = candidate["specSource"];
	const derivedFrom = candidate["derivedFrom"];
	const description = candidate["description"];

	// Invariant 1: specSource, when present, must be one of the 3 enum values.
	if (specSource !== undefined && !isValidSpecSourceEnum(specSource)) {
		errors.push('specSource must be one of: "grill", "derived", "operator"');
	}

	// Absent specSource is treated as "grill" (back-compat). No error emitted for absence.
	const effective = specSource === undefined ? "grill" : (specSource as string);

	// Invariant 2: derivedFrom must be a non-empty array when specSource === "derived".
	if (effective === "derived") {
		if (!Array.isArray(derivedFrom) || (derivedFrom as unknown[]).length === 0) {
			errors.push('derivedFrom must be a non-empty array when specSource is "derived"');
		}
	}

	// Invariant 3: description must be a non-empty string when specSource is "derived" or "operator".
	if (effective === "derived" || effective === "operator") {
		if (!isNonEmptyString(description)) {
			errors.push(
				'description must be a non-empty string when specSource is "derived" or "operator"',
			);
		}
	}

	return { ok: errors.length === 0, errors };
}

/**
 * Validates a WsjfScore value. Returns { ok: true, errors: [] } on success.
 *
 * Rejects if any of the four numeric components
 * (value, timeCriticality, riskReduction, jobSize) is missing or not a number.
 */
export function validateWsjf(x: unknown): ValidationResult {
	const errors: string[] = [];

	if (x === null || typeof x !== "object" || Array.isArray(x)) {
		errors.push("wsjf must be a non-null object");
		return { ok: false, errors };
	}

	const candidate = x as Record<string, unknown>;
	const requiredFields: Array<keyof WsjfScore> = [
		"value",
		"timeCriticality",
		"riskReduction",
		"jobSize",
	];

	for (const field of requiredFields) {
		if (typeof candidate[field] !== "number") {
			errors.push(`wsjf.${field} must be a number`);
		}
	}

	return { ok: errors.length === 0, errors };
}

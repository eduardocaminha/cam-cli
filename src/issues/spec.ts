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

import { createHash } from 'node:crypto';

/**
 * One command that was run while specifying, and the output observed then.
 * Once a run starts, the same command runs again in the run's own workspace
 * -- after it is prepared and before any provider is invoked -- and fails the
 * run if `output` no longer matches: evidence that the spec's premise, not
 * just its conclusion, describes the repository.
 */
export interface EvidenceItem {
	command: string;
	output: string;
}

export const EVIDENCE_LIMITS = {
	maxItems: 3,
	command: 200,
	output: 600,
} as const;

/**
 * The executable task contract: an outcome (`scope`) and one or more
 * commands that prove it (`verify`).
 */
export interface Spec {
	scope: string;
	verify?: string[];
	/** Executable premise, checked in the run's own workspace before any provider runs; never at intake. */
	evidence?: EvidenceItem[];
}

export interface ValidationResult {
	ok: boolean;
	errors: string[];
}

/** Fingerprint only the normalized contract that an executor will run. */
export function fingerprintSpec(spec: Spec): string {
	const canonical = JSON.stringify({
		scope: spec.scope.trim(),
		verify: (spec.verify ?? []).map((command) => command.trim()),
	});
	return createHash('sha256').update(canonical).digest('hex');
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

/** Validate one evidence item's shape and size, appending to `errors` in place. */
function validateEvidenceItem(value: unknown, index: number, errors: string[]): void {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		errors.push(`evidence[${index}] must be an object with command and output`);
		return;
	}
	const item = value as Record<string, unknown>;
	if (!isNonEmptyString(item['command'])) {
		errors.push(`evidence[${index}].command must be a non-empty string`);
	} else if (item['command'].length > EVIDENCE_LIMITS.command) {
		errors.push(`evidence[${index}].command exceeds ${EVIDENCE_LIMITS.command} characters`);
	}
	if (!isNonEmptyString(item['output'])) {
		errors.push(`evidence[${index}].output must be a non-empty string`);
	} else if (item['output'].length > EVIDENCE_LIMITS.output) {
		errors.push(`evidence[${index}].output exceeds ${EVIDENCE_LIMITS.output} characters`);
	}
}

/** Validate the optional evidence field, appending to `errors` in place. */
function validateEvidence(value: unknown, errors: string[]): void {
	if (value === undefined) return;
	if (!Array.isArray(value)) {
		errors.push('evidence must be an array');
		return;
	}
	if (value.length > EVIDENCE_LIMITS.maxItems) {
		errors.push(`evidence accepts at most ${EVIDENCE_LIMITS.maxItems} items`);
	}
	value.forEach((item, index) => validateEvidenceItem(item, index, errors));
}

/** Accept the direct contract. */
export function validateSpec(value: unknown): ValidationResult {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return { ok: false, errors: ['spec must be a non-null object'] };
	}
	const candidate = value as Record<string, unknown>;
	const errors: string[] = [];
	if (!isNonEmptyString(candidate['scope'])) {
		errors.push('scope must be a non-empty string');
	}
	if (!isNonEmptyStringArray(candidate['verify'])) {
		errors.push('spec requires non-empty verify commands');
	}
	validateEvidence(candidate['evidence'], errors);
	return { ok: errors.length === 0, errors };
}

/** Pure plannability check. */
export function hasVerification(spec: Spec | undefined): boolean {
	return isNonEmptyStringArray(spec?.verify);
}

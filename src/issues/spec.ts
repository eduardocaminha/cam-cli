import { createHash } from 'node:crypto';

/**
 * The executable task contract. New issues need only an outcome (`scope`) and
 * one or more commands that prove it (`verify`). The legacy fields stay
 * readable until the existing backlog has naturally drained.
 */
export interface Spec {
	scope: string;
	verify?: string[];
	/** Legacy deep-spec prose with embedded `[oracle: ...]` commands. */
	acceptanceCriteria?: string[];
	/** Legacy interview notes; ignored by the runtime. */
	gotchas?: string[];
	/** Legacy interview glossary; ignored by the runtime. */
	domainTerms?: string[];
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

/** Accept the direct contract and keep old backlog records executable. */
export function validateSpec(value: unknown): ValidationResult {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return { ok: false, errors: ['spec must be a non-null object'] };
	}
	const candidate = value as Record<string, unknown>;
	const errors: string[] = [];
	if (!isNonEmptyString(candidate['scope'])) {
		errors.push('scope must be a non-empty string');
	}
	if (
		!isNonEmptyStringArray(candidate['verify'])
		&& !isNonEmptyStringArray(candidate['acceptanceCriteria'])
	) {
		errors.push('spec requires non-empty verify commands');
	}
	return { ok: errors.length === 0, errors };
}

/** Pure plannability check shared by old and new issue records. */
export function hasVerification(spec: Spec | undefined): boolean {
	return isNonEmptyStringArray(spec?.verify)
		|| isNonEmptyStringArray(spec?.acceptanceCriteria);
}

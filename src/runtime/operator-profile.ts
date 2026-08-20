// src/runtime/operator-profile.ts
//
// Small operator-owned identity used by conversation now and by local
// schedules later. Both fields are optional until the operator saves them.

export interface OperatorProfile {
	name: string;
	timezone: string;
}

export const OPERATOR_PROFILE_KEY = 'operator-profile';

export const OPERATOR_PROFILE_LIMITS = {
	name: 120,
	timezone: 100,
} as const;

export function emptyOperatorProfile(): OperatorProfile {
	return { name: '', timezone: '' };
}

/** Empty is allowed; a non-empty value is stored in Intl's canonical form. */
export function canonicalTimeZone(value: string): string | null {
	const timezone = value.trim();
	if (timezone === '') return '';
	if (timezone.length > OPERATOR_PROFILE_LIMITS.timezone) return null;
	try {
		return new Intl.DateTimeFormat('en-US', { timeZone: timezone })
			.resolvedOptions().timeZone;
	} catch {
		return null;
	}
}

/** A corrupt stored record degrades field-by-field instead of blocking boot. */
export function normalizeOperatorProfile(value: unknown): OperatorProfile {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return emptyOperatorProfile();
	}
	const record = value as Record<string, unknown>;
	const name = typeof record['name'] === 'string'
		? record['name'].trim().slice(0, OPERATOR_PROFILE_LIMITS.name)
		: '';
	const timezone = typeof record['timezone'] === 'string'
		? canonicalTimeZone(record['timezone']) ?? ''
		: '';
	return { name, timezone };
}

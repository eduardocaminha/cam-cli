export const PROJECT_VERIFICATION_VERSION = 1;

export interface ProjectVerificationManifest {
	version: typeof PROJECT_VERIFICATION_VERSION;
	verify: string[];
}

/** Parse the repository-owned full-verification contract without filesystem or Git access. */
export function readProjectVerificationManifest(content: string): ProjectVerificationManifest {
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		throw new Error('project verification manifest is not valid JSON');
	}
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('project verification manifest is not an object');
	}
	const record = value as Record<string, unknown>;
	if (record.version !== PROJECT_VERIFICATION_VERSION) {
		throw new Error(`project verification manifest has unsupported version: ${String(record.version)}`);
	}
	if (!Array.isArray(record.verify) || record.verify.length === 0
		|| !record.verify.every((command) => typeof command === 'string' && command.trim().length > 0)) {
		throw new Error('project verification manifest has no valid verification commands');
	}
	return { version: PROJECT_VERIFICATION_VERSION, verify: [...record.verify] as string[] };
}

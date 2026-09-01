export const PROJECT_VERIFICATION_VERSION = 1;

export interface ProjectDiagnosticManifest {
	command: string;
}

export interface ProjectVerificationManifest {
	version: typeof PROJECT_VERIFICATION_VERSION;
	/** Commands run in order after the worktree is cut and before the agent starts. */
	prepare?: string[];
	verify: string[];
	/** One repository-owned advisory command run in an isolated diagnostic checkout. */
	diagnostic?: ProjectDiagnosticManifest;
}

function validCommands(value: unknown, allowEmpty: boolean): value is string[] {
	return Array.isArray(value)
		&& (allowEmpty || value.length > 0)
		&& value.every((command) => typeof command === 'string' && command.trim().length > 0);
}

function diagnostic(value: unknown): ProjectDiagnosticManifest | null {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== 1 || !Object.hasOwn(record, 'command')) return null;
	const command = record.command;
	return typeof command === 'string' && command.trim().length > 0 ? { command } : null;
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
	if (!validCommands(record.verify, false)) {
		throw new Error('project verification manifest has no valid verification commands');
	}
	const hasPrepare = Object.hasOwn(record, 'prepare');
	if (hasPrepare && !validCommands(record.prepare, true)) {
		throw new Error('project verification manifest has invalid preparation commands');
	}
	const hasDiagnostic = Object.hasOwn(record, 'diagnostic');
	const projectDiagnostic = hasDiagnostic ? diagnostic(record.diagnostic) : undefined;
	if (projectDiagnostic === null) {
		throw new Error('project verification manifest has invalid diagnostic command');
	}
	return {
		version: PROJECT_VERIFICATION_VERSION,
		...(hasPrepare ? { prepare: [...record.prepare as string[]] } : {}),
		verify: [...record.verify],
		...(projectDiagnostic === undefined ? {} : { diagnostic: projectDiagnostic }),
	};
}

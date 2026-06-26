// src/release/ship-bump.ts
//
// runShipBump() -- deterministic version-bump step for cam ship --bump.
//
// Reads branch commit subjects via `git log main..HEAD --pretty=%s`,
// classifies using classifyBump (US-001), computes the next version using
// computeNextVersion (US-002), writes src/version.ts + package.json, and
// commits `chore(release): bump version to X.Y.Z`.
//
// When the classified bump is 'none', the step makes NO file change and
// creates NO commit -- it returns { noOp: true }.
//
// All external dependencies are injectable so the function is fully
// unit-testable without a real git binary or filesystem.
//
// Modeled on finalizeCycleClose (src/commands/ship-finalize.ts): same
// SpawnFn + ClockFn injectable-dep pattern.
//
// US-003 (CAM-89).

import type { SpawnSyncReturns } from 'node:child_process';
import { classifyBump } from './bump.ts';
import {
	applyVersionToPackageJson,
	applyVersionToVersionTs,
	computeNextVersion,
} from './version.ts';

// ---------------------------------------------------------------------------
// Injectable dependency types (mirrored from ship-finalize.ts for isolation)
// ---------------------------------------------------------------------------

/**
 * Subset of node:child_process spawnSync we need.
 * Injectable so unit tests never shell out to a real git binary.
 */
export type SpawnFn = (
	cmd: string,
	args: string[],
	options: { encoding: 'utf8' },
) => SpawnSyncReturns<string>;

/** Returns the current ISO 8601 timestamp string. Injectable for tests. */
export type ClockFn = () => string;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ShipBumpOptions {
	/** Absolute path to the project root (git repo). */
	cwd: string;
	/** Injectable spawnSync for all git subprocess calls. */
	spawnFn: SpawnFn;
	/** Injectable clock -- reserved for future timestamp annotations. */
	clock: ClockFn;
	/** Read src/version.ts as raw text. */
	readVersionTs: () => string;
	/** Read package.json as raw text. */
	readPackageJson: () => string;
	/** Write src/version.ts (receives fully transformed text). */
	writeVersionTs: (text: string) => void;
	/** Write package.json (receives fully transformed text). */
	writePackageJson: (text: string) => void;
}

export type ShipBumpResult =
	| { noOp: true; reason: string }
	| { noOp: false; oldVersion: string; newVersion: string; bump: string };

/** Regex that matches the CAM_VERSION literal in src/version.ts. */
const VERSION_TS_RE = /export const CAM_VERSION = '([^']+)';/;

/**
 * Run the ship bump step.
 *
 * 1. Reads `git log main..HEAD --pretty=%s` for commit subjects.
 * 2. Classifies via classifyBump.
 * 3. If 'none': returns { noOp: true } without any side effects.
 * 4. Computes next version via computeNextVersion.
 * 5. Writes src/version.ts and package.json via the injected writers.
 * 6. Runs `git add src/version.ts package.json`.
 * 7. Runs `git commit -m "chore(release): bump version to X.Y.Z"`.
 */
export function runShipBump(opts: ShipBumpOptions): ShipBumpResult {
	// Read branch commit subjects.
	const logResult = opts.spawnFn(
		'git',
		['log', 'main..HEAD', '--pretty=%s'],
		{ encoding: 'utf8' },
	);
	const subjects = logResult.stdout
		.split('\n')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	const bump = classifyBump(subjects);

	if (bump === 'none') {
		return {
			noOp: true,
			reason: 'all commits classify as none; no version bump needed',
		};
	}

	// Read current version from src/version.ts.
	const versionTsText = opts.readVersionTs();
	const match = VERSION_TS_RE.exec(versionTsText);
	const currentVersion = match?.[1] ?? '0.0.0';

	const newVersion = computeNextVersion(currentVersion, bump);

	// Write both files.
	opts.writeVersionTs(applyVersionToVersionTs(versionTsText, newVersion));
	opts.writePackageJson(applyVersionToPackageJson(opts.readPackageJson(), newVersion));

	// Stage and commit.
	opts.spawnFn('git', ['add', 'src/version.ts', 'package.json'], { encoding: 'utf8' });
	opts.spawnFn(
		'git',
		['commit', '-m', `chore(release): bump version to ${newVersion}`],
		{ encoding: 'utf8' },
	);

	return { noOp: false, oldVersion: currentVersion, newVersion, bump };
}

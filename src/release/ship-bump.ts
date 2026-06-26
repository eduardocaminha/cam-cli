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
// creates NO commit -- bumpType is 'none' and from === to in the result.
//
// All external dependencies are injectable so the function is fully
// unit-testable without a real git binary or filesystem.
//
// Modeled on finalizeCycleClose (src/commands/ship-finalize.ts): same
// SpawnFn + ClockFn injectable-dep pattern. emitOk used for the result
// line (consistent with how finalizeCycleClose surfaces its result).
//
// US-003 (CAM-89), US-007 (CAM-89) -- structured result + event.

import type { SpawnSyncReturns } from 'node:child_process';
import { generateReleaseBody, rollChangelog } from './changelog.ts';
import { classifyBump, type BumpLevel } from './bump.ts';
import {
	applyVersionToPackageJson,
	applyVersionToVersionTs,
	computeNextVersion,
} from './version.ts';
import { emitOk } from '../logging/screen.ts';
import { printError } from '../logging/color.ts';

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
	/** Injectable clock -- ISO 8601 timestamp used for the release date. */
	clock: ClockFn;
	/** Read src/version.ts as raw text. */
	readVersionTs: () => string;
	/** Read package.json as raw text. */
	readPackageJson: () => string;
	/** Write src/version.ts (receives fully transformed text). */
	writeVersionTs: (text: string) => void;
	/** Write package.json (receives fully transformed text). */
	writePackageJson: (text: string) => void;
	/** Read CHANGELOG.md as raw text. */
	readChangelog: () => string;
	/** Write CHANGELOG.md (receives fully transformed text). */
	writeChangelog: (text: string) => void;
	/**
	 * Optional structured event sink. Called with the final ShipBumpResult
	 * before returning. Tests inject a capture function; production callers
	 * may write to a log. Shape: { from, to, bumpType, commitsClassified }.
	 */
	writeEvent?: (event: ShipBumpResult) => void;
	/**
	 * Optional override for the result-line emitter (emitOk path).
	 * When absent, delegates to the shared emitOk from src/logging/screen.ts.
	 * SHAPE STABILITY: do not change msg/suffix format after release without
	 * updating the pinning test in test/release/ship-bump.test.ts (US-007).
	 */
	emitResultLine?: (msg: string, suffix?: string) => void;
}

/**
 * Unified result returned by runShipBump.
 *
 * When bumpType is 'none': no file writes and no commit were made; from === to.
 * Otherwise: files were written and a chore(release) commit was created.
 */
export interface ShipBumpResult {
	/** Version before bump. Equals `to` when bumpType is 'none'. */
	from: string;
	/** Version after bump. Equals `from` when bumpType is 'none'. */
	to: string;
	/** Classified bump level: 'none' means no user-visible change. */
	bumpType: BumpLevel;
	/** Number of commit subjects fed into the classifier. */
	commitsClassified: number;
}

/** Regex that matches the CAM_VERSION literal in src/version.ts. */
const VERSION_TS_RE = /export const CAM_VERSION = '([^']+)';/;

/**
 * Run the ship bump step.
 *
 * 1. Reads `git log main..HEAD --pretty=%s` for commit subjects.
 * 2. Reads the current version from src/version.ts (needed for `from` field).
 * 3. Classifies via classifyBump.
 * 4. If 'none': emits a result line + event and returns immediately (no file writes, no commit).
 * 5. Computes next version via computeNextVersion.
 * 6. Writes src/version.ts, package.json, and CHANGELOG.md via the injected writers.
 * 7. Runs `git add src/version.ts package.json CHANGELOG.md`.
 * 8. Runs `git commit -m "chore(release): bump version to X.Y.Z"`.
 * 9. Emits a result line (emitOk) and a structured event (writeEvent).
 */

// Stage and commit the three version files.  Extracted from runShipBump to
// stay within biome's noExcessiveLinesPerFunction limit.
// spawnSync does NOT throw on non-zero exit, so every call must guard .status
// explicitly (reviewer finding US-R1-001).
function stageAndCommitBump(newVersion: string, spawnFn: SpawnFn): void {
	const addResult = spawnFn(
		'git',
		['add', 'src/version.ts', 'package.json', 'CHANGELOG.md'],
		{ encoding: 'utf8' },
	);
	if ((addResult.status ?? 1) !== 0) {
		const stderr = (addResult.stderr ?? '').trim();
		printError(`git add failed: ${stderr || '(no output)'}`);
		throw new Error(`git add failed (exit ${addResult.status ?? 'null'})`);
	}
	const commitResult = spawnFn(
		'git',
		['commit', '-m', `chore(release): bump version to ${newVersion}`],
		{ encoding: 'utf8' },
	);
	if ((commitResult.status ?? 1) !== 0) {
		const stderr = (commitResult.stderr ?? '').trim();
		printError(
			`git commit failed: ${stderr || '(no output)'}`,
			'files are staged but not committed -- check pre-commit hook output',
		);
		throw new Error(`git commit failed (exit ${commitResult.status ?? 'null'})`);
	}
}

export function runShipBump(opts: ShipBumpOptions): ShipBumpResult {
	const emitLine = opts.emitResultLine ?? emitOk;

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
	const commitsClassified = subjects.length;

	// Read current version from src/version.ts.
	// Done before the no-op check so `from` is always populated in the result.
	const versionTsText = opts.readVersionTs();
	const match = VERSION_TS_RE.exec(versionTsText);
	const currentVersion = match?.[1] ?? '0.0.0';

	const bumpType = classifyBump(subjects);

	if (bumpType === 'none') {
		// No file writes and no commit for the no-op path; bumpType 'none' signals this.
		// Emit result line + event so the no-bump decision is always visible (US-007 AC-3).
		// SHAPE STABILITY: do not change msg/suffix without updating the pinning test (US-007).
		emitLine(`bump: none (${commitsClassified} classified)`, `${currentVersion} (no change)`);
		const result: ShipBumpResult = {
			from: currentVersion,
			to: currentVersion,
			bumpType: 'none',
			commitsClassified,
		};
		opts.writeEvent?.(result);
		return result;
	}

	const newVersion = computeNextVersion(currentVersion, bumpType);

	// Extract YYYY-MM-DD date from the injected ISO timestamp.
	const dateStr = opts.clock().slice(0, 10);

	// Write version files.
	opts.writeVersionTs(applyVersionToVersionTs(versionTsText, newVersion));
	opts.writePackageJson(applyVersionToPackageJson(opts.readPackageJson(), newVersion));

	// Roll CHANGELOG.md: rename [Unreleased] to [X.Y.Z] - YYYY-MM-DD, insert fresh empty [Unreleased].
	// The versioned section body is generated from classified commits (not the old hand-maintained body).
	const releaseBody = generateReleaseBody(subjects);
	opts.writeChangelog(rollChangelog(opts.readChangelog(), newVersion, dateStr, releaseBody));

	// Stage and commit.
	stageAndCommitBump(newVersion, opts.spawnFn);

	// Emit structured result line -- shape is stable; test pins it (US-007).
	// Do not change msg/suffix format without a CAM tracker reference.
	emitLine(`bump: ${bumpType} (${commitsClassified} classified)`, `${currentVersion} -> ${newVersion}`);

	const result: ShipBumpResult = {
		from: currentVersion,
		to: newVersion,
		bumpType,
		commitsClassified,
	};
	opts.writeEvent?.(result);
	return result;
}

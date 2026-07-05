// src/commands/ship-deps.ts
//
// Shared production adapter builders for finalizeCycleClose (ship-finalize.ts)
// and runShipBump (release/ship-bump.ts).
//
// Both `cam ship --bump` / `--finalize` (index.ts dispatchShip) and the
// sidecar's deterministic ship-phase runner (makeProductionShipPhaseFn,
// sidecar.ts, US-004 CAM-149) need the exact same real-fs/git wiring for
// these two steps. Extracted here so the two production callers never drift
// (jscpd duplication gate) -- previously index.ts's private _buildFinalizeOpts
// / _buildBumpOpts, now the single source of truth for both callers.
//
// US-004 (CAM-149).

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { FinalizeCycleCloseOptions } from './ship-finalize.ts';
import type { ShipBumpOptions, ShipBumpResult } from '../release/ship-bump.ts';
import { stashIssueIdInMergeWatch, MERGE_WATCH_FILENAME } from '../release/merge-watch.ts';
import { makeFileEventLogger } from '../supervisor/events.ts';

/** Build production deps for finalizeCycleClose from the given project root. */
export function buildShipFinalizeOpts(cwd: string): FinalizeCycleCloseOptions {
	return {
		cwd,
		spawnFn: spawnSync,
		clock: () => new Date().toISOString(),
		readProjectToml: () => readFileSync(join(cwd, 'scripts/cam/project.toml'), 'utf8'),
		readPrd: () => readFileSync(join(cwd, 'scripts/cam/prd.json'), 'utf8'),
		stashFn: (issueId: string) =>
			stashIssueIdInMergeWatch(join(cwd, '.claude', MERGE_WATCH_FILENAME), issueId),
	};
}

/** Build production deps for runShipBump from the given project root. */
export function buildShipBumpOpts(cwd: string): ShipBumpOptions {
	const eventLogger = makeFileEventLogger(join(cwd, '.claude/cam-worker-events.jsonl'));
	return {
		cwd,
		spawnFn: spawnSync,
		clock: () => new Date().toISOString(),
		readVersionTs: () => readFileSync(join(cwd, 'src/version.ts'), 'utf8'),
		readPackageJson: () => readFileSync(join(cwd, 'package.json'), 'utf8'),
		writeVersionTs: (text: string) => writeFileSync(join(cwd, 'src/version.ts'), text, 'utf8'),
		writePackageJson: (text: string) => writeFileSync(join(cwd, 'package.json'), text, 'utf8'),
		readChangelog: () => readFileSync(join(cwd, 'CHANGELOG.md'), 'utf8'),
		writeChangelog: (text: string) => writeFileSync(join(cwd, 'CHANGELOG.md'), text, 'utf8'),
		writeEvent: (event: ShipBumpResult) =>
			eventLogger({
				ts: new Date().toISOString(),
				storyId: undefined,
				uuid: 'ship-bump',
				kind: 'ship-bump',
				detail: event as unknown as Record<string, unknown>,
			}),
	};
}

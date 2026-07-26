// test/integration/orch-respawn-reresolve.test.ts
//
// US-003 (CAM-425): each while-true respawn iteration re-resolves model+effort
// via `cam orch-resolve` instead of re-execing the SAME literal argv baked in
// at initial `cam run` build time, so an edited project.toml takes effect at
// the next respawn (not never), and a failed/absent/malformed resolver falls
// back to the last known-good pair (still respawning) plus a divergence event.
//
// Both tests run the REAL assembled bash from buildOrchestratorPaneCommand via
// spawnSync (pattern: test/commands/run.test.ts:19-69), with a stub `claude` on
// PATH that appends its full argv to a file once per invocation and rewrites
// the handoff marker (so the loop iterates) or lets it fall through to natural
// teardown (so the script terminates without a timeout/kill-server dance).
//
// AC1 test: resolverCmd points at the REAL `bun index.ts orch-resolve`
// (full realism -- the "second test" the story notes call out), run against a
// STAGED temp project.toml that is edited (model AND effort) between the
// initial buildOrchestratorPaneCommand call and the spawnSync execution.
//
// AC2/AC3 test: resolverCmd points at a hand-authored stub resolver script
// (succeeds once, then fails), proving the fail-safe fallback + the
// KEY-AND-SHAPE parity of the bash-emitted 'orch-resolve-fallback' event
// against makeFileEventLogger's production WorkerEvent shape.

import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
	chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { buildOrchestratorPaneCommand } from '../../src/commands/run.ts';
import { makeFileEventLogger, type WorkerEventKind } from '../../src/supervisor/events.ts';
import { aggregateTokensPerIssue } from '../../src/stats/tokens.ts';

const REPO_ROOT = resolve(import.meta.dir, '../..');
const INDEX_TS = join(REPO_ROOT, 'index.ts');

/** Single-quote-escape a value for embedding in a bash script literal. */
function q(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Record separator (\x1e) / unit separator (\x1f): avoids any ambiguity with
 * spaces/newlines inside argv elements (the boot-prompt argv element is
 * multi-line free text). */
const RS = '\x1e';
const US = '\x1f';

/** Parse the stub-claude argv-capture log into one string[] per invocation. */
function parseArgvLog(path: string): string[][] {
	if (!existsSync(path)) return [];
	const raw = readFileSync(path, 'utf8');
	return raw
		.split(RS)
		.filter((record) => record.length > 0)
		.map((record) => record.split(US).filter((a) => a.length > 0));
}

/** Value of the argv element immediately following `flag`, or undefined. */
function flagValue(record: string[], flag: string): string | undefined {
	const idx = record.indexOf(flag);
	return idx === -1 ? undefined : record[idx + 1];
}

test('END-TO-END RE-RESOLUTION: real bun index.ts orch-resolve picks up a project.toml edit at the next respawn (AC1)', () => {
	const cwd = mkdtempSync(join(tmpdir(), 'cam-reresolve-e2e-'));
	try {
		const claudeDir = join(cwd, '.claude');
		mkdirSync(claudeDir, { recursive: true });
		const cfgDir = join(cwd, 'scripts', 'cam');
		mkdirSync(cfgDir, { recursive: true });
		const configPath = join(cfgDir, 'project.toml');
		writeFileSync(
			configPath,
			'backend = "claude"\n\n[models]\norchestrator = "opus"\n\n[efforts]\norchestrator = "high"\n',
			'utf8',
		);

		const handoffMarker = join(claudeDir, '.cam-orch-handoff.json');
		writeFileSync(handoffMarker, '{"schemaVersion":1,"writtenAt":"x","reason":"test-respawn"}', 'utf8');
		const promptFile = join(claudeDir, 'prompt.txt');
		writeFileSync(promptFile, 'noop-boot-prompt', 'utf8');

		const fakeBinDir = join(cwd, 'fake-bin');
		mkdirSync(fakeBinDir, { recursive: true });
		const argvLog = join(cwd, 'claude-argv.log');
		writeFileSync(
			join(fakeBinDir, 'claude'),
			[
				'#!/bin/bash',
				'{',
				'  for a in "$@"; do printf \'%s\\x1f\' "$a"; done',
				'  printf \'\\x1e\'',
				`} >> ${q(argvLog)}`,
				'exit 0',
				'',
			].join('\n'),
			'utf8',
		);
		chmodSync(join(fakeBinDir, 'claude'), 0o755);

		const eventsLogPath = join(claudeDir, 'cam-worker-events.jsonl');
		const resolverCmd = `${q(process.execPath)} ${q(INDEX_TS)} orch-resolve`;

		const cmd = buildOrchestratorPaneCommand({
			sessionName: 'cam-it-reresolve-e2e-nonexistent',
			sessionId: 'aaaa-e2e-bbbb',
			promptFile,
			sessionIdMarker: join(claudeDir, '.cam-orch-session'),
			handoffMarker,
			stateFile: join(claudeDir, 'cam-loop.local.md'),
			readyMarker: join(claudeDir, '.cam-orch-ready'),
			pidMarker: join(claudeDir, '.cam-orch-pid'),
			maxRespawns: 3,
			model: 'opus',
			effort: 'high',
			resolverCmd,
			eventsLogPath,
		});

		// EDIT the staged config's orchestrator model AND effort between the
		// initial build (above) and the simulated respawn (spawnSync below):
		// the bash wrapper's resolver call reads whatever this file says AT THE
		// MOMENT it executes, which -- since spawnSync has not started yet --
		// is already the new values by the time the respawn fires.
		writeFileSync(
			configPath,
			'backend = "claude"\n\n[models]\norchestrator = "sonnet"\n\n[efforts]\norchestrator = "max"\n',
			'utf8',
		);

		const result = spawnSync('bash', ['-c', cmd], {
			cwd,
			encoding: 'utf8',
			timeout: 15_000,
			env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}` },
		});
		expect(result.error).toBeUndefined();

		const invocations = parseArgvLog(argvLog);
		expect(invocations.length).toBe(2);
		const first = invocations[0] ?? [];
		const second = invocations[1] ?? [];

		// FIRST invocation carries the OLD (initially-built) model+effort.
		expect(flagValue(first, '--model')).toBe('opus');
		expect(flagValue(first, '--effort')).toBe('high');

		// SECOND (respawned) invocation carries the NEW model+effort, picked up
		// live from the edited project.toml via the real orch-resolve call.
		expect(flagValue(second, '--model')).toBe('sonnet');
		expect(flagValue(second, '--effort')).toBe('max');
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test('FAIL-SAFE + DIVERGENCE-EVENT SHAPE PARITY: a resolver that succeeds once then fails still respawns on the last known-good pair and records a shape-matching fallback event (AC2/AC3)', () => {
	const cwd = mkdtempSync(join(tmpdir(), 'cam-reresolve-fallback-'));
	try {
		const claudeDir = join(cwd, '.claude');
		mkdirSync(claudeDir, { recursive: true });

		const handoffMarker = join(claudeDir, '.cam-orch-handoff.json');
		const promptFile = join(claudeDir, 'prompt.txt');
		writeFileSync(promptFile, 'noop-boot-prompt', 'utf8');

		const fakeBinDir = join(cwd, 'fake-bin');
		mkdirSync(fakeBinDir, { recursive: true });
		const argvLog = join(cwd, 'claude-argv.log');
		const claudeCounter = join(cwd, 'claude-invocation-count');
		writeFileSync(
			join(fakeBinDir, 'claude'),
			[
				'#!/bin/bash',
				`COUNTER=${q(claudeCounter)}`,
				'count=$(cat "$COUNTER" 2>/dev/null || echo 0)',
				'count=$((count + 1))',
				'echo "$count" > "$COUNTER"',
				'{',
				'  for a in "$@"; do printf \'%s\\x1f\' "$a"; done',
				'  printf \'\\x1e\'',
				`} >> ${q(argvLog)}`,
				// Rewrite the handoff marker on invocations 1 and 2 so the wrapper
				// respawns twice; withhold it on invocation 3 so the loop naturally
				// falls into teardown (no external kill needed).
				'if [ "$count" -lt 3 ]; then',
				`  printf '{"schemaVersion":1,"writtenAt":"x","reason":"test-respawn"}' > ${q(handoffMarker)}`,
				'fi',
				'exit 0',
				'',
			].join('\n'),
			'utf8',
		);
		chmodSync(join(fakeBinDir, 'claude'), 0o755);
		writeFileSync(handoffMarker, '{"schemaVersion":1,"writtenAt":"x","reason":"test-respawn"}', 'utf8');

		// Stub resolver: succeeds (new model+effort) on its FIRST invocation,
		// fails (exit 1, nothing on stdout) on every subsequent one.
		const resolverScript = join(cwd, 'stub-resolver.sh');
		const resolverCounter = join(cwd, 'resolver-invocation-count');
		writeFileSync(
			resolverScript,
			[
				'#!/bin/bash',
				`COUNTER=${q(resolverCounter)}`,
				'count=$(cat "$COUNTER" 2>/dev/null || echo 0)',
				'count=$((count + 1))',
				'echo "$count" > "$COUNTER"',
				'if [ "$count" -eq 1 ]; then',
				'  echo \'{"model":"claude-resolved-once","backend":"claude","effort":"max"}\'',
				'  exit 0',
				'else',
				'  exit 1',
				'fi',
				'',
			].join('\n'),
			'utf8',
		);
		chmodSync(resolverScript, 0o755);

		const eventsLogPath = join(claudeDir, 'cam-worker-events.jsonl');

		const cmd = buildOrchestratorPaneCommand({
			sessionName: 'cam-it-reresolve-fallback-nonexistent',
			sessionId: 'aaaa-fallback-bbbb',
			promptFile,
			sessionIdMarker: join(claudeDir, '.cam-orch-session'),
			handoffMarker,
			stateFile: join(claudeDir, 'cam-loop.local.md'),
			readyMarker: join(claudeDir, '.cam-orch-ready'),
			pidMarker: join(claudeDir, '.cam-orch-pid'),
			maxRespawns: 3,
			model: 'opus',
			effort: 'high',
			resolverCmd: q(resolverScript),
			eventsLogPath,
		});

		const result = spawnSync('bash', ['-c', cmd], {
			cwd,
			encoding: 'utf8',
			timeout: 15_000,
			env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}` },
		});
		expect(result.error).toBeUndefined();

		const invocations = parseArgvLog(argvLog);
		expect(invocations.length).toBe(3);
		const [first, second, third] = invocations as [string[], string[], string[]];

		// Invocation 1: initial (TS-resolved) seed.
		expect(flagValue(first, '--model')).toBe('opus');
		expect(flagValue(first, '--effort')).toBe('high');
		// Invocation 2: resolver succeeded -> new pair reaches argv.
		expect(flagValue(second, '--model')).toBe('claude-resolved-once');
		expect(flagValue(second, '--effort')).toBe('max');
		// Invocation 3: resolver FAILED, but the wrapper still respawned, on the
		// LAST KNOWN-GOOD pair (invocation 2's values), never the original seed.
		expect(flagValue(third, '--model')).toBe('claude-resolved-once');
		expect(flagValue(third, '--effort')).toBe('max');

		// --- Divergence-event shape parity (AC3) --------------------------------
		expect(existsSync(eventsLogPath)).toBe(true);
		const lines = readFileSync(eventsLogPath, 'utf8')
			.trim()
			.split('\n')
			.filter((l) => l.length > 0)
			.map((l) => JSON.parse(l) as Record<string, unknown>);
		const fallbackLines = lines.filter((l) => l['kind'] === 'orch-resolve-fallback');
		expect(fallbackLines.length).toBe(1);
		const bashLine = fallbackLines[0] as Record<string, unknown>;

		// kind is typed as WorkerEventKind here so a future union-drift (the
		// 'orch-resolve-fallback' literal renamed/removed) fails typecheck, not
		// just this runtime assertion.
		const expectedKind: WorkerEventKind = 'orch-resolve-fallback';
		expect(bashLine['kind']).toBe(expectedKind);
		expect(bashLine['detail']).toEqual({ phase: 'orchestrator', model: 'claude-resolved-once', effort: 'max' });

		// Build the PRODUCTION comparand via makeFileEventLogger for the
		// equivalent WorkerEvent (storyId: undefined, same as every other
		// orchestrator-phase event -- e.g. the 'spawn-resolution' events emitted
		// by run.ts/orch-resolve.ts), and assert KEY-AND-SHAPE identity.
		const comparandLogPath = join(cwd, 'comparand-events.jsonl');
		const comparandLogger = makeFileEventLogger(comparandLogPath);
		comparandLogger({
			ts: new Date().toISOString(),
			storyId: undefined,
			uuid: 'aaaa-fallback-bbbb',
			kind: 'orch-resolve-fallback',
			detail: { phase: 'orchestrator', model: 'claude-resolved-once', effort: 'max' },
		});
		const comparandLine = JSON.parse(readFileSync(comparandLogPath, 'utf8').trim()) as Record<string, unknown>;

		expect(Object.keys(bashLine).sort()).toEqual(Object.keys(comparandLine).sort());
		expect(Object.keys(bashLine['detail'] as Record<string, unknown>).sort()).toEqual(
			Object.keys(comparandLine['detail'] as Record<string, unknown>).sort(),
		);
		// storyId is genuinely OMITTED (JSON.stringify drops an undefined value),
		// never emitted as a literal null, in both the production writer and the
		// bash printf line.
		expect('storyId' in bashLine).toBe(false);
		expect('storyId' in comparandLine).toBe(false);

		// aggregateTokensPerIssue must process a log containing this line
		// without throwing or misattributing (it isn't a 'tokens'/'cycle-tokens'
		// kind, so it is simply ignored: no per-issue rollup, no unattributed
		// spend contribution).
		const fullLog = readFileSync(eventsLogPath, 'utf8');
		let summary: ReturnType<typeof aggregateTokensPerIssue> | undefined;
		expect(() => {
			summary = aggregateTokensPerIssue(fullLog);
		}).not.toThrow();
		expect(summary?.perIssue).toEqual([]);
		expect(summary?.unattributedTokens).toBe(0);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

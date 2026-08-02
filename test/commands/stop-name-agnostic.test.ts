// test/commands/stop-name-agnostic.test.ts
//
// US-004 (CAM-482): sidecar process discovery in `cam stop` must recognize a
// live sidecar regardless of the name (or runtime) it was launched under,
// since self-spawn now resolves by execPath (US-002/US-003) rather than a
// literal "cam" binary name, and the binary may eventually ship under a
// different name entirely.
//
// This file is RED against main: `matchesSidecarForProject` on main requires
// `record.argv[0] === 'cam'` and `record.argv[1] === 'sidecar'`, so both the
// differently-named-compiled-binary case and the interpreted-runtime case
// below return `false` there, failing these `toBe(true)` assertions.
//
// Four cases (per acceptance criteria):
//   1. compiled sidecar, argv[0] basename != the currently-running binary -> MATCH
//   2. interpreted sidecar `<runtime> <script> sidecar` -> MATCH
//   3. matching argv shape, DIFFERENT cwd -> NO MATCH
//   4. matching cwd, NOT running the sidecar subcommand -> NO MATCH

import { describe, expect, test } from 'bun:test';
import { basename } from 'node:path';
import process from 'node:process';

import { matchesSidecarForProject } from '../../src/commands/stop.ts';
import type { ProcessRecord } from '../../src/commands/stop.ts';

const PROJECT_CWD = '/fake/project-alpha';
const FOREIGN_CWD = '/fake/project-beta';

// Sanity: the fixture's compiled-binary path must genuinely differ from the
// real binary running this test, or case 1 would be a tautology.
const DIFFERENTLY_NAMED_BINARY = '/opt/renamed-dist/gship-renamed';
const realBasename = basename(process.execPath);
if (basename(DIFFERENTLY_NAMED_BINARY) === realBasename) {
	throw new Error('test fixture collision: pick a fixture binary name that differs from the real one');
}

describe('matchesSidecarForProject — name-agnostic discovery (US-004, CAM-482)', () => {
	test('case 1: compiled sidecar with a DIFFERENT argv[0] basename MATCHES', () => {
		const record: ProcessRecord = {
			pid: 51000,
			argv: [DIFFERENTLY_NAMED_BINARY, 'sidecar'],
			cwd: PROJECT_CWD,
		};
		expect(matchesSidecarForProject(record, PROJECT_CWD)).toBe(true);
	});

	test('case 2: interpreted sidecar `<runtime> <script> sidecar` MATCHES', () => {
		const record: ProcessRecord = {
			pid: 51001,
			argv: ['bun', '/repo/index.ts', 'sidecar'],
			cwd: PROJECT_CWD,
		};
		expect(matchesSidecarForProject(record, PROJECT_CWD)).toBe(true);
	});

	test('case 3: matching sidecar argv shape but a DIFFERENT cwd does NOT match', () => {
		const record: ProcessRecord = {
			pid: 51002,
			argv: [DIFFERENTLY_NAMED_BINARY, 'sidecar'],
			cwd: FOREIGN_CWD,
		};
		expect(matchesSidecarForProject(record, PROJECT_CWD)).toBe(false);
	});

	test('case 4: matching cwd but NOT running the sidecar subcommand does NOT match', () => {
		const record: ProcessRecord = {
			pid: 51003,
			argv: ['bun', '/repo/index.ts', 'run'],
			cwd: PROJECT_CWD,
		};
		expect(matchesSidecarForProject(record, PROJECT_CWD)).toBe(false);
	});
});

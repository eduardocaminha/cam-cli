// test/supervisor/scope-proposal.test.ts
//
// Unit tests for src/supervisor/scope-proposal.ts (US-002, CAM-52).
//
// Coverage:
//   1. SCOPE_PROPOSAL_FILENAME is the expected path.
//   2. makeReadScopeProposal returns null when the file is absent.
//   3. makeReadScopeProposal returns null on malformed JSON (parse error).
//   4. makeReadScopeProposal returns null for a top-level JSON array.
//   5. makeReadScopeProposal returns null for missing/wrong-type required fields
//      (problem, inScopeStories, outOfScope, framing.mvp, framing.launchReady).
//   6. makeReadScopeProposal returns the parsed object for a valid file.
//   7. Reader is a stable closure: re-reads the file on each call.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	SCOPE_PROPOSAL_FILENAME,
	makeReadScopeProposal,
	type ScopeProposal,
} from '../../src/supervisor/scope-proposal.ts';

describe('SCOPE_PROPOSAL_FILENAME', () => {
	test("is 'scripts/cam/scope-proposal.json'", () => {
		expect(SCOPE_PROPOSAL_FILENAME).toBe('scripts/cam/scope-proposal.json');
	});
});

describe('makeReadScopeProposal', () => {
	let tmpDir: string;
	let proposalPath: string;

	const validProposal: ScopeProposal = {
		problem: 'The plan phase has no consistent scope narration.',
		inScopeStories: ['US-001', 'US-002'],
		outOfScope: ['A later PRD for review-time scope narration'],
		framing: {
			mvp: 'Emit and read a fixed-shape scope-proposal artifact.',
			launchReady: 'same as MVP',
		},
	};

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'cam-scope-proposal-test-'));
		mkdirSync(join(tmpDir, 'scripts', 'cam'), { recursive: true });
		proposalPath = join(tmpDir, SCOPE_PROPOSAL_FILENAME);
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test('returns null when file does not exist', () => {
		const read = makeReadScopeProposal(tmpDir);
		expect(read()).toBeNull();
	});

	test('returns null on malformed JSON', () => {
		writeFileSync(proposalPath, 'not valid json {{{');
		const read = makeReadScopeProposal(tmpDir);
		expect(read()).toBeNull();
	});

	test('returns null for a top-level JSON array', () => {
		writeFileSync(proposalPath, JSON.stringify([validProposal]));
		const read = makeReadScopeProposal(tmpDir);
		expect(read()).toBeNull();
	});

	test('returns null when problem is missing', () => {
		const { problem: _problem, ...rest } = validProposal;
		writeFileSync(proposalPath, JSON.stringify(rest));
		const read = makeReadScopeProposal(tmpDir);
		expect(read()).toBeNull();
	});

	test('returns null when problem is the wrong type', () => {
		writeFileSync(proposalPath, JSON.stringify({ ...validProposal, problem: 42 }));
		const read = makeReadScopeProposal(tmpDir);
		expect(read()).toBeNull();
	});

	test('returns null when inScopeStories is not a string array', () => {
		writeFileSync(proposalPath, JSON.stringify({ ...validProposal, inScopeStories: [1, 2] }));
		expect(makeReadScopeProposal(tmpDir)()).toBeNull();
	});

	test('returns null when inScopeStories is missing', () => {
		const { inScopeStories: _inScopeStories, ...rest } = validProposal;
		writeFileSync(proposalPath, JSON.stringify(rest));
		expect(makeReadScopeProposal(tmpDir)()).toBeNull();
	});

	test('returns null when outOfScope is not a string array', () => {
		writeFileSync(proposalPath, JSON.stringify({ ...validProposal, outOfScope: 'none' }));
		expect(makeReadScopeProposal(tmpDir)()).toBeNull();
	});

	test('returns null when framing is missing', () => {
		const { framing: _framing, ...rest } = validProposal;
		writeFileSync(proposalPath, JSON.stringify(rest));
		expect(makeReadScopeProposal(tmpDir)()).toBeNull();
	});

	test('returns null when framing is a top-level array', () => {
		writeFileSync(proposalPath, JSON.stringify({ ...validProposal, framing: ['mvp', 'launchReady'] }));
		expect(makeReadScopeProposal(tmpDir)()).toBeNull();
	});

	test('returns null when framing.mvp is missing', () => {
		writeFileSync(proposalPath, JSON.stringify({ ...validProposal, framing: { launchReady: 'same as MVP' } }));
		expect(makeReadScopeProposal(tmpDir)()).toBeNull();
	});

	test('returns null when framing.launchReady is the wrong type', () => {
		writeFileSync(
			proposalPath,
			JSON.stringify({ ...validProposal, framing: { mvp: 'x', launchReady: false } }),
		);
		expect(makeReadScopeProposal(tmpDir)()).toBeNull();
	});

	test('returns the parsed object for a valid file', () => {
		writeFileSync(proposalPath, JSON.stringify(validProposal));
		const read = makeReadScopeProposal(tmpDir);
		const result = read();
		expect(result).not.toBeNull();
		expect(result?.problem).toBe(validProposal.problem);
		expect(result?.inScopeStories).toEqual(['US-001', 'US-002']);
		expect(result?.outOfScope).toEqual(['A later PRD for review-time scope narration']);
		expect(result?.framing.mvp).toBe(validProposal.framing.mvp);
		expect(result?.framing.launchReady).toBe('same as MVP');
	});

	test('accepts outOfScope: ["none"] when nothing is deferred', () => {
		const proposal: ScopeProposal = { ...validProposal, outOfScope: ['none'] };
		writeFileSync(proposalPath, JSON.stringify(proposal));
		expect(makeReadScopeProposal(tmpDir)()?.outOfScope).toEqual(['none']);
	});

	test('reader is a stable closure: second call re-reads the file', () => {
		writeFileSync(proposalPath, JSON.stringify(validProposal));
		const read = makeReadScopeProposal(tmpDir);
		expect(read()?.problem).toBe(validProposal.problem);

		const updated: ScopeProposal = { ...validProposal, problem: 'Updated problem statement.' };
		writeFileSync(proposalPath, JSON.stringify(updated));
		expect(read()?.problem).toBe('Updated problem statement.');
	});
});

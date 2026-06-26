// test/setup-readline-eof.test.ts
//
// Unit tests for ask() and askChoice() EOF/close behaviour.
// Verifies that both functions resolve to their default values when stdin
// reaches EOF (close event) without any line being entered, and that
// normal line-driven input (happy path) is preserved byte-for-byte.

import { describe, expect, it } from 'bun:test';
import { Readable } from 'node:stream';
import { ask, askChoice } from '../src/commands/setup.ts';

// ---------------------------------------------------------------------------
// Stream helpers
// ---------------------------------------------------------------------------

/** A stream that immediately signals EOF with no data. */
function makeEofStream(): Readable {
	return new Readable({
		read() {
			this.push(null);
		},
	});
}

/** A stream that emits a single line then EOF. */
function makeLineStream(line: string): Readable {
	let emitted = false;
	return new Readable({
		read() {
			if (!emitted) {
				emitted = true;
				this.push(line + '\n');
				this.push(null);
			}
		},
	});
}

// ---------------------------------------------------------------------------
// ask()
// ---------------------------------------------------------------------------

describe('ask() – EOF resolution', () => {
	it('resolves to the supplied default when stdin emits EOF before any line', async () => {
		const result = await ask('Question?', 'my-default', makeEofStream());
		expect(result).toBe('my-default');
	});

	it('resolves to empty string when no default is supplied and stdin emits EOF', async () => {
		const result = await ask('Question?', '', makeEofStream());
		expect(result).toBe('');
	});

	it('does not hang (resolves within 2s) when stdin is immediately closed', async () => {
		const start = Date.now();
		await ask('Question?', 'fallback', makeEofStream());
		expect(Date.now() - start).toBeLessThan(2000);
	});
});

describe('ask() – happy path (line input still wins)', () => {
	it('resolves to the trimmed line when a line is entered before close', async () => {
		const result = await ask('Question?', 'default', makeLineStream('  hello world  '));
		expect(result).toBe('hello world');
	});

	it('close-driven resolve is a no-op when line was already answered', async () => {
		// The stream emits a line then EOF; the answered flag prevents double-resolve.
		const results: string[] = [];
		const p = ask('Q?', 'should-not-appear', makeLineStream('typed answer'));
		results.push(await p);
		expect(results).toEqual(['typed answer']);
	});
});

// ---------------------------------------------------------------------------
// askChoice()
// ---------------------------------------------------------------------------

describe('askChoice() – EOF resolution', () => {
	it('resolves to defaultChoice when stdin emits EOF before any line', async () => {
		const result = await askChoice(
			'Pick one',
			['new', 'existing'] as const,
			'existing',
			makeEofStream(),
		);
		expect(result).toBe('existing');
	});

	it('resolves to defaultChoice for a 3-option set on EOF', async () => {
		const result = await askChoice(
			'Issue system',
			['linear', 'github', 'none'] as const,
			'none',
			makeEofStream(),
		);
		expect(result).toBe('none');
	});

	it('does not hang (resolves within 2s) when stdin is immediately closed', async () => {
		const start = Date.now();
		await askChoice('Pick', ['a', 'b'] as const, 'a', makeEofStream());
		expect(Date.now() - start).toBeLessThan(2000);
	});
});

describe('askChoice() – happy path (line input still wins)', () => {
	it('resolves to the chosen option when a valid choice is entered', async () => {
		const result = await askChoice(
			'Pick one',
			['new', 'existing'] as const,
			'existing',
			makeLineStream('new'),
		);
		expect(result).toBe('new');
	});

	it('resolves to the defaultChoice when an empty line is entered', async () => {
		const result = await askChoice(
			'Pick one',
			['new', 'existing'] as const,
			'existing',
			makeLineStream(''),
		);
		expect(result).toBe('existing');
	});
});

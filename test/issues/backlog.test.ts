// test/issues/backlog.test.ts
//
// Tests for src/issues/backlog.ts (readBacklogFromMain).
//
// Oracle assertions:
//   - Subprocess count is O(1): one ls-tree + one cat-file --batch regardless
//     of how many issue files exist (spawn spy).
//   - Numeric sort: CAM-9 before CAM-12, CAM-1000 after CAM-999.
//   - Read-from-main invariant: the git ref in both subprocess calls is `main`.
//   - Empty dir: returns [] without calling cat-file --batch.
//   - Unparseable blobs are skipped silently.

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import type { IssueEntry } from '../../src/issues/types.ts';
import {
	readBacklogFromMain,
	allocateId,
	type BacklogSpawnFn,
} from '../../src/issues/backlog.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<IssueEntry> & { id: string }): IssueEntry {
	return {
		title: `Issue ${overrides.id}`,
		stage: 'idea',
		status: 'open',
		blockedBy: [],
		createdAt: '2026-01-01T00:00:00Z',
		...overrides,
	};
}

/**
 * Builds the framed output string that `git cat-file --batch` would emit for
 * the given entries.
 *
 * Frame format per entry: `<oid> blob <size>\n<content>\n`
 * Size is the UTF-8 byte length of the JSON content.
 */
function makeBatchOutput(entries: IssueEntry[]): string {
	let output = '';
	for (const entry of entries) {
		const content = JSON.stringify(entry);
		const size = Buffer.byteLength(content, 'utf8');
		output += `deadbeef0000000000000000000000000000000000 blob ${size}\n${content}\n`;
	}
	return output;
}

/** Empty SpawnSyncReturns<string> stub. */
function emptyReturn(): SpawnSyncReturns<string> {
	return {
		stdout: '',
		stderr: '',
		status: 0,
		output: [],
		pid: 0,
		signal: null,
		error: undefined,
	};
}

// ---------------------------------------------------------------------------
// O(1) subprocess count
// ---------------------------------------------------------------------------

describe('readBacklogFromMain -- subprocess count', () => {
	test('calls exactly 2 subprocesses (one ls-tree + one cat-file --batch) for N=3 files', () => {
		const entries = [
			makeEntry({ id: 'CAM-1' }),
			makeEntry({ id: 'CAM-2' }),
			makeEntry({ id: 'CAM-3' }),
		];
		let callCount = 0;

		const spy: BacklogSpawnFn = (_cmd, args, _opts) => {
			callCount++;
			if (args.includes('ls-tree')) {
				return {
					...emptyReturn(),
					stdout:
						'scripts/cam/issues/CAM-001.json\nscripts/cam/issues/CAM-002.json\nscripts/cam/issues/CAM-003.json\n',
				};
			}
			// cat-file --batch
			return { ...emptyReturn(), stdout: makeBatchOutput(entries) };
		};

		readBacklogFromMain('/fake/cwd', spy);
		expect(callCount).toBe(2);
	});

	test('calls exactly 1 subprocess (ls-tree only) when no files exist', () => {
		let callCount = 0;
		const spy: BacklogSpawnFn = (_cmd, _args, _opts) => {
			callCount++;
			return emptyReturn();
		};

		const result = readBacklogFromMain('/fake/cwd', spy);
		expect(result).toEqual([]);
		expect(callCount).toBe(1);
	});

	test('subprocess count stays at 2 for N=100 files (O(1))', () => {
		const n = 100;
		const entries = Array.from({ length: n }, (_, i) =>
			makeEntry({ id: `CAM-${i + 1}` }),
		);
		const paths = entries
			.map((e) => `scripts/cam/issues/${e.id}.json`)
			.join('\n');

		let callCount = 0;
		const spy: BacklogSpawnFn = (_cmd, args, _opts) => {
			callCount++;
			if (args.includes('ls-tree')) {
				return { ...emptyReturn(), stdout: paths + '\n' };
			}
			return { ...emptyReturn(), stdout: makeBatchOutput(entries) };
		};

		readBacklogFromMain('/fake/cwd', spy);
		expect(callCount).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Numeric sort
// ---------------------------------------------------------------------------

describe('readBacklogFromMain -- numeric sort', () => {
	test('CAM-9 sorts before CAM-12', () => {
		const entries = [makeEntry({ id: 'CAM-12' }), makeEntry({ id: 'CAM-9' })];
		const spy: BacklogSpawnFn = (_cmd, args) => {
			if (args.includes('ls-tree')) {
				return {
					...emptyReturn(),
					stdout:
						'scripts/cam/issues/CAM-012.json\nscripts/cam/issues/CAM-009.json\n',
				};
			}
			return { ...emptyReturn(), stdout: makeBatchOutput(entries) };
		};

		const result = readBacklogFromMain('/fake/cwd', spy);
		const ids = result.map((e) => e.id);
		expect(ids.indexOf('CAM-9')).toBeLessThan(ids.indexOf('CAM-12'));
	});

	test('CAM-999 sorts before CAM-1000', () => {
		const entries = [
			makeEntry({ id: 'CAM-1000' }),
			makeEntry({ id: 'CAM-999' }),
		];
		const spy: BacklogSpawnFn = (_cmd, args) => {
			if (args.includes('ls-tree')) {
				return {
					...emptyReturn(),
					stdout:
						'scripts/cam/issues/CAM-1000.json\nscripts/cam/issues/CAM-0999.json\n',
				};
			}
			return { ...emptyReturn(), stdout: makeBatchOutput(entries) };
		};

		const result = readBacklogFromMain('/fake/cwd', spy);
		const ids = result.map((e) => e.id);
		expect(ids.indexOf('CAM-999')).toBeLessThan(ids.indexOf('CAM-1000'));
	});

	test('correct numeric sort order for mixed set: 9, 12, 999, 1000', () => {
		const entries = [
			makeEntry({ id: 'CAM-1000' }),
			makeEntry({ id: 'CAM-9' }),
			makeEntry({ id: 'CAM-12' }),
			makeEntry({ id: 'CAM-999' }),
		];
		const spy: BacklogSpawnFn = (_cmd, args) => {
			if (args.includes('ls-tree')) {
				return {
					...emptyReturn(),
					stdout: entries
						.map((e) => `scripts/cam/issues/${e.id}.json`)
						.join('\n') + '\n',
				};
			}
			return { ...emptyReturn(), stdout: makeBatchOutput(entries) };
		};

		const result = readBacklogFromMain('/fake/cwd', spy);
		expect(result.map((e) => e.id)).toEqual([
			'CAM-9',
			'CAM-12',
			'CAM-999',
			'CAM-1000',
		]);
	});

	test('lexical sort on padded filenames does not affect output order', () => {
		// ls-tree returns lexically-sorted padded filenames: CAM-009, CAM-012
		// but sort must be numeric on the parsed id, not lexical on the filename.
		const entries = [makeEntry({ id: 'CAM-12' }), makeEntry({ id: 'CAM-9' })];
		const spy: BacklogSpawnFn = (_cmd, args) => {
			if (args.includes('ls-tree')) {
				// Padded filenames in reverse numeric order (CAM-012 before CAM-009
				// lexically, but 9 < 12 numerically).
				return {
					...emptyReturn(),
					stdout:
						'scripts/cam/issues/CAM-009.json\nscripts/cam/issues/CAM-012.json\n',
				};
			}
			return { ...emptyReturn(), stdout: makeBatchOutput(entries) };
		};

		const result = readBacklogFromMain('/fake/cwd', spy);
		// Numeric sort must put CAM-9 first regardless of filename ordering.
		expect(result[0]?.id).toBe('CAM-9');
		expect(result[1]?.id).toBe('CAM-12');
	});
});

// ---------------------------------------------------------------------------
// Read-from-main invariant
// ---------------------------------------------------------------------------

describe('readBacklogFromMain -- read-from-main invariant', () => {
	test('ls-tree call references `main` as the tree-ish', () => {
		let lsTreeArgs: string[] = [];

		const spy: BacklogSpawnFn = (_cmd, args, _opts) => {
			if (args.includes('ls-tree')) {
				lsTreeArgs = args;
				return {
					...emptyReturn(),
					stdout: 'scripts/cam/issues/CAM-001.json\n',
				};
			}
			return {
				...emptyReturn(),
				stdout: makeBatchOutput([makeEntry({ id: 'CAM-1' })]),
			};
		};

		readBacklogFromMain('/fake/cwd', spy);
		// `main` must appear as an explicit argument to ls-tree (the tree-ish).
		expect(lsTreeArgs).toContain('main');
	});

	test('cat-file --batch stdin uses `main:` ref prefix for every path', () => {
		let catFileInput: string | undefined;

		const spy: BacklogSpawnFn = (_cmd, args, opts) => {
			if (args.includes('ls-tree')) {
				return {
					...emptyReturn(),
					stdout:
						'scripts/cam/issues/CAM-001.json\nscripts/cam/issues/CAM-002.json\n',
				};
			}
			catFileInput = opts.input;
			return {
				...emptyReturn(),
				stdout: makeBatchOutput([
					makeEntry({ id: 'CAM-1' }),
					makeEntry({ id: 'CAM-2' }),
				]),
			};
		};

		readBacklogFromMain('/fake/cwd', spy);
		// Every line of the cat-file --batch stdin must start with "main:".
		expect(catFileInput).toBeDefined();
		const lines = (catFileInput ?? '').split('\n').filter(Boolean);
		expect(lines.length).toBe(2);
		for (const line of lines) {
			expect(line.startsWith('main:')).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('readBacklogFromMain -- edge cases', () => {
	test('returns empty array when ls-tree output is empty (dir absent)', () => {
		const spy: BacklogSpawnFn = () => emptyReturn();
		expect(readBacklogFromMain('/fake/cwd', spy)).toEqual([]);
	});

	test('skips unparseable blob content silently', () => {
		const spy: BacklogSpawnFn = (_cmd, args, _opts) => {
			if (args.includes('ls-tree')) {
				return {
					...emptyReturn(),
					stdout:
						'scripts/cam/issues/CAM-001.json\nscripts/cam/issues/CAM-002.json\n',
				};
			}
			// First blob: valid JSON; second blob: invalid JSON.
			const valid = JSON.stringify(makeEntry({ id: 'CAM-1' }));
			const invalid = 'not-valid-json{{{';
			const size1 = Buffer.byteLength(valid, 'utf8');
			const size2 = Buffer.byteLength(invalid, 'utf8');
			return {
				...emptyReturn(),
				stdout:
					`deadbeef0000000000000000000000000000000000 blob ${size1}\n${valid}\n` +
					`deadbeef0000000000000000000000000000000001 blob ${size2}\n${invalid}\n`,
			};
		};

		const result = readBacklogFromMain('/fake/cwd', spy);
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe('CAM-1');
	});

	test('skips "missing" entries in cat-file --batch output', () => {
		const entry = makeEntry({ id: 'CAM-1' });
		const spy: BacklogSpawnFn = (_cmd, args) => {
			if (args.includes('ls-tree')) {
				return {
					...emptyReturn(),
					stdout:
						'scripts/cam/issues/CAM-001.json\nscripts/cam/issues/DELETED.json\n',
				};
			}
			const content = JSON.stringify(entry);
			const size = Buffer.byteLength(content, 'utf8');
			return {
				...emptyReturn(),
				stdout:
					`deadbeef blob ${size}\n${content}\n` +
					`main:scripts/cam/issues/DELETED.json missing\n`,
			};
		};

		const result = readBacklogFromMain('/fake/cwd', spy);
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe('CAM-1');
	});
});

// ---------------------------------------------------------------------------
// Multi-byte UTF-8 (byte-vs-char correctness)
// ---------------------------------------------------------------------------

describe('readBacklogFromMain -- multi-byte UTF-8 correctness', () => {
	// Regression for the byte-vs-char bug: git cat-file --batch reports <size>
	// in BYTES, but the old implementation sliced by character count.  Any blob
	// containing multi-byte UTF-8 characters (e.g. Portuguese accents like
	// "acao", "migração", "ção") was corrupted and then dropped, causing silent
	// data loss.  These tests confirm byte-accurate slicing is now applied.

	test('entry with accented Portuguese title survives round-trip', () => {
		// "migração" contains two 2-byte UTF-8 code points: "ç" (U+00E7) and
		// "ã" (U+00E3).  byteLength=10 but charLength=8.
		const entry = makeEntry({ id: 'CAM-1', title: 'migração de issues' });
		const spy: BacklogSpawnFn = (_cmd, args) => {
			if (args.includes('ls-tree')) {
				return {
					...emptyReturn(),
					stdout: 'scripts/cam/issues/CAM-001.json\n',
				};
			}
			return { ...emptyReturn(), stdout: makeBatchOutput([entry]) };
		};

		const result = readBacklogFromMain('/fake/cwd', spy);
		expect(result).toHaveLength(1);
		expect(result[0]?.title).toBe('migração de issues');
	});

	test('second entry after multi-byte first entry is not desynchronised', () => {
		// If byte-vs-char slicing is broken, the position is advanced by the
		// BYTE count of the first entry but the string has fewer characters,
		// causing the parser to overshoot and read into the second entry's
		// header -- corrupting or dropping the second entry.
		const entry1 = makeEntry({ id: 'CAM-1', title: 'ação de melhoria' });
		const entry2 = makeEntry({ id: 'CAM-2', title: 'simple ascii title' });
		const spy: BacklogSpawnFn = (_cmd, args) => {
			if (args.includes('ls-tree')) {
				return {
					...emptyReturn(),
					stdout:
						'scripts/cam/issues/CAM-001.json\nscripts/cam/issues/CAM-002.json\n',
				};
			}
			return { ...emptyReturn(), stdout: makeBatchOutput([entry1, entry2]) };
		};

		const result = readBacklogFromMain('/fake/cwd', spy);
		expect(result).toHaveLength(2);
		expect(result[0]?.title).toBe('ação de melhoria');
		expect(result[1]?.title).toBe('simple ascii title');
	});

	test('all 3 entries with accents are parsed when byteLength > charLength for all', () => {
		// Simulates the real-world 129-issue backlog scenario described in the
		// US-R1-001 notes: entries with accented content were silently dropped.
		const entries = [
			makeEntry({ id: 'CAM-1', title: 'cancelação de sessão' }),
			makeEntry({ id: 'CAM-2', title: 'configuração inicial' }),
			makeEntry({ id: 'CAM-3', title: 'integração contínua' }),
		];
		const spy: BacklogSpawnFn = (_cmd, args) => {
			if (args.includes('ls-tree')) {
				return {
					...emptyReturn(),
					stdout:
						'scripts/cam/issues/CAM-001.json\nscripts/cam/issues/CAM-002.json\nscripts/cam/issues/CAM-003.json\n',
				};
			}
			return { ...emptyReturn(), stdout: makeBatchOutput(entries) };
		};

		const result = readBacklogFromMain('/fake/cwd', spy);
		expect(result).toHaveLength(3);
		expect(result[0]?.title).toBe('cancelação de sessão');
		expect(result[1]?.title).toBe('configuração inicial');
		expect(result[2]?.title).toBe('integração contínua');
	});
});

// ---------------------------------------------------------------------------
// allocateId
// ---------------------------------------------------------------------------

describe('allocateId', () => {
	test('returns max+1 given a fixture backlog', () => {
		const entries = [
			makeEntry({ id: 'CAM-3' }),
			makeEntry({ id: 'CAM-7' }),
			makeEntry({ id: 'CAM-12' }),
		];
		const spy: BacklogSpawnFn = (_cmd, args) => {
			if (args.includes('ls-tree')) {
				return {
					...emptyReturn(),
					stdout: entries.map((e) => `scripts/cam/issues/${e.id}.json`).join('\n') + '\n',
				};
			}
			return { ...emptyReturn(), stdout: makeBatchOutput(entries) };
		};

		expect(allocateId('/fake/cwd', spy)).toBe(13);
	});

	test('returns 1 for an empty backlog (no issues directory)', () => {
		const spy: BacklogSpawnFn = () => emptyReturn();
		expect(allocateId('/fake/cwd', spy)).toBe(1);
	});

	test('returns 1 for an empty issues directory (ls-tree returns nothing)', () => {
		const spy: BacklogSpawnFn = (_cmd, args) => {
			if (args.includes('ls-tree')) {
				return { ...emptyReturn(), stdout: '\n' };
			}
			return emptyReturn();
		};
		expect(allocateId('/fake/cwd', spy)).toBe(1);
	});

	test('max is numeric, not lexical: CAM-9 is max when ids are 1,2,9', () => {
		const entries = [
			makeEntry({ id: 'CAM-1' }),
			makeEntry({ id: 'CAM-2' }),
			makeEntry({ id: 'CAM-9' }),
		];
		const spy: BacklogSpawnFn = (_cmd, args) => {
			if (args.includes('ls-tree')) {
				return {
					...emptyReturn(),
					stdout: 'scripts/cam/issues/CAM-009.json\nscripts/cam/issues/CAM-001.json\nscripts/cam/issues/CAM-002.json\n',
				};
			}
			return { ...emptyReturn(), stdout: makeBatchOutput(entries) };
		};
		expect(allocateId('/fake/cwd', spy)).toBe(10);
	});

	test('returns 130 when max id is 129 (real-world REPO FACT)', () => {
		const entries = Array.from({ length: 129 }, (_, i) =>
			makeEntry({ id: `CAM-${i + 1}` }),
		);
		const paths = entries.map((e) => `scripts/cam/issues/CAM-${String(e.id.split('-')[1]).padStart(4,'0')}.json`).join('\n');
		const spy: BacklogSpawnFn = (_cmd, args) => {
			if (args.includes('ls-tree')) {
				return { ...emptyReturn(), stdout: paths + '\n' };
			}
			return { ...emptyReturn(), stdout: makeBatchOutput(entries) };
		};
		expect(allocateId('/fake/cwd', spy)).toBe(130);
	});

	test('handles ids above 999 (CAM-1000 -> next is 1001)', () => {
		const entries = [makeEntry({ id: 'CAM-1000' })];
		const spy: BacklogSpawnFn = (_cmd, args) => {
			if (args.includes('ls-tree')) {
				return { ...emptyReturn(), stdout: 'scripts/cam/issues/CAM-1000.json\n' };
			}
			return { ...emptyReturn(), stdout: makeBatchOutput(entries) };
		};
		expect(allocateId('/fake/cwd', spy)).toBe(1001);
	});
});

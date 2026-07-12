// test/help-registry.test.ts
//
// US-001 (CAM-211): central --help/-h short-circuit guard at the dispatch
// layer, covering every registered command.
//
// What we cover:
//   - Table-driven: iterates every command in HELP_REGISTRY (the single
//     source of truth the guard reads from) and invokes the real `main()`
//     with ["bun","index.ts",<cmd>,"--help"]. Each must return exit code 0
//     and print non-empty usage text.
//   - The internal commands (sidecar, orch-recycle-watch,
//     sidecar-liveness-watch, orch-budget) are covered by the same table.
//     `cam sidecar` in particular spawns a long-lived daemon loop when its
//     body runs — the test returning promptly (bun's default test timeout
//     would otherwise trip) is itself the evidence the guard fired before
//     the switch body, never reaching runSidecar().
//   - isHelpRequested (the guard's own decision function) is unit-tested
//     directly for the `cam claude` forwarding carve-out (US-001 AC5): a
//     leading --help is captured, a non-leading --help is not (so it keeps
//     flowing to parseClaudeArgs's verbatim-forwarding contract).

import { describe, expect, test } from 'bun:test';

import { main, HELP_REGISTRY, isHelpRequested } from '../index.ts';
import { parseClaudeArgs } from '../src/commands/claude.ts';

function captureStdout(): { restore: () => void; written: () => string } {
	const original = process.stdout.write.bind(process.stdout);
	const chunks: string[] = [];
	process.stdout.write = ((chunk: string | Uint8Array) => {
		chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
		return true;
	}) as typeof process.stdout.write;
	return {
		restore: () => {
			process.stdout.write = original;
		},
		written: () => chunks.join(''),
	};
}

describe('HELP_REGISTRY (US-001)', () => {
	test('covers every internal command (the CAM-211 footgun surface)', () => {
		const commands = Object.keys(HELP_REGISTRY);
		for (const internal of [
			'sidecar',
			'orch-recycle-watch',
			'sidecar-liveness-watch',
			'orch-budget',
		]) {
			expect(commands).toContain(internal);
		}
	});

	test('every entry is non-empty help text', () => {
		for (const [cmd, text] of Object.entries(HELP_REGISTRY)) {
			expect(text.length).toBeGreaterThan(0);
			expect(cmd.length).toBeGreaterThan(0);
		}
	});
});

describe('central --help/-h guard — table-driven over every registered command', () => {
	for (const [cmd, expectedHelp] of Object.entries(HELP_REGISTRY)) {
		test(`cam ${cmd} --help exits 0 with non-empty usage, before the command body runs`, async () => {
			const cap = captureStdout();
			try {
				const code = await main(['bun', 'index.ts', cmd, '--help']);
				expect(code).toBe(0);
				expect(cap.written().length).toBeGreaterThan(0);
				expect(cap.written()).toBe(expectedHelp);
			} finally {
				cap.restore();
			}
		});
	}
});

describe('`cam claude` arg-forwarding carve-out (US-001 AC5)', () => {
	test('a leading --help is captured by the guard', () => {
		expect(isHelpRequested('claude', ['--help'])).toBe(true);
		expect(isHelpRequested('claude', ['-h'])).toBe(true);
	});

	test('a non-leading --help is NOT captured by the guard (falls through to forwarding)', () => {
		expect(isHelpRequested('claude', ['some-prompt', '--help'])).toBe(false);
		expect(isHelpRequested('claude', ['--model', 'x', '--help'])).toBe(false);
	});

	test('other commands match --help/-h anywhere in tail (unchanged behaviour)', () => {
		expect(isHelpRequested('ship', ['--finalize', '--help'])).toBe(true);
		expect(isHelpRequested('resume', ['--mode', 'reset-prd', '-h'])).toBe(true);
	});

	test('when the guard does not fire, parseClaudeArgs still forwards the trailing --help verbatim', () => {
		expect(isHelpRequested('claude', ['some-prompt', '--help'])).toBe(false);
		expect(parseClaudeArgs(['some-prompt', '--help'])).toEqual({
			help: false,
			forwardedArgs: ['some-prompt', '--help'],
		});
	});

	test('cam claude --help (leading) prints CLAUDE_HELP and exits 0', async () => {
		const cap = captureStdout();
		try {
			const code = await main(['bun', 'index.ts', 'claude', '--help']);
			expect(code).toBe(0);
			expect(cap.written()).toBe(HELP_REGISTRY['claude'] ?? '');
			expect(cap.written().length).toBeGreaterThan(0);
		} finally {
			cap.restore();
		}
	});
});

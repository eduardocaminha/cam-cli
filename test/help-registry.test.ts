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
//     sidecar-liveness-watch, orch-budget, orch-resolve) are covered by the
//     same table.
//     `cam sidecar` in particular spawns a long-lived daemon loop when its
//     body runs — the test returning promptly (bun's default test timeout
//     would otherwise trip) is itself the evidence the guard fired before
//     the switch body, never reaching runSidecar().
//   - isHelpRequested (the guard's own decision function) is unit-tested
//     directly for the `cam claude` forwarding carve-out (US-001 AC5): a
//     leading --help is captured, a non-leading --help is not (so it keeps
//     flowing to parseClaudeArgs's verbatim-forwarding contract).

import { describe, expect, test } from 'bun:test';

import { main, HELP_REGISTRY, isHelpRequested, COMMANDS } from '../index.ts';
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
			'orch-resolve',
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

describe('COMMANDS is the single typed source of truth (US-001, CAM-278)', () => {
	test('COMMANDS matches HELP_REGISTRY keys exactly (no command dropped, no 4th copy)', () => {
		const helpKeys = Object.keys(HELP_REGISTRY).sort();
		const commandsSorted: string[] = [...COMMANDS].sort();
		expect(commandsSorted).toEqual(helpKeys);
	});

	test('COMMANDS matches every `case \'<cmd>\':` label in the dispatch switch', async () => {
		const source = await Bun.file(new URL('../index.ts', import.meta.url)).text();
		const switchStart = source.indexOf('switch (command) {');
		expect(switchStart).toBeGreaterThan(-1);
		const switchBody = source.slice(switchStart);
		const caseLabels = [...switchBody.matchAll(/case '([a-z0-9-]+)':/g)].map((m) => m[1]!);
		expect(caseLabels.length).toBeGreaterThan(0);
		const commandsSorted: string[] = [...COMMANDS].sort();
		expect([...new Set(caseLabels)].sort()).toEqual(commandsSorted);
	});
});

describe('no retired `cam <word>` command survives in any help text (US-R2-001, CAM-460)', () => {
	// US-002's AC1 oracle hand-typed a 12-command list (init config run plan
	// journal patterns suggestions next review ship tag status) that omitted
	// `claude`, so its own guard stayed blind to src/commands/claude.ts and
	// went tautological the moment a command not on the hand-typed list kept
	// printing the retired invocation. This test derives the sweep from
	// `HELP_REGISTRY`'s keys — the same single source of truth the dispatch
	// guard itself reads from (US-001, CAM-278) — so a newly registered
	// command can never again fall outside the swept surface by omission.
	//
	// Boundary mirrors the AC1 oracle exactly: matches a literal `cam `
	// (trailing space) not preceded by a letter/underscore/slash/hyphen, so
	// internal-contract paths that are NOT typed commands (`~/.config/cam/`,
	// `~/.cam/`, `/cam-next` slash commands) are deliberately excluded.
	const RETIRED_COMMAND_RE = /(^|[^a-zA-Z_/-])cam /;

	for (const cmd of Object.keys(HELP_REGISTRY)) {
		test(`\`gship ${cmd} --help\` does not print the retired \`cam ${cmd === 'claude' ? 'claude' : cmd}\` invocation`, async () => {
			const cap = captureStdout();
			try {
				const code = await main(['bun', 'index.ts', cmd, '--help']);
				expect(code).toBe(0);
				expect(cap.written()).not.toMatch(RETIRED_COMMAND_RE);
			} finally {
				cap.restore();
			}
		});
	}

	test('top-level `gship --help` names the new command and does not print the retired one', async () => {
		const cap = captureStdout();
		try {
			const code = await main(['bun', 'index.ts', '--help']);
			expect(code).toBe(0);
			expect(cap.written()).toContain('gship');
			expect(cap.written()).not.toMatch(RETIRED_COMMAND_RE);
		} finally {
			cap.restore();
		}
	});
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

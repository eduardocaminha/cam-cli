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
//     directly for the shared anywhere-in-tail behavior.

import { describe, expect, test } from 'bun:test';

import { main, HELP_REGISTRY, isHelpRequested, COMMANDS } from '../index.ts';

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
	// This test derives the sweep from
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
		test(`\`gship ${cmd} --help\` does not print the retired \`cam ${cmd}\` invocation`, async () => {
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
			expect(cap.written()).toContain('Web-first');
			expect(cap.written()).toContain('Legacy tmux (temporary)');
			expect(cap.written().indexOf('Web-first')).toBeLessThan(
				cap.written().indexOf('Legacy tmux (temporary)'),
			);
		} finally {
			cap.restore();
		}
	});
});

describe('shared help guard', () => {
	test('commands match --help/-h anywhere in tail', () => {
		expect(isHelpRequested('ship', ['--finalize', '--help'])).toBe(true);
		expect(isHelpRequested('resume', ['--mode', 'reset-prd', '-h'])).toBe(true);
	});
});

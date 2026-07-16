// test/init-setup-plan-approval-wiring.test.ts
//
// US-R1-001 (review round 1 finding): `--plan-approval operator` was accepted
// by parseSetupArgs (src/commands/setup.ts) but silently dropped on the floor
// by index.ts — the `case 'init'` and `case 'setup'` dispatch blocks built the
// `runSetup({...})` options object without forwarding `setupArgs.planApproval`,
// so `options.planApproval` was always `undefined`, the interactive prompt
// fired, read EOF from a piped/empty stdin, and defaulted to `'auto'`. The
// build-release.sh hermetic smoke (CAM-... build-release-smoke.test.ts) only
// guards the *shell script's* argv; it never proved the flag actually reaches
// `runSetup`, so the wiring gap shipped invisibly.
//
// Two-layer defense, mirroring test/no-permission-mode-flag.test.ts:
//   1. Behavioral — parseSetupArgs actually parses `--plan-approval operator`
//      into `{ planApproval: 'operator' }` (the upstream half of the pipe).
//   2. Textual (smoke) — scan index.ts and assert both `runSetup({...})` call
//      sites (init + setup) forward `planApproval: setupArgs.planApproval`.
//      Running the compiled/interpreted CLI end-to-end here would require a
//      real `claude` install (verifyAgent gates before the prompt), which is
//      not guaranteed in CI — the textual scan is the deterministic proxy.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseSetupArgs } from '../src/commands/setup.ts';

describe('parseSetupArgs --plan-approval flag (behavioral)', () => {
	test('parses `--plan-approval operator` into planApproval', () => {
		const result = parseSetupArgs(['--plan-approval', 'operator', '--no-tmux']);
		expect(result).not.toBeNull();
		expect(result?.planApproval).toBe('operator');
	});

	test('parses `--plan-approval=auto` (joined form) into planApproval', () => {
		const result = parseSetupArgs(['--plan-approval=auto']);
		expect(result).not.toBeNull();
		expect(result?.planApproval).toBe('auto');
	});

	test('rejects an invalid --plan-approval value', () => {
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		try {
			expect(parseSetupArgs(['--plan-approval', 'bogus'])).toBeNull();
		} finally {
			process.stderr.write = original;
		}
	});

	test('planApproval is undefined when the flag is absent (falls through to prompt/default)', () => {
		const result = parseSetupArgs(['--no-tmux']);
		expect(result).not.toBeNull();
		expect(result?.planApproval).toBeUndefined();
	});
});

describe('index.ts forwards setupArgs.planApproval into runSetup (textual smoke)', () => {
	test('both `case \'init\'` and `case \'setup\'` runSetup calls include planApproval', () => {
		const indexPath = resolve(import.meta.dir, '..', 'index.ts');
		const source = readFileSync(indexPath, 'utf8');

		// Each dispatch block's runSetup({...}) call must forward the field —
		// match on the exact assignment the fix introduces. `match` with the
		// `g` flag counts occurrences without needing to isolate each switch
		// arm's source span.
		const matches = source.match(/planApproval:\s*setupArgs\.planApproval/g) ?? [];
		expect(matches.length).toBe(2);
	});
});

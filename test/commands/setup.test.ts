// test/commands/setup.test.ts
//
// Oracle tests for US-007: plan_approval + Resend loud warning in setup.
//
// AC4: When plan_approval is "auto" and Resend is unconfigured, init/config
//      WARN LOUDLY that non-convergence failures are silent.
//
// Tests call the exported warnIfResendUnconfigured helper directly so no
// real claude binary or tmux is needed (avoids requires:operator).

import { describe, expect, test } from 'bun:test';
import { warnIfResendUnconfigured } from '../../src/commands/setup.ts';

describe('warnIfResendUnconfigured (AC4)', () => {
	test('emits loud warning when plan_approval=auto and resendApiKey is empty', () => {
		const warnings: string[] = [];
		warnIfResendUnconfigured('auto', '', (msg) => warnings.push(msg));

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('non-convergence');
		expect(warnings[0]).toContain('SILENT');
		expect(warnings[0]).toContain('plan_approval');
	});

	test('warning message mentions Resend (escalation context)', () => {
		const warnings: string[] = [];
		warnIfResendUnconfigured('auto', '', (msg) => warnings.push(msg));

		// The warning string must reference "Resend" so the operator knows
		// which service to configure.
		expect(warnings[0]).toContain('Resend');
	});

	test('does NOT warn when plan_approval=operator (escalation not expected)', () => {
		const warnings: string[] = [];
		warnIfResendUnconfigured('operator', '', (msg) => warnings.push(msg));

		expect(warnings).toHaveLength(0);
	});

	test('does NOT warn when resendApiKey is set (Resend configured)', () => {
		const warnings: string[] = [];
		warnIfResendUnconfigured('auto', 're_test_key_12345', (msg) => warnings.push(msg));

		expect(warnings).toHaveLength(0);
	});

	test('does NOT warn when both planApproval=operator and resendApiKey set', () => {
		const warnings: string[] = [];
		warnIfResendUnconfigured('operator', 're_test_key', (msg) => warnings.push(msg));

		expect(warnings).toHaveLength(0);
	});

	test('hint is emitted as second arg to warnFn', () => {
		const calls: Array<{ msg: string; hint?: string }> = [];
		warnIfResendUnconfigured('auto', '', (msg, hint) => calls.push({ msg, hint }));

		expect(calls).toHaveLength(1);
		expect(calls[0]?.hint).toBeDefined();
		expect(calls[0]?.hint).toContain('RESEND_API_KEY');
	});

	test('env-var-only path: auto+unconfigured loud warning fires when key is empty (--resend-api-key flag removed)', () => {
		// setup.ts now derives the key as: process.env['RESEND_API_KEY'] ?? ''
		// When RESEND_API_KEY is absent (the common case), key is ''.
		// Assert the loud warning still fires so flag removal does not silently
		// suppress the non-convergence safety signal.
		const resendApiKey = ''; // simulates absent RESEND_API_KEY env var
		const warnings: string[] = [];
		warnIfResendUnconfigured('auto', resendApiKey, (msg) => warnings.push(msg));

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('non-convergence');
		expect(warnings[0]).toContain('SILENT');
	});
});

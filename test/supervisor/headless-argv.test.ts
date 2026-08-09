// test/supervisor/headless-argv.test.ts
//
// Unit tests for src/supervisor/headless-argv.ts.
//
// Coverage:
//   1. buildHeadlessChildInvocation returns an argv ARRAY carrying the
//      required flags, and never --resume / --include-partial-messages /
//      --bare.
//   2. `env policy`: WORKER_ENV_UNSET, HOST_ONLY_ENV_UNSET
//      (CLAUDE_CODE_OAUTH_TOKEN), and ANTHROPIC_API_KEY are all stripped
//      from the returned env, while unrelated vars survive.

import { describe, expect, test } from 'bun:test';
import { HOST_ONLY_ENV_UNSET, WORKER_ENV_UNSET } from '../../src/supervisor/backend-adapter.ts';
import { buildHeadlessChildInvocation } from '../../src/supervisor/headless-argv.ts';

describe('buildHeadlessChildInvocation', () => {
	test('argv is an array, not a shell string', () => {
		const { argv } = buildHeadlessChildInvocation({ sourceEnv: {} });
		expect(Array.isArray(argv)).toBe(true);
	});

	test('contains --print', () => {
		const { argv } = buildHeadlessChildInvocation({ sourceEnv: {} });
		expect(argv).toContain('--print');
	});

	test('contains --input-format stream-json', () => {
		const { argv } = buildHeadlessChildInvocation({ sourceEnv: {} });
		const idx = argv.indexOf('--input-format');
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(argv[idx + 1]).toBe('stream-json');
	});

	test('contains --output-format stream-json', () => {
		const { argv } = buildHeadlessChildInvocation({ sourceEnv: {} });
		const idx = argv.indexOf('--output-format');
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(argv[idx + 1]).toBe('stream-json');
	});

	test('contains --verbose', () => {
		const { argv } = buildHeadlessChildInvocation({ sourceEnv: {} });
		expect(argv).toContain('--verbose');
	});

	test('does NOT contain --resume', () => {
		const { argv } = buildHeadlessChildInvocation({ sourceEnv: {} });
		expect(argv).not.toContain('--resume');
	});

	test('does NOT contain --include-partial-messages', () => {
		const { argv } = buildHeadlessChildInvocation({ sourceEnv: {} });
		expect(argv).not.toContain('--include-partial-messages');
	});

	test('does NOT contain --bare', () => {
		const { argv } = buildHeadlessChildInvocation({ sourceEnv: {} });
		expect(argv).not.toContain('--bare');
	});

	test('appends --model when a model is supplied', () => {
		const { argv } = buildHeadlessChildInvocation({ sourceEnv: {}, model: 'sonnet' });
		const idx = argv.indexOf('--model');
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(argv[idx + 1]).toBe('sonnet');
	});

	test('omits --model when no model is supplied', () => {
		const { argv } = buildHeadlessChildInvocation({ sourceEnv: {} });
		expect(argv).not.toContain('--model');
	});

	test('env policy', () => {
		const sourceEnv: Record<string, string | undefined> = { PATH: '/usr/bin', HOME: '/home/op' };
		for (const key of WORKER_ENV_UNSET) {
			sourceEnv[key] = 'set-by-parent';
		}
		for (const key of HOST_ONLY_ENV_UNSET) {
			sourceEnv[key] = 'set-by-parent';
		}
		sourceEnv.ANTHROPIC_API_KEY = 'sk-ant-set-by-operator-shell';

		const { env } = buildHeadlessChildInvocation({ sourceEnv });

		for (const key of WORKER_ENV_UNSET) {
			expect(env[key]).toBeUndefined();
		}
		for (const key of HOST_ONLY_ENV_UNSET) {
			expect(env[key]).toBeUndefined();
		}
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();

		// Unrelated vars survive the strip.
		expect(env.PATH).toBe('/usr/bin');
		expect(env.HOME).toBe('/home/op');
	});

	test('env policy does not mutate the source env', () => {
		const sourceEnv: Record<string, string | undefined> = { ANTHROPIC_API_KEY: 'sk-ant-untouched' };
		buildHeadlessChildInvocation({ sourceEnv });
		expect(sourceEnv.ANTHROPIC_API_KEY).toBe('sk-ant-untouched');
	});
});

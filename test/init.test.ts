import { describe, expect, test } from 'bun:test';

import { runInit, type SpawnFn } from '../src/commands/init.ts';

function capture(stream: 'stdout' | 'stderr'): { restore: () => void; text: () => string } {
	const target = process[stream];
	const original = target.write.bind(target);
	const chunks: string[] = [];
	target.write = ((chunk: string | Uint8Array) => {
		chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
		return true;
	}) as typeof target.write;
	return {
		restore: () => { target.write = original; },
		text: () => chunks.join(''),
	};
}

describe('runInit', () => {
	test('fails clearly when Claude Code is not on PATH', async () => {
		const stderr = capture('stderr');
		const spawnFn: SpawnFn = () => ({ status: 1, stdout: '', stderr: '' });
		try {
			expect(await runInit({ spawnFn })).toBe(1);
			expect(stderr.text()).toContain('Claude Code is not on PATH');
		} finally {
			stderr.restore();
		}
	});

	test('reports the detected CLI path and version', async () => {
		const stdout = capture('stdout');
		const calls: Array<[string, string[]]> = [];
		const spawnFn: SpawnFn = (command, args) => {
			calls.push([command, args]);
			if (command === '/bin/sh') return { status: 0, stdout: '/opt/bin/claude\n', stderr: '' };
			return { status: 0, stdout: '2.4.1 (Claude Code)\n', stderr: '' };
		};
		try {
			expect(await runInit({ spawnFn })).toBe(0);
			expect(calls).toEqual([
				['/bin/sh', ['-c', 'command -v claude']],
				['claude', ['--version']],
			]);
			expect(stdout.text()).toContain('Claude Code 2.4.1 found at /opt/bin/claude');
		} finally {
			stdout.restore();
		}
	});
});

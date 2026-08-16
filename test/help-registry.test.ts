import { describe, expect, test } from 'bun:test';

import { main } from '../index.ts';

function captureStdout(): { restore: () => void; text: () => string } {
	const original = process.stdout.write.bind(process.stdout);
	const chunks: string[] = [];
	process.stdout.write = ((chunk: string | Uint8Array) => {
		chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
		return true;
	}) as typeof process.stdout.write;
	return {
		restore: () => { process.stdout.write = original; },
		text: () => chunks.join(''),
	};
}

describe('current CLI help surface', () => {
	test('top-level help describes the web-first CLI only', async () => {
		const capture = captureStdout();
		try {
			expect(await main(['bun', 'index.ts', '--help'])).toBe(0);
			expect(capture.text()).toContain('gship');
			expect(capture.text()).toContain('gship [--port N]');
			expect(capture.text()).toContain('--port <N>');
			expect(capture.text()).not.toContain('gship web');
			expect(capture.text()).not.toContain('gship run');
			expect(capture.text()).not.toContain('gship init');
			expect(capture.text()).not.toContain('sidecar');
			expect(capture.text()).not.toContain('tmux');
			expect(capture.text()).not.toMatch(/(^|[^a-zA-Z_/-])cam /);
		} finally {
			capture.restore();
		}
	});

	test('the retired subcommands are no longer accepted', async () => {
		for (const command of ['web', 'run', 'init']) {
			expect(await main(['bun', 'index.ts', command])).toBe(1);
		}
	});
});

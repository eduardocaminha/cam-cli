import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';

const README_PATH = fileURLToPath(new URL('../README.md', import.meta.url));

test('architecture documents the distinct tmux and headless worker paths', () => {
	const readme = readFileSync(README_PATH, 'utf8');

	expect(readme).not.toContain('Workers always run in the **titled 3rd pane**');
	expect(readme).toContain('The default tmux path runs workers in the **titled 3rd pane**');
	expect(readme).toContain('The headless implementer path runs `claude --print` as a direct child process');
	expect(readme).toContain('serialized by the supervisor lock');
});

test('documents cam next CLI gates separately from sidecar headless dispatch constraints', () => {
	const readme = readFileSync(README_PATH, 'utf8');

	expect(readme).not.toContain('no session detection, no idle check, no send-keys');
	expect(readme).not.toContain('direct child, no pane or pane-count mutex');
	expect(readme).toMatch(/The CLI trigger first detects or\s+bootstraps a live orchestrator session/);
	expect(readme).toMatch(/refuses while the three-pane mutex\s+reports a worker already running/);
	expect(readme).toMatch(/Only the sidecar's later implementer dispatch\s+changes mode/);
	expect(readme).toContain('`worker_isolation = "host"`');
	expect(readme).toContain('`[backend] implementer = "claude"`');
});

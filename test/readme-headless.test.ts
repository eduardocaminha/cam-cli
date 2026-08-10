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

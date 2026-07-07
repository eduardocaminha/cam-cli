// Fixture (guard negative case): a real-tmux/git capability probe (CAM-59
// convention) is NOT a toolchain version and must stay legal.
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

const tmuxAvailable = spawnSync('tmux', ['-V'], { stdio: 'pipe' }).status === 0;

test.skipIf(!tmuxAvailable)('real-tmux integration', () => {
	expect(1).toBe(1);
});

import { spawnSync } from 'node:child_process';

export const gitAvailable = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;

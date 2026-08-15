import process from 'node:process';

export interface OwnedProcess {
	pid: number;
	exited: Promise<number>;
	kill: (signal?: number | NodeJS.Signals) => void;
}

export function signalProcessGroup(
	child: OwnedProcess,
	signal: 'SIGTERM' | 'SIGKILL',
): void {
	if (process.platform !== 'win32' && child.pid > 0) {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {
			// Fall back when the platform did not create a process group.
		}
	}
	try {
		child.kill(signal);
	} catch {
		// The child exited between the liveness observation and signal delivery.
	}
}

export async function terminateProcessGroup(
	child: OwnedProcess,
	graceMs: number,
): Promise<void> {
	signalProcessGroup(child, 'SIGTERM');
	let timer: ReturnType<typeof setTimeout> | undefined;
	const outcome = await Promise.race([
		child.exited.then(() => 'exited' as const),
		new Promise<'grace-expired'>((resolve) => {
			timer = setTimeout(() => resolve('grace-expired'), graceMs);
		}),
	]);
	if (timer !== undefined) clearTimeout(timer);
	if (outcome === 'grace-expired') {
		signalProcessGroup(child, 'SIGKILL');
		await child.exited;
	}
}

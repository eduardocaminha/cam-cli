// test/integration/sendkeys-submit.test.ts
//
// Integration test (REAL tmux): proves the send-keys form used to push into the
// orchestrator pane (CAM-55 thin-proxy dispatch + worker exit-report) actually
// SUBMITS, not merely that the argv has the right shape.
//
// This is the exact gap that let the CAM-55 `-l ... Enter` bug ship past 898
// unit tests (memory: sendkeys-literal-enter-gotcha). With `-l`, tmux makes
// EVERY argument literal, so "Enter" is typed as the text "Enter" and the line
// never submits. Argv-shape assertions cannot catch that — only a real tmux
// round-trip can. Skips when tmux is unavailable (e.g. minimal CI).

import { test, expect } from "bun:test";
import { waitForCondition } from "../helpers/wait-for-condition.ts";

const SOCK = "cam-it-sendkeys";
const PAYLOAD = "[cam] US-001 DONE: typecheck ok, 5 pass / 0 fail";

// Use try-catch so the probe returns false gracefully when tmux is absent
// instead of throwing ENOENT (Bun.spawnSync throws on missing binary).
const tmuxAvailable = (() => {
	try {
		return Bun.spawnSync(["tmux", "-V"]).exitCode === 0;
	} catch {
		return false;
	}
})();

function tmux(args: string[]): string {
	return Bun.spawnSync(["tmux", "-L", SOCK, ...args]).stdout.toString();
}

async function bootCatPane(): Promise<void> {
	Bun.spawnSync(["tmux", "-L", SOCK, "kill-server"]);
	tmux(["new-session", "-d", "-s", "t", "-x", "80", "-y", "10", "cat"]);
	await waitForCondition(() => Bun.spawnSync(["tmux", "-L", SOCK, "has-session", "-t", "t"]).exitCode === 0);
}

test.skipIf(!tmuxAvailable)(
	"send-keys <text> Enter (no -l) SUBMITS — cat echoes the line back",
	async () => {
		await bootCatPane();
		// The shape produced by dispatch.ts and buildWorkerReportSendKeysArgv: NO -l.
		tmux(["send-keys", "-t", "t", PAYLOAD, "Enter"]);
		// A submitted line is echoed back by cat, so the payload appears twice
		// (typed + echoed on the newline) once the pane has actually rendered it.
		await waitForCondition(() => tmux(["capture-pane", "-t", "t", "-p"]).split(PAYLOAD).length - 1 >= 2);
		const out = tmux(["capture-pane", "-t", "t", "-p"]);
		Bun.spawnSync(["tmux", "-L", SOCK, "kill-server"]);
		const occurrences = out.split(PAYLOAD).length - 1;
		expect(occurrences).toBeGreaterThanOrEqual(2);
		expect(out).not.toContain(`${PAYLOAD}Enter`);
	},
);

test.skipIf(!tmuxAvailable)(
	"send-keys -l <text> Enter (the CAM-55 bug) does NOT submit — 'Enter' lands as literal text",
	async () => {
		await bootCatPane();
		// The buggy shape: -l makes "Enter" literal.
		tmux(["send-keys", "-t", "t", "-l", PAYLOAD, "Enter"]);
		// With -l the pane shows "<payload>Enter" verbatim and cat never gets a
		// newline (no echoed-back line). Poll for that literal rendering rather
		// than a fixed settle time.
		await waitForCondition(() => tmux(["capture-pane", "-t", "t", "-p"]).includes(`${PAYLOAD}Enter`));
		const out = tmux(["capture-pane", "-t", "t", "-p"]);
		Bun.spawnSync(["tmux", "-L", SOCK, "kill-server"]);
		// This is what shipped and broke dispatch.
		expect(out).toContain(`${PAYLOAD}Enter`);
	},
);

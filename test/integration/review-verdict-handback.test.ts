// test/integration/review-verdict-handback.test.ts
//
// Integration test (REAL tmux): proves the end-to-end reviewer verdict
// handback path: a CLEAN/FIXES_PENDING/MAX_ROUNDS_DEBT verdict line emitted
// by the production makeNotifyOrchestrator closure (US-002) actually lands
// in the orchestrator pane's capture-pane output.
//
// Motivation (memory: sendkeys-literal-enter-gotcha, CAM-55): unit fakes
// that encode idealised tmux output cannot catch real tmux behavior bugs.
// This test closes the same gap for the reviewer-verdict pathway that
// test/integration/sendkeys-submit.test.ts closed for thin-proxy dispatch.
//
// Isolation: makeNotifyOrchestrator injects a swapSocketSpawn that rewrites
// the socket from `-L cam` to the private test socket so calls NEVER touch
// a live `cam run` session. Skips when tmux is unavailable.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";

import { makeNotifyOrchestrator } from "../../src/supervisor/host.ts";
import { formatReviewVerdictLine } from "../../src/supervisor/worker-report.ts";
import type { SpawnFn } from "../../src/tmux/session.ts";

const TEST_SOCK = "cam-it-verdict";
const SESSION = "cam-it-verdict";

// AC3 oracle: exact literals required.
// Use node:child_process.spawnSync (not Bun.spawnSync) so the probe returns
// status:null gracefully when tmux is absent instead of throwing ENOENT.
const tmuxAvailable = spawnSync("tmux", ["-V"], { stdio: "pipe" }).status === 0;

/** Run tmux on the private test socket (setup/teardown helper). */
function tmuxRaw(args: string[]): ReturnType<typeof spawnSync> {
	return spawnSync("tmux", ["-L", TEST_SOCK, ...args], { stdio: "pipe" });
}

/**
 * SpawnFn passed to makeNotifyOrchestrator. Rewrites `-L cam` to the private
 * test socket so all production tmux calls hit the isolated test session.
 * Identical swap pattern to test/integration/tmux-introspect.test.ts.
 */
const swapSocketSpawn: SpawnFn = (cmd, args, opts) => {
	const swapped = [...args];
	const lIdx = swapped.indexOf("-L");
	if (lIdx !== -1 && swapped[lIdx + 1] === "cam") swapped[lIdx + 1] = TEST_SOCK;
	return spawnSync(cmd, swapped, { stdio: opts?.stdio ?? "ignore" }) as ReturnType<SpawnFn>;
};

beforeEach(() => {
	if (!tmuxAvailable) return;
	tmuxRaw(["kill-server"]);
});

afterEach(() => {
	if (!tmuxAvailable) return;
	tmuxRaw(["kill-server"]);
});

test.skipIf(!tmuxAvailable)(
	"makeNotifyOrchestrator: CLEAN verdict line lands in orchestrator pane capture-pane output",
	() => {
		// Boot an isolated tmux session with a cat pane (echoes key input back).
		tmuxRaw(["new-session", "-d", "-s", SESSION, "-x", "80", "-y", "10", "cat"]);
		Bun.sleepSync(200);

		// Label pane 0 as orchestrator (mirrors how cam run labels panes).
		tmuxRaw(["set-option", "-p", "-t", `${SESSION}.0`, "@cam_label", "orchestrator"]);
		Bun.sleepSync(100);

		// Build the production closure under test.
		const notify = makeNotifyOrchestrator(SESSION, swapSocketSpawn);

		// Emit a verdict line — production loop calls formatReviewVerdictLine then
		// passes the result to notifyOrchestrator.
		const verdictLine = formatReviewVerdictLine(1, "CLEAN");
		notify(verdictLine);

		// Give tmux time to process the send-keys call.
		Bun.sleepSync(300);

		// Assert the verdict line is observable in the pane via capture-pane.
		const out =
			tmuxRaw(["capture-pane", "-t", `${SESSION}.0`, "-p"]).stdout?.toString() ?? "";
		expect(out).toContain(verdictLine);
	},
);

test.skipIf(!tmuxAvailable)(
	"makeNotifyOrchestrator: FIXES_PENDING:K verdict line lands in orchestrator pane",
	() => {
		tmuxRaw(["new-session", "-d", "-s", SESSION, "-x", "80", "-y", "10", "cat"]);
		Bun.sleepSync(200);

		tmuxRaw(["set-option", "-p", "-t", `${SESSION}.0`, "@cam_label", "orchestrator"]);
		Bun.sleepSync(100);

		const notify = makeNotifyOrchestrator(SESSION, swapSocketSpawn);
		const verdictLine = formatReviewVerdictLine(2, "FIXES_PENDING:3");
		notify(verdictLine);
		Bun.sleepSync(300);

		const out =
			tmuxRaw(["capture-pane", "-t", `${SESSION}.0`, "-p"]).stdout?.toString() ?? "";
		expect(out).toContain(verdictLine);
	},
);

test.skipIf(!tmuxAvailable)(
	"makeNotifyOrchestrator: MAX_ROUNDS_DEBT verdict line lands in orchestrator pane",
	() => {
		tmuxRaw(["new-session", "-d", "-s", SESSION, "-x", "80", "-y", "10", "cat"]);
		Bun.sleepSync(200);

		tmuxRaw(["set-option", "-p", "-t", `${SESSION}.0`, "@cam_label", "orchestrator"]);
		Bun.sleepSync(100);

		const notify = makeNotifyOrchestrator(SESSION, swapSocketSpawn);
		const verdictLine = formatReviewVerdictLine(4, "MAX_ROUNDS_DEBT");
		notify(verdictLine);
		Bun.sleepSync(300);

		const out =
			tmuxRaw(["capture-pane", "-t", `${SESSION}.0`, "-p"]).stdout?.toString() ?? "";
		expect(out).toContain(verdictLine);
	},
);

test.skipIf(!tmuxAvailable)(
	"makeNotifyOrchestrator: silent no-op when orchestrator pane is absent (no session)",
	() => {
		// No session created — getOrchPaneId returns null, closure should not throw.
		const notify = makeNotifyOrchestrator(SESSION, swapSocketSpawn);
		expect(() => notify(formatReviewVerdictLine(1, "CLEAN"))).not.toThrow();
	},
);

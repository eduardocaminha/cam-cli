import { test, expect } from "bun:test";
import { templatesContents } from "../../src/vendor/_generated";

// Regression guard: the embedded cam-ship.md text (written into user
// projects by `cam init`) stays a thin phase-signal stub (CAM-149 US-006).
// The ship control-flow (PRD gate, quality gates, bump, finalize, push,
// PR-create, merge-mode branching) lives in runShipPhase/runShipPrStep
// (src/supervisor/ship-runner.ts, src/release/ship-pr.ts), never as
// step-by-step gh/jq/git prose here. See docs/adr/0009.

const SHIP_KEY = "commands/cam-ship.md";

test("embedded cam-ship.md does not contain gh pr create instructions", () => {
	const content = templatesContents[SHIP_KEY];
	expect(content).toBeDefined();
	expect(content).not.toContain("gh pr create");
});

test("embedded cam-ship.md does not contain the masked-atomic git rm pattern", () => {
	const content = templatesContents[SHIP_KEY];
	expect(content).toBeDefined();
	expect(content).not.toContain(
		"git rm -q scripts/cam/prd.json scripts/cam/handoff.json scripts/cam/progress.txt 2>/dev/null || true",
	);
});

test("embedded cam-ship.md does not contain raw gh merge/close instructions", () => {
	const content = templatesContents[SHIP_KEY];
	expect(content).toBeDefined();
	expect(content).not.toContain("gh pr merge --auto --squash");
	expect(content).not.toContain("gh issue close");
	expect(content).not.toContain("gh pr view --json number");
});

test("embedded cam-ship.md writes phase: shipping as the signal", () => {
	const content = templatesContents[SHIP_KEY];
	expect(content).toBeDefined();
	expect(content).toContain("phase: shipping");
});

test("embedded cam-ship.md references the deterministic runShipPhase runner", () => {
	const content = templatesContents[SHIP_KEY];
	expect(content).toBeDefined();
	expect(content).toContain("runShipPhase");
});

test("embedded cam-ship.md describes both the CLI path and the slash-command path", () => {
	const content = templatesContents[SHIP_KEY];
	expect(content).toBeDefined();
	expect(content).toContain("CLI path");
	expect(content).toContain("Slash-command path");
});

test("embedded cam-ship.md cross-references ADR 0009", () => {
	const content = templatesContents[SHIP_KEY];
	expect(content).toBeDefined();
	expect(content).toContain("0009-ship-phase-deterministic-sidecar-runner.md");
});

test("embedded cam-ship.md keeps the cam-init aggregate-gate adaptation note", () => {
	const content = templatesContents[SHIP_KEY];
	expect(content).toBeDefined();
	expect(content).toContain("cam-init: adaptation point");
	expect(content).toContain("bun run check:all");
});

// index.ts
//
// cam CLI entrypoint. Dispatches subcommands by argv[2]; everything else is
// implemented in `src/commands/<name>.ts`. We deliberately avoid pulling in
// `commander` / `yargs` for the current CLI surface — argv parsing fits
// inline, and a third-party arg parser would be the largest single dep in
// the project. As more subcommands with more options land we will revisit
// (this point gets re-evaluated each story; US-007 still fits inline because
// only `next` adds two more options, both with simple value parsing).
//
// IMPORTANT INVARIANT (US-007 acceptance criterion 7):
//   No subcommand parser registers a `--permission-mode` flag. The value is
//   sourced exclusively from `~/.config/cam/config.toml` via
//   `src/config/permission-mode.ts`. The unit test
//   `test/no-permission-mode-flag.test.ts` greps this file (and every file
//   in `src/commands/`) for `--permission-mode` patterns and fails the build
//   on a registration. Search markers documented in that test.

import process from 'node:process';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { runDashboardInk } from './src/commands/dashboard.ts';
import { runInit } from './src/commands/init.ts';
import {
	createLocalIssueOnMain,
	type CreateLocalIssueOnMainOptions,
	type CreateLocalIssueOnMainOutcome,
} from './src/commands/issue-file.ts';
import {
	appendJournalEntryOnMain,
	recordCycleTokens,
	type JournalCycleEntry,
	type AppendJournalEntryOnMainResult,
} from './src/commands/journal.ts';
import {
	archiveJournalOnMain,
	DEFAULT_THRESHOLD as JOURNAL_ARCHIVE_DEFAULT_THRESHOLD,
	type ArchiveJournalOnMainResult,
} from './src/commands/journal-archive.ts';
import {
	archivePatternsOnMain,
	type ArchivePatternsOnMainResult,
} from './src/commands/patterns-archive.ts';
import { runIssue } from './src/commands/issue.ts';
import { runIssueList } from './src/commands/issue-list.ts';
import type {
	CloseIssueOnMainOutcome,
	AbandonIssueOnMainOutcome,
	DemoteIssueOnMainOutcome,
} from './src/commands/issue-specify.ts';
import {
	defaultCloseIssueFn,
	defaultAbandonIssueFn,
	defaultDemoteIssueFn,
} from './src/release/post-merge.ts';
import { runNext } from './src/commands/next.ts';
import { runSetup, parseSetupArgs } from './src/commands/setup.ts';
import { runPlan } from './src/commands/plan.ts';
import { runSpec, runSpecWriteDocs, runSpecPersist } from './src/commands/spec.ts';
import { runReview } from './src/commands/review.ts';
import { runShip } from './src/commands/ship.ts';
import {
	finalizeCycleClose,
	type FinalizeCycleCloseResult,
} from './src/commands/ship-finalize.ts';
import { buildShipFinalizeOpts, buildShipBumpOpts } from './src/commands/ship-deps.ts';
import { runShipBump, type ShipBumpResult } from './src/release/ship-bump.ts';
import { runResume, type ExplicitMode } from './src/commands/resume.ts';
import { runRun, parseRunArgs } from './src/commands/run.ts';
import { runStatus } from './src/commands/status.ts';
import { runOrchBudget } from './src/commands/orch-budget.ts';
import { runStop } from './src/commands/stop.ts';
import { runDrain, parseDrainArgs } from './src/commands/drain.ts';
import { runClaude, parseClaudeArgs, CLAUDE_HELP } from './src/commands/claude.ts';
import { runConfig } from './src/commands/config.ts';
import { runRetryMonitor, parseRetryMonitorArgs, RETRY_MONITOR_HELP } from './src/commands/retry-monitor.ts';
import { runSidecar } from './src/commands/sidecar.ts';
import { runOrchRecycleWatch } from './src/commands/orch-recycle-watch.ts';
import { runSidecarLivenessWatch } from './src/commands/sidecar-liveness-watch.ts';
import { runTag } from './src/commands/tag.ts';
import { ORCH_RECYCLE_MARKER } from './src/tmux/session.ts';
import { watcherAlive } from './src/supervisor/sidecar-pid.ts';
import { runTriage, type TriageResult } from './src/commands/triage.ts';
import { realOnMainSpawnFn } from './src/git/on-main.ts';
import {
	readSuggestionsFromMain,
	promoteSuggestionOnMain,
	dismissSuggestionOnMain,
	type SuggestionEntry,
	type PromoteSuggestionOnMainResult,
	type DismissSuggestionOnMainResult,
} from './src/commands/suggestions.ts';
import type { WsjfScore } from './src/issues/types.ts';
import { printError, printFatalHint, printHint, printWarning } from './src/logging/color.ts';
import { renderHelp } from './src/logging/help.ts';
import { CAM_VERSION } from './src/version.ts';

const HELP = renderHelp({
	title: 'cam',
	tagline: 'Autonomous Claude Code loop driver',
	usage: 'cam <command> [options]',
	sections: [
		{
			heading: 'Commands',
			entries: [
				{ name: 'init [options]', description: 'Validate the machine, then run the project-setup wizard' },
				{ name: 'config [--show]', description: 'Interactive wizard to set model per phase and backend' },
				{ name: 'run [options]', description: 'Open or attach the long-lived orchestrator (tmux session)' },
				{ name: 'plan [<N>]', description: 'Spawn claude + dispatch /cam-plan; APPROVE happens inside the pane' },
				{ name: 'spec <id>', description: 'Deep-spec an idea (stage:idea) into stage:specified via grill-with-docs interview' },
				{ name: 'next [options]', description: 'Trigger the sidecar loop (flips active:true, thin-proxy)' },
				{ name: 'review', description: 'Dispatch /cam-review to the live orchestrator (or bootstrap first)' },
				{ name: 'ship', description: 'Dispatch /cam-ship to the live orchestrator (or bootstrap first)' },
				{ name: 'tag', description: 'Create and push the vX.Y.Z git tag for the current CAM_VERSION on main' },
				{ name: 'issue "<text>"', description: 'File an issue from free text; opens /cam-issue create in a pane' },
				{ name: 'journal append [--force]', description: 'Append a structured cycle entry to scripts/cam/journal.md on main (reads JSON from stdin)' },
				{ name: 'journal archive [--threshold N]', description: 'Move the oldest third of scripts/cam/journal.md entries to journal.archive.md on main once entries exceed the threshold (default 50)' },
				{ name: 'patterns archive', description: 'Move resolved-marked bullets (`[resolved YYYY-MM]`) from scripts/cam/patterns.md to patterns.archive.md on main' },
				{ name: 'claude [args...]', description: 'Run claude in print mode with auto-retry on rate limits' },
				{ name: 'dashboard', description: 'Standalone read-only TUI (alt-screen) for monitoring a loop' },
				{ name: 'status', description: 'Show current loop state at a glance (idle / active / paused)' },
				{ name: 'stop', description: 'Cancel a running loop (clears state file + kills the per-project tmux session)' },
				{ name: 'drain [--stop|--clear]', description: 'Set or clear the inter-cycle drain kill-switch without killing the sidecar' },
				{ name: 'resume [options]', description: 'Reconcile loop state after interrupt; auto-detect or --mode <name>' },
				{ name: 'version', description: 'Print the installed cam-cli version (also `--version` / `-v`)' },
				{ name: 'help', description: 'Show this help' },
			],
		},
		{
			heading: 'Internal',
			entries: [
				{
					name: 'sidecar',
					description: 'Not a user entry point: the long-lived loop supervisor, spawned by `cam run` in the background',
				},
				{
					name: 'orch-recycle-watch',
					description: 'Not a user entry point: watches the recycle marker and kills the orchestrator pane, spawned by `cam run`',
				},
				{
					name: 'sidecar-liveness-watch',
					description: 'Not a user entry point: restarts a dead sidecar, spawned by `cam run`',
				},
				{
					name: 'orch-budget',
					description: 'Not a user entry point: prints/enforces the orchestrator token budget, spawned by `cam run`',
				},
			],
		},
	],
	footer:
		'Run `cam <command> --help` for command-specific options. Permission mode\n' +
		'for spawned claude sessions is read from `~/.config/cam/config.toml` —\n' +
		'no subcommand exposes a CLI flag for it (run `cam init` to set).',
});

const INIT_HELP = renderHelp({
	title: 'cam init',
	tagline: 'Validate the machine and set up the project for the cam loop',
	usage: 'cam init [options]',
	sections: [
		{
			heading: 'Options',
			entries: [
				{ name: '--new', description: 'Treat this as a new project (skip the new/existing question)' },
				{ name: '--existing', description: 'Treat this as an existing project' },
				{ name: '--issue-system <x>', description: 'linear | github | local. Skip the issue-system question' },
				{ name: '--description "<t>"', description: 'Project description for new projects (skip the prompt)' },
				{ name: '--no-tmux', description: 'Install templates only; skip spawning the tmux setup session' },
			],
		},
		{
			heading: 'Behaviour',
			body:
				'Stage 1 — Machine validation:\n' +
				'  1. Checks `claude` is on PATH and logged in.\n' +
				'  2. Runs vendored smokes (check-agent-frontmatter).\n' +
				'  3. Writes ~/.config/cam/config.toml with permission_mode = "bypassPermissions".\n' +
				'  4. Writes ~/.config/cam/retry.toml with the built-in retry policy defaults\n' +
				'     (first run only; existing file is preserved). Edit this file to tune\n' +
				'     max attempts, rate-limit patterns, and the retry log retention window.\n' +
				'\n' +
				'Stage 2 — Project setup wizard (if stage 1 passes):\n' +
				'  1. Asks: new project or existing?\n' +
				'  2. Verifies claude is installed and logged in.\n' +
				'  3. Asks: which issue system (linear | github | local)?\n' +
				'  4. If new: asks for a brief project description.\n' +
				'  5. Installs cam templates into .claude/commands/, .claude/agents/, scripts/cam/.\n' +
				'  6. Writes scripts/cam/project.toml with per-project config.\n' +
				'  7. Opens a tmux split:\n' +
				'       Pane A (left):  claude in bypassPermissions, adapts templates to this project.\n' +
				'       Pane B (right): key menu — c to interact, v for view-only, q to close.\n' +
				'  8. Auto-handoff: when the config agent emits CAM_SETUP_STATUS=DONE,\n' +
				'     the orchestrator is launched in a new pane immediately. The menu\n' +
				'     pane updates with options: o (orchestrator), c (config), k (kill\n' +
				'     config pane), q (close menu).',
		},
	],
	footer:
		'Note: auto-retry on rate limits is built into cam — no external tool required.\n' +
		'Rate-limit retry config: ~/.config/cam/retry.toml\n' +
		'Retry logs:             ~/.cam/retry-logs/',
});

const RUN_HELP = renderHelp({
	title: 'cam run',
	tagline: 'Open or attach the single per-project orchestrator session',
	usage: 'cam run [options]',
	sections: [
		{
			heading: 'Options',
			entries: [
				{
					name: '--no-attach',
					description: 'Create the orchestrator session without attaching (useful for scripting)',
				},
			],
		},
		{
			heading: 'Behaviour',
			body:
				'1. Verifies tmux and `.claude/agents/subagent-orchestrator.md` exist\n' +
				'   (run `cam init` first if not).\n' +
				'2. Computes a stable session name per project (cam-orch-<basename>-<hash>).\n' +
				'3. If the session does not exist: creates it with two panes.\n' +
				'     Pane 0.0 (left):  orchestrator (claude /cam-next loop).\n' +
				'     Pane 0.1 (right): cam dashboard (permanent, navigable TUI).\n' +
				'   When the orchestrator exits, the session is torn down automatically.\n' +
				'4. If the session already exists: attach (or switch-client inside tmux).\n' +
				'5. plan, next, and issue are thin pane launchers: they open a new pane\n' +
				'   inside this session and return immediately.',
		},
	],
	footer:
		'The orchestrator persona is loaded from\n' +
		'.claude/agents/subagent-orchestrator.md — see that file for what it does.',
});

const PLAN_HELP = renderHelp({
	title: 'cam plan',
	tagline: 'Open a planning pane in the project session',
	usage: 'cam plan [<N>]',
	sections: [
		{
			heading: 'Arguments',
			entries: [
				{
					name: '<N>',
					description:
						'Issue number to plan (passed to the planner as `/cam-plan N`). A leading `#` is tolerated. Omit it to plan the highest-priority open issue.',
				},
			],
		},
		{
			heading: 'Behaviour',
			body:
				'1. Reads permission_mode from ~/.config/cam/config.toml (default:\n' +
				'   bypassPermissions). cam does NOT accept a --permission-mode flag.\n' +
				'2. Ensures the project session exists (cam-orch-<basename>-<hash>);\n' +
				'   creates it (with 2-pane layout: orchestrator + dashboard) if needed.\n' +
				'3. Opens a new pane inside the session running:\n' +
				'     claude --permission-mode <mode> "/cam-plan" (or "/cam-plan N")\n' +
				'4. Returns 0 immediately. The planning flow runs inside the pane.\n' +
				'5. If not already inside the session, prints a hint:\n' +
				'     Run `cam run` to open the project session.',
		},
	],
	footer:
		'cam plan accepts only an issue number; any other argument is an error.\n' +
		'Without a number, cam dispatches a bare `/cam-plan` and the planner\n' +
		'picks the highest-priority open issue itself.',
});

const SPEC_HELP = renderHelp({
	title: 'cam spec',
	tagline: 'Deep-spec an idea issue into stage:specified via grill-with-docs',
	usage:
		'cam spec <id> | cam spec --write-docs <id> | cam spec --persist <id>  (reads JSON from stdin)',
	sections: [
		{
			heading: 'Arguments',
			entries: [
				{
					name: '<id>',
					description:
						'Issue id to spec (e.g. CAM-42). The issue must have stage:idea and status:open.',
				},
			],
		},
		{
			heading: 'Options',
			entries: [
				{
					name: '--write-docs <id>',
					description:
						'In-process write channel (no tmux): reads a DomainDocsPayload JSON\n' +
						'blob from stdin and calls writeDomainDocsOnMain directly, mirroring\n' +
						'`cam journal append` / `cam issue --file-local`.',
				},
				{
					name: '--persist <id>',
					description:
						'In-process write channel (no tmux): reads { spec, wsjf, blockedBy? }\n' +
						'JSON from stdin and calls specifyIssueOnMain directly, promoting the\n' +
						'issue to stage:specified.',
				},
			],
		},
		{
			heading: 'Behaviour',
			body:
				'1. Reads permission_mode from ~/.config/cam/config.toml (default:\n' +
				'   bypassPermissions). cam does NOT accept a --permission-mode flag.\n' +
				'2. Ensures the project session exists (cam-orch-<basename>-<hash>);\n' +
				'   creates it (with 2-pane layout: orchestrator + dashboard) if needed.\n' +
				'3. Sends `/cam-spec <id>` to the orchestrator pane via atomic send-keys.\n' +
				'4. Returns 0 immediately. The grill-with-docs interview runs inside the pane.\n' +
				'5. At interview end the orchestrator (a read-only session: Edit/Write/\n' +
				'   NotebookEdit are disallowed) pipes the assembled DomainDocsPayload JSON\n' +
				'   into `cam spec --write-docs <id>`, which commits CONTEXT.md + any new\n' +
				'   ADR files to main in one atomic commit via writeDomainDocsOnMain, with\n' +
				'   NO tmux calls, no send-keys, no pane bootstrap, no liveness check.\n' +
				'6. The orchestrator then pipes the assembled { spec, wsjf, blockedBy? }\n' +
				'   JSON into `cam spec --persist <id>`, which promotes the issue to\n' +
				'   stage:specified via specifyIssueOnMain, with the same no-tmux guarantee.',
		},
	],
	footer:
		'cam spec requires exactly one issue id argument (e.g. CAM-42).\n' +
		'After the interview the issue is stage:specified and plannable via `cam plan`.\n' +
		'`echo \'<json>\' | cam spec --write-docs CAM-42` exits 0 on { ok: true }\n' +
		'(including the noOp empty-payload outcome) and 1 on malformed JSON, an\n' +
		'invalid payload, or a guard failure (diverged / detached-head / missing-main).\n' +
		'`echo \'<json>\' | cam spec --persist CAM-42` exits 0 on { ok: true }, printing\n' +
		'CAM_SPEC_RESULT=CAM-42 sha=<sha>, and 1 on malformed JSON (reason=invalid-json)\n' +
		'or any specifyIssueOnMain guard/validation failure (reason=<reason>).',
});

const ISSUE_HELP = renderHelp({
	title: 'cam issue',
	tagline: 'File an issue from free text, or list the actionable backlog',
	usage:
		'cam issue "<free text>" | cam issue list [--all] [--json] | cam issue close <id> | cam issue abandon <id> | cam issue demote <id>',
	sections: [
		{
			heading: 'Arguments',
			entries: [
				{
					name: '"<free text>"',
					description: 'Free-text description; expanded to title + description by /cam-issue create',
				},
				{
					name: '--file-local',
					description:
						'Deterministic in-process filer (no tmux, no LLM): reads a JSON payload from stdin and commits the issue ' +
						'directly to main. Optional --fast-track (specSource: operator) or --derived-from <id[,id...]> ' +
						'(specSource: derived) flags; mutually exclusive.',
				},
				{
					name: 'list [--all] [--json]',
					description:
						'Print the actionable backlog (deterministic, in-process, no tmux). --all also includes shipped issues. ' +
						'--json emits a machine-readable { counts, plannable, byStage } snapshot instead of the rendered table ' +
						'(combinable with --all); always derived via isPlannable, never a raw fs read.',
				},
				{
					name: 'close <id>',
					description:
						'Deterministically set stage:shipped on main for a subsumed/duplicate issue (in-process, no tmux, no LLM).',
				},
				{
					name: 'abandon <id>',
					description:
						"Deterministically set status:abandoned on main for a won't-do issue (in-process, no tmux, no LLM). Stage is left untouched.",
				},
				{
					name: 'demote <id>',
					description:
						'Deterministically set stage:idea on main for a defective specified issue, so it can be re-grilled (specified->idea for re-spec; in-process, no tmux, no LLM).',
				},
			],
		},
		{
			heading: 'Behaviour',
			body:
				'1. Reads permission_mode from ~/.config/cam/config.toml (default:\n' +
				'   bypassPermissions). cam does NOT accept a --permission-mode flag.\n' +
				'2. Ensures the project session exists (cam-orch-<basename>-<hash>);\n' +
				'   creates it (with 2-pane layout: orchestrator + dashboard) if needed.\n' +
				'3. Opens a new pane inside the session running:\n' +
				'     claude --permission-mode <mode> "/cam-issue create <text>"\n' +
				'4. Returns 0 immediately. The issue-creation flow runs inside the pane.\n' +
				'5. If not already inside the session, prints a hint:\n' +
				'     Run `cam run` to open the project session.\n' +
				'6. `cam issue list` never opens a pane or spawns tmux/claude: it reads\n' +
				'   the backlog in-process and prints it directly.',
		},
	],
	footer:
		'The free text is passed verbatim to the /cam-issue create slash command.\n' +
		'The pane agent expands it into a structured issue title + description.',
});

const JOURNAL_HELP = renderHelp({
	title: 'cam journal',
	tagline: 'Append a structured cycle entry to scripts/cam/journal.md on main',
	usage: 'cam journal append [--force] [--cycle-close]  |  cam journal archive [--threshold N]',
	sections: [
		{
			heading: 'Subcommands',
			entries: [
				{
					name: 'append [--force]',
					description: 'Read a JSON cycle entry from stdin and append it to journal.md on main via commit-tree',
				},
				{
					name: 'archive [--threshold N]',
					description: 'Move the oldest third of journal.md entries to journal.archive.md on main once entries exceed N (default 50); no stdin read',
				},
			],
		},
		{
			heading: 'Options',
			entries: [
				{
					name: '--force',
					description: 'Replace an existing entry with the same cycleId instead of rejecting as a duplicate',
				},
				{
					name: '--cycle-close',
					description:
						'Append the cycle entry AND arm the orchestrator recycle marker; requires the handoff file (.claude/.cam-orch-handoff.json) to be present and a live recycle watcher',
				},
			],
		},
		{
			heading: 'Behaviour',
			body:
				'1. Reads a JSON object from stdin; must match the JournalCycleEntry schema\n' +
				'   (cycleId, title, started, closed, branch, issue, outcome, summary,\n' +
				'   and optional decisions, blockers, followups strings).\n' +
				'2. Reads scripts/cam/journal.md from main via `git show main:...`\n' +
				'   (never from the working tree -- the commit-tree-to-main pattern).\n' +
				'3. Validates required fields; rejects entries missing cycleId, title,\n' +
				'   started, closed, branch, issue, outcome, or summary.\n' +
				'4. Normalises em-dash (U+2014) in the body/summary fields to a colon\n' +
				'   per the no-em-dash-in-persisted-md project rule.\n' +
				'5. Without --force: rejects a duplicate cycleId with exit 1.\n' +
				'   With --force: replaces the existing block in place.\n' +
				'6. Writes the updated markdown to main via git plumbing (hash-object,\n' +
				'   update-index, write-tree, commit-tree, update-ref) without touching\n' +
				'   the working tree or HEAD branch.\n' +
				'7. Best-effort push to origin main (non-zero exit is logged, not fatal).\n' +
				'8. On success: prints `CAM_JOURNAL_APPENDED=<cycleId> sha=<commit-sha>`\n' +
				'   and exits 0.\n' +
				'\n' +
				'Exit-code contract:\n' +
				'  exit 1  invalid JSON on stdin, or a duplicate cycleId rejected without\n' +
				'          --force.\n' +
				'  exit 3  --cycle-close requested but the handoff file is absent\n' +
				'          (.claude/.cam-orch-handoff.json); write the cycle-close handoff\n' +
				'          before arming the recycle marker.\n' +
				'  exit 4  --cycle-close requested but no live recycle watcher was found\n' +
				'          (.claude/.cam-watcher.pid absent or the process is dead); use\n' +
				'          /exit manually or start `cam run` to restart the watcher.\n' +
				'\n' +
				'`cam journal archive [--threshold N]`:\n' +
				'  Does not read stdin. Moves the oldest floor(entries/3) post-marker\n' +
				'  entries from journal.md to journal.archive.md in one atomic on-main\n' +
				'  commit when the entry count exceeds N (default 50). Prints\n' +
				'  `CAM_JOURNAL_ARCHIVED=<k> sha=<commit-sha>` and exits 0 on a successful\n' +
				'  archive; prints `CAM_JOURNAL_ARCHIVE=noop entries=<n> threshold=<t>` and\n' +
				'  exits 0 when at or below the threshold; exits 1 on failure.',
		},
	],
	footer:
		'The orchestrator calls `cam journal append` at cycle close time as the\n' +
		'deterministic housekeeping channel (read-only orchestrator, gated write via cam).',
});

const PATTERNS_HELP = renderHelp({
	title: 'cam patterns',
	tagline: 'Move resolved-marked bullets from scripts/cam/patterns.md to patterns.archive.md on main',
	usage: 'cam patterns archive',
	sections: [
		{
			heading: 'Subcommands',
			entries: [
				{
					name: 'archive',
					description: 'Move bullets carrying `[resolved YYYY-MM]` from patterns.md to patterns.archive.md on main via commit-tree',
				},
			],
		},
		{
			heading: 'Behaviour',
			body:
				'1. Reads scripts/cam/patterns.md from main via `git show main:...`\n' +
				'   (never from the working tree -- the commit-tree-to-main pattern).\n' +
				'2. Selection is MARKER-based only: a bullet moves if and only if it\n' +
				'   carries `[resolved YYYY-MM]` anywhere in its text. Unlike `cam\n' +
				'   journal archive`, position, age, and count never decide selection\n' +
				'   -- there is no --threshold flag.\n' +
				'3. Writes both files to main via git plumbing (hash-object, update-index,\n' +
				'   write-tree, commit-tree, update-ref) without touching the working\n' +
				'   tree or HEAD branch.\n' +
				'4. Best-effort push to origin main (non-zero exit is logged, not fatal).\n' +
				'5. On success with marked bullets: prints `CAM_PATTERNS_ARCHIVED=<k>\n' +
				'   sha=<commit-sha>` and exits 0.\n' +
				'6. On success with no marked bullets: prints `CAM_PATTERNS_ARCHIVE=noop`\n' +
				'   and exits 0.\n' +
				'7. On failure (diverged, detached HEAD, missing main, patterns.md\n' +
				'   missing on main): exits 1.',
		},
	],
	footer:
		'To mark a bullet resolved, append `[resolved YYYY-MM]` anywhere in its\n' +
		'text on main; `cam patterns archive` then relocates it verbatim.',
});

const SUGGESTIONS_HELP = renderHelp({
	title: 'cam suggestions',
	tagline: 'Triage the pen of penned reviewer SUGGESTIONs (scripts/cam/suggestions.jsonl)',
	usage: 'cam suggestions list|promote <fingerprint>|dismiss <fingerprint>',
	sections: [
		{
			heading: 'Subcommands',
			entries: [
				{
					name: 'list',
					description:
						'Read scripts/cam/suggestions.jsonl from main and print each pending SUGGESTION (fingerprint, title, source, round)',
				},
				{
					name: 'promote <fingerprint>',
					description:
						'File the matching pen entry as a real issue (derivedFrom + suggestion-fingerprint line preserved), then remove it from the pen',
				},
				{
					name: 'dismiss <fingerprint>',
					description: 'Remove the matching pen entry without filing an issue',
				},
			],
		},
		{
			heading: 'Behaviour',
			body:
				'1. Reads scripts/cam/suggestions.jsonl from main via `git show main:...`\n' +
				'   (never from the working tree -- the commit-tree-to-main pattern).\n' +
				'2. `list` renders each entry as fingerprint, title, source branch, and\n' +
				'   review round (when recorded); an empty (or absent) pen prints a\n' +
				'   friendly empty-state hint, not an error.\n' +
				'3. `promote` files the entry and removes its pen line in ONE atomic\n' +
				'   on-main commit (preserving derivedFrom from the entry\'s sourceIssue\n' +
				'   and embedding a `suggestion-fingerprint: <fp>` description line so\n' +
				'   future terminal reviews still dedup against it).\n' +
				'4. `dismiss` removes the one matching line from the pen; no issue is filed.\n' +
				'5. Both mutations use the on-main commit-tree plumbing and rewrite only\n' +
				'   the one matching-fingerprint line -- every other line is byte-preserved.\n' +
				'6. An unknown fingerprint prints an error, exits non-zero, and mutates\n' +
				'   nothing.',
		},
	],
	footer:
		'The pen is filled by the terminal-verdict hook (CAM-189) when a review\n' +
		'ends CLEAN with non-blocking SUGGESTIONs.',
});

const NEXT_HELP = renderHelp({
	title: 'cam next',
	tagline: 'Open a loop pane in the project session',
	usage: 'cam next [--max-iter <N>] [--completion-promise <STR>]',
	sections: [
		{
			heading: 'Options',
			entries: [
				{ name: '--max-iter <N>', description: 'Max iterations before auto-stop (default: 30)' },
				{
					name: '--completion-promise <STR>',
					description: 'Phrase the assistant emits to end the loop (default: COMPLETE)',
				},
			],
		},
		{
			heading: 'Behaviour',
			body:
				'1. Reads permission_mode from ~/.config/cam/config.toml (default:\n' +
				'   bypassPermissions). cam does NOT accept a --permission-mode flag.\n' +
				'2. Pre-arms the cam-loop plugin by writing\n' +
				'   .claude/cam-loop.local.md (vendored template at\n' +
				'   vendor/cam-loop.local.md.tmpl).\n' +
				'3. Ensures the project session exists (cam-orch-<basename>-<hash>);\n' +
				'   creates it (with 2-pane layout: orchestrator + dashboard) if needed.\n' +
				'4. Opens a new pane inside the session running:\n' +
				'     claude --permission-mode <mode> "/cam-next"\n' +
				'5. Returns 0 immediately. The loop runs inside the pane.\n' +
				'6. If not already inside the session, prints a hint:\n' +
				'     Run `cam run` to open the project session.',
		},
		{
			heading: 'Stop primitives',
			body:
				'/cancel-cam  (preferred — cleans up the state file)\n' +
				'rm .claude/cam-loop.local.md  (kill switch — loop ends after current turn)',
		},
	],
});

const REVIEW_HELP = renderHelp({
	title: 'cam review',
	tagline: 'Dispatch /cam-review to the live orchestrator',
	usage: 'cam review',
	sections: [
		{
			heading: 'Behaviour',
			body:
				'1. Checks whether a live orchestrator session exists\n' +
				'   (cam-orch-<basename>-<hash>).\n' +
				'2. On hit: sends /cam-review to the orchestrator pane via\n' +
				'   atomic tmux send-keys and returns immediately.\n' +
				'3. On miss: bootstraps the orchestrator via `cam run --no-attach`,\n' +
				'   waits for .claude/.cam-orch-ready + liveness re-check, then\n' +
				'   sends /cam-review.\n' +
				'4. If not already inside the session, prints a hint:\n' +
				'     Run `cam run` to open the project session.',
		},
	],
	footer: 'cam review accepts no arguments. cam does NOT accept a --permission-mode flag.',
});

const SHIP_HELP = renderHelp({
	title: 'cam ship',
	tagline: 'Write phase:shipping to the loop state file, or finalize a cycle in-process',
	usage: 'cam ship [--finalize] [--bump]',
	sections: [
		{
			heading: 'Behaviour (default)',
			body:
				'1. Checks whether a live orchestrator session exists\n' +
				'   (cam-orch-<basename>-<hash>).\n' +
				'2. On hit: writes phase:shipping to .claude/cam-loop.local.md,\n' +
				'   preserving all other state-file fields; the sidecar runs the\n' +
				'   deterministic ship runner and returns immediately.\n' +
				'3. On miss: bootstraps the orchestrator via `cam run --no-attach`,\n' +
				'   waits for .claude/.cam-orch-ready + liveness re-check, then\n' +
				'   writes phase:shipping.\n' +
				'4. If not already inside the session, prints a hint:\n' +
				'     Run `cam run` to open the project session.',
		},
		{
			heading: 'Options',
			entries: [
				{
					name: '--finalize',
					description:
						'Run the deterministic cycle-close in-process (no tmux session needed). ' +
						'Closes the tracked issue, removes per-branch harness state files via ' +
						'`git rm -f --ignore-unmatch`, and commits the cleanup.',
				},
				{
					name: '--bump',
					description:
						'Classify branch commits (main..HEAD), compute the next semver version ' +
						'(0.x convention: major -> minor while major is 0), write src/version.ts ' +
						'and package.json, and commit `chore(release): bump version to X.Y.Z`. ' +
						'No-op when all commits classify as none.',
				},
			],
		},
	],
	footer: 'cam does NOT accept a --permission-mode flag.',
});

const TAG_HELP = renderHelp({
	title: 'cam tag',
	tagline: 'Create and push the vX.Y.Z git tag for the current CAM_VERSION',
	usage: 'cam tag',
	sections: [
		{
			heading: 'Behaviour',
			body:
				'1. Reads CAM_VERSION from src/version.ts to determine the tag name (vX.Y.Z).\n' +
				'2. Refuses with a non-zero exit if the current branch is not `main`.\n' +
				'3. Refuses with a non-zero exit if the working tree is dirty.\n' +
				'4. If the tag already exists, prints a message and exits 0 (idempotent).\n' +
				'5. Otherwise: runs `git tag vX.Y.Z` then `git push origin vX.Y.Z`.\n' +
				'\n' +
				'Run this on main AFTER the PR squash-merges (squash mints a new SHA,\n' +
				'so tagging from the feature branch would tag the wrong commit).',
		},
	],
	footer: 'Requires a clean working tree and `git push` access to origin.',
});

const STATUS_HELP = renderHelp({
	title: 'cam status',
	tagline: 'Show current loop state at a glance',
	usage: 'cam status',
	sections: [
		{
			heading: 'Reads three sources in the current cwd',
			body:
				'1. .claude/cam-loop.local.md  — plugin state file (iteration, started_at,\n' +
				'                                completion_promise, active flag).\n' +
				'2. prd.json                   — current story = highest-priority passes:false.\n' +
				'3. git                        — current branch + last commit (best-effort).',
		},
		{
			heading: 'Output',
			body:
				'status: idle | active | paused\n' +
				'story:  US-NNN <title>\n' +
				'iter:   N / M\n' +
				'since:  <wall-clock since started_at>\n' +
				'branch: <current branch>\n' +
				'last:   <sha> <subject>',
		},
	],
	footer: 'Exits 0 always — even when no loop is running (status: idle).',
});

const DASHBOARD_HELP = renderHelp({
	title: 'cam dashboard',
	tagline: 'Read-only TUI for monitoring a running loop',
	usage: 'cam dashboard [orchPane]',
	sections: [
		{
			heading: 'Arguments',
			body:
				'  orchPane   Optional tmux pane id of the orchestrator (e.g. %5).\n' +
				'             When provided, the keybar keys (n/r/s/p/i/d) dispatch\n' +
				'             commands to that pane. Omit for standalone monitoring.',
		},
		{
			heading: 'Behaviour',
			body:
				'1. Enters the alternate screen buffer (vim/htop style), hides the cursor.\n' +
				'2. Polls the cwd\'s prd.json + .claude/cam-loop.local.md every 2s and\n' +
				'   redraws on change.\n' +
				'3. Surfaces: branch, current story (id + title), wall-clock,\n' +
				'   last 5 progress events, story list with token counts.\n' +
				'4. Keybar: n=/cam-next  r=/cam-review  s=/cam-ship  p=/cam-plan\n' +
				'           i=/cam-issue  d=focus orchestrator  q=close pane.\n' +
				'5. Exits cleanly on q or Ctrl+C, restores the cursor + leaves alt-screen.',
		},
	],
	footer:
		'cam run places this command in pane 0.1 of the project session (permanent,\n' +
		'always visible). You can also run it standalone in any terminal.',
});

const STOP_HELP = renderHelp({
	title: 'cam stop',
	tagline: 'Cleanly cancel a running loop',
	usage: 'cam stop',
	sections: [
		{
			heading: 'What it does',
			body:
				'1. Removes .claude/cam-loop.local.md (the plugin state file).\n' +
				'2. Kills the per-project tmux session (derived from the project root\n' +
				'   path) if alive; unrelated tmux sessions are NOT touched.\n' +
				'3. Exits 0. Idempotent: calling `cam stop` with nothing to clean is the\n' +
				'   success state, not a failure.',
		},
	],
	footer: 'After `cam stop`, the next `cam next` will not detect a stale loop.',
});

const DRAIN_HELP = renderHelp({
	title: 'cam drain',
	tagline: 'Set or clear the inter-cycle drain kill-switch',
	usage: 'cam drain [--stop | --clear]',
	sections: [
		{
			heading: 'Flags',
			entries: [
				{ name: '--stop', description: 'Write the kill-switch marker; the loop stops at the next safe cycle boundary' },
				{ name: '--clear', description: 'Remove the kill-switch marker; unattended draining is re-enabled' },
				{ name: '(none)', description: 'Print the current kill-switch status' },
			],
		},
		{
			heading: 'Notes',
			body:
				'`cam drain --stop` writes only the drain marker (.claude/.cam-drain-stop).\n' +
				'It does NOT send SIGTERM to the sidecar or remove any other marker.\n' +
				'Use `cam stop` to fully cancel the session.',
		},
	],
	footer: '`cam stop` also clears the drain kill-switch as part of its full cleanup.',
});

const RESUME_HELP = renderHelp({
	title: 'cam resume',
	tagline: 'Reconcile loop state after an interrupt',
	usage: 'cam resume [--mode <name>] [--dry-run] [--force]',
	sections: [
		{
			heading: 'Auto-detected modes (no --mode flag)',
			entries: [
				{ name: 'idle', description: 'No state file → run `cam next` to start fresh' },
				{
					name: 'noop',
					description: 'retry-monitor alive (PID from ~/.cam/retry.pid) — loop will resume on its own',
				},
				{
					name: 'respawn',
					description: 'State file + heartbeat dead + recent commit (≤24h) → re-spawn `cam next`',
				},
				{
					name: 'prompt',
					description: 'State file + heartbeat dead + last commit >24h → asks [Y/n/reset]',
				},
				{ name: 'success', description: 'PRD already complete → auto-clean orphan state file' },
			],
		},
		{
			heading: 'Explicit --mode overrides',
			entries: [
				{
					name: '--mode reset-current-story',
					description: 'Flip most-recently-completed story back to passes:false (re-runs it next)',
				},
				{
					name: '--mode reset-prd',
					description: 'Flip every story to passes:false (re-runs PRD from US-001)',
				},
				{
					name: '--mode reset-branch',
					description: 'Print `git reset --hard origin/main` + remove state file (cam does NOT run reset)',
				},
			],
		},
		{
			heading: 'Flags',
			entries: [
				{ name: '--dry-run', description: 'Classify and print without mutating state or spawning' },
				{ name: '--force', description: 'Skip the confirmation prompt for --mode reset-branch' },
			],
		},
	],
});

const CONFIG_HELP =
	'Usage: cam config [--show]\n' +
	'  Interactive wizard to set model per phase and backend\n' +
	'  --show  Print current config without prompting (US-008)\n';

const TRIAGE_HELP =
	'Usage: cam triage\n' +
	'  Rank {specified,open} issues from main using WSJF topo-sort.\n' +
	'  Writes updated ranks to main (off-main commit-tree; no checkout).\n' +
	'  No-op when ranks are unchanged (idempotent).\n';

// Internal commands (US-001, CAM-211): not listed in top-level HELP, but each
// needs a real help entry so the central --help/-h guard below can short-
// circuit them without ever running their body (e.g. `cam sidecar --help`
// must never boot the long-lived daemon).

const SIDECAR_HELP = renderHelp({
	title: 'cam sidecar',
	tagline: 'Internal command — not for direct use',
	usage: 'cam sidecar',
	sections: [
		{
			heading: 'Behaviour',
			body:
				'Spawned as a detached background process by `cam run`. Polls the\n' +
				'`active` flag in .claude/cam-loop.local.md and drives the supervisor\n' +
				'loop (runSupervisor) when active. Loops until killed by `cam run`\'s\n' +
				'cleanup. Not listed in top-level `cam help`.',
		},
	],
});

const ORCH_RECYCLE_WATCH_HELP = renderHelp({
	title: 'cam orch-recycle-watch',
	tagline: 'Internal command — not for direct use',
	usage: 'cam orch-recycle-watch',
	sections: [
		{
			heading: 'Behaviour',
			body:
				'Spawned as a detached background process by `cam run`. Polls for the\n' +
				'orchestrator recycle marker and sends SIGTERM to the orchestrator\n' +
				'claude PID when armed (consume-once). Not listed in top-level\n' +
				'`cam help`.',
		},
	],
});

const SIDECAR_LIVENESS_WATCH_HELP = renderHelp({
	title: 'cam sidecar-liveness-watch',
	tagline: 'Internal command — not for direct use',
	usage: 'cam sidecar-liveness-watch',
	sections: [
		{
			heading: 'Behaviour',
			body:
				'Spawned by `cam run` only in container worker_isolation mode. Detects\n' +
				'a dead container sidecar, attempts a bounded respawn, and escalates via\n' +
				'the .cam-sidecar-stalled.json marker on exhaustion. Not listed in\n' +
				'top-level `cam help`.',
		},
	],
});

const ORCH_BUDGET_HELP = renderHelp({
	title: 'cam orch-budget',
	tagline: 'Internal command — not for direct use',
	usage: 'cam orch-budget',
	sections: [
		{
			heading: 'Behaviour',
			body:
				'Read-only, no flags. Prints a single machine-parseable line\n' +
				'(CAM_ORCH_BUDGET=<spend>/<threshold> over=<true|false>) and always\n' +
				'exits 0. Invoked each cycle by the orchestrator agent. Not listed in\n' +
				'top-level `cam help`.',
		},
	],
});

// --- Argv parsers ----------------------------------------------------------

/**
 * Parse issue-subcommand positional argument. Accepts a single free-text
 * string (the issue description) or `--help` / `-h`. Returns the parsed
 * text plus a flag indicating the operator asked for help, or `null` on a
 * parse error (the caller prints the diagnostic and exits 1).
 *
 * NOTE: This parser does NOT accept `--permission-mode` — that is the
 * US-007 acceptance criterion 7 invariant. `test/no-permission-mode-flag.test.ts`
 * greps this file for the literal `--permission-mode` and fails the build
 * if a parser registers it.
 */

/**
 * Discriminated union returned by parseIssueArgs.
 * - mode === 'text': free-text thin-proxy path (existing behaviour).
 * - mode === 'file-local': deterministic in-process path (US-003).
 *     fastTrack: true when --fast-track was passed (specSource: operator).
 *     derivedFrom: non-empty when --derived-from was passed (specSource: derived).
 * - mode === 'list': deterministic in-process backlog print (US-003, CAM-190).
 *     all: true when --all was passed (include the shipped group).
 *     json: true when --json was passed (emit the { counts, plannable,
 *       byStage } machine snapshot instead of the rendered table; US-002,
 *       CAM-222). Combinable with --all.
 * - mode === 'close': deterministic in-process stage:shipped mutation on main
 *     (US-002, CAM-210). id is the required positional issue id.
 * - mode === 'abandon': deterministic in-process status:abandoned mutation on
 *     main (US-003, CAM-210). id is the required positional issue id; stage
 *     is left untouched (only the status axis changes).
 * - mode === 'demote': deterministic in-process stage:specified -> stage:idea
 *     mutation on main (US-002, CAM-206/CAM-210 sibling). id is the required
 *     positional issue id; only the stage axis flips (spec/wsjf/blockedBy
 *     etc. are preserved) so the issue can be re-grilled.
 * - help === true: caller should print ISSUE_HELP and exit 0.
 */
export type ParsedIssueArgs =
	| { mode: 'text'; text: string; help: false }
	| { mode: 'file-local'; fastTrack: boolean; derivedFrom: string[]; help: false }
	| { mode: 'list'; all: boolean; json: boolean; help: false }
	| { mode: 'close'; id: string; help: false }
	| { mode: 'abandon'; id: string; help: false }
	| { mode: 'demote'; id: string; help: false }
	| { mode?: never; help: true };

/**
 * Shared subcommand arg-parse idiom used by parseIssueArgs (free-text
 * fallthrough), parsePlanArgs, and parseSpecArgs: --help/-h detection,
 * unknown-option rejection, too-many-arguments rejection, and single-
 * positional capture. Callers own their exact error messages (passed via
 * `onTooMany`/`onUnknownOption`) and any further validation of the captured
 * positional (e.g. plan's integer parse, spec's empty-id check) -- this
 * helper only factors the control flow that was previously cloned across
 * the three parsers (the regression class that raised the dup ratchet at
 * the CAM-107 ship).
 *
 * `onUnknownOption` is optional: omit it to allow tokens starting with `-`
 * to be captured as the positional (parseIssueArgs' free-text mode accepts
 * any single token as the issue title, including one that looks like a
 * flag).
 *
 * Returns:
 *  - `{ help: true }` if `--help`/`-h` is present anywhere in args.
 *  - `null` if an unknown option or a second positional argument is found
 *    (the caller's callback has already reported the error).
 *  - `{ help: false, positional }` otherwise, where `positional` is the
 *    single captured token (`undefined` when args has no positional).
 */
function parseSubcommandArgs(
	args: string[],
	opts: {
		onTooMany: (arg: string) => void;
		onUnknownOption?: (arg: string) => void;
	},
): { help: true } | { help: false; positional?: string } | null {
	if (args.includes('--help') || args.includes('-h')) {
		return { help: true };
	}
	let positional: string | undefined;
	for (const arg of args) {
		if (opts.onUnknownOption && arg.startsWith('-')) {
			opts.onUnknownOption(arg);
			return null;
		}
		if (positional !== undefined) {
			opts.onTooMany(arg);
			return null;
		}
		positional = arg;
	}
	return { help: false, positional };
}

export function parseIssueArgs(args: string[]): ParsedIssueArgs | null {
	if (args.includes('--help') || args.includes('-h')) {
		return { help: true };
	}
	// The `list` subcommand is evaluated BEFORE the free-text fallthrough so a
	// bare `list` positional is never misread as free-text issue creation.
	if (args[0] === 'list') {
		let all = false;
		let json = false;
		for (const arg of args.slice(1)) {
			if (arg === '--all') {
				all = true;
			} else if (arg === '--json') {
				json = true;
			} else {
				printError(`unexpected argument: ${arg}`);
				return null;
			}
		}
		return { mode: 'list', all, json, help: false };
	}
	// The `close <id>` subcommand is evaluated BEFORE the free-text fallthrough
	// (alongside `list`) so a missing id is a parse error, never a silent
	// text-mode fallthrough treating 'close' as an issue title.
	if (args[0] === 'close') {
		const id = args[1];
		if (id === undefined) {
			printError('cam issue close requires an id (e.g. CAM-42)');
			return null;
		}
		if (args.length > 2) {
			printError(`unexpected argument: ${args[2]}`);
			return null;
		}
		return { mode: 'close', id, help: false };
	}
	// The `abandon <id>` subcommand is evaluated BEFORE the free-text fallthrough
	// (alongside `list`/`close`) so a missing id is a parse error, never a silent
	// text-mode fallthrough treating 'abandon' as an issue title.
	if (args[0] === 'abandon') {
		const id = args[1];
		if (id === undefined) {
			printError('cam issue abandon requires an id (e.g. CAM-42)');
			return null;
		}
		if (args.length > 2) {
			printError(`unexpected argument: ${args[2]}`);
			return null;
		}
		return { mode: 'abandon', id, help: false };
	}
	// The `demote <id>` subcommand is evaluated BEFORE the free-text fallthrough
	// (alongside `list`/`close`/`abandon`) so a missing id is a parse error, never a
	// silent text-mode fallthrough treating 'demote' as an issue title.
	if (args[0] === 'demote') {
		const id = args[1];
		if (id === undefined) {
			printError('cam issue demote requires an id (e.g. CAM-42)');
			return null;
		}
		if (args.length > 2) {
			printError(`unexpected argument: ${args[2]}`);
			return null;
		}
		return { mode: 'demote', id, help: false };
	}
	if (args.includes('--file-local')) {
		let fastTrack = false;
		const derivedFrom: string[] = [];

		const rest = args.filter((a) => a !== '--file-local');
		for (let i = 0; i < rest.length; i++) {
			const arg = rest[i]!;
			if (arg === '--fast-track') {
				fastTrack = true;
			} else if (arg === '--derived-from') {
				const val = rest[i + 1];
				if (val === undefined || val.startsWith('-')) {
					printError('--derived-from requires a value (e.g. CAM-123 or CAM-123,CAM-124)');
					return null;
				}
				derivedFrom.push(...val.split(',').map((s) => s.trim()).filter(Boolean));
				i++;
			} else {
				printError(`unexpected argument: ${arg}`);
				return null;
			}
		}

		// --fast-track and --derived-from are mutually exclusive: each implies a
		// distinct specSource ('operator' vs 'derived') and cannot be combined.
		if (fastTrack && derivedFrom.length > 0) {
			printError('--fast-track and --derived-from are mutually exclusive');
			return null;
		}

		return { mode: 'file-local', fastTrack, derivedFrom, help: false };
	}
	const parsed = parseSubcommandArgs(args, {
		onTooMany: (arg) => printError(`unexpected argument: ${arg}`),
	});
	if (parsed === null) return null;
	const text = parsed.help ? undefined : parsed.positional;
	if (text === undefined || text.trim().length === 0) {
		printError('cam issue requires a free-text argument');
		return null;
	}
	return { mode: 'text', text, help: false };
}

/**
 * Parse `cam plan` args. The command takes at most one POSITIONAL argument:
 * a positive integer issue number (a leading `#` is tolerated, e.g. `'#21'`).
 * The CLI is strict on purpose; the `/cam-plan` slash inside claude stays
 * flexible (number resolved per backend, plus free-text descriptions). A
 * positional that is not a valid integer is a standardized error. A bare
 * `cam plan` (no positional) leaves `issue` undefined; the planner then picks
 * the highest-priority open issue itself.
 *
 * Returns `{ issue?, help }` or `null` on a parse error (the caller prints the
 * diagnostic and exits 1).
 */
export function parsePlanArgs(args: string[]): { issue?: number; help: boolean } | null {
	const parsed = parseSubcommandArgs(args, {
		onUnknownOption: (arg) => printError(
			`unknown plan option: ${arg}`,
			'cam plan takes an issue number, e.g. `cam plan 21`',
		),
		onTooMany: () => printError(
			'cam plan: too many arguments',
			'expected a single issue number, e.g. `cam plan 21`',
		),
	});
	if (parsed === null) return null;
	if (parsed.help) return { help: true };
	if (parsed.positional === undefined) return { help: false };
	// Positional issue number; tolerate a leading `#` (e.g. `cam plan '#21'`).
	const token = parsed.positional.startsWith('#') ? parsed.positional.slice(1) : parsed.positional;
	const issue = Number.parseInt(token, 10);
	if (!/^\d+$/.test(token) || issue <= 0) {
		printError(
			'cam plan: invalid issue reference',
			'expected an issue number, e.g. `cam plan 21`',
		);
		return null;
	}
	return { issue, help: false };
}

/**
 * Discriminated union returned by parseSpecArgs.
 * - mode === 'write-docs': in-process `--write-docs <id>` write channel
 *     (US-003, CAM-118): reads a DomainDocsPayload JSON blob from stdin and
 *     calls writeDomainDocsOnMain directly. NO tmux calls.
 * - mode === 'persist': in-process `--persist <id>` write channel
 *     (US-001, CAM-213): reads a { spec, wsjf, blockedBy? } JSON blob from
 *     stdin and calls specifyIssueOnMain directly. NO tmux calls.
 * - mode === 'proxy': the existing thin-proxy path (US-004, CAM-107),
 *     byte-behaviorally unchanged. `id` is optional here: a bare `cam spec`
 *     with no positional is a parse success (dispatch reports the missing-id
 *     error), matching the pre-US-003 behaviour.
 * - help === true: caller should print SPEC_HELP and exit 0.
 *
 * NOTE: This parser does NOT accept `--permission-mode` (US-007 invariant).
 */
export type ParsedSpecArgs =
	| { mode: 'write-docs'; id: string; help: false }
	| { mode: 'persist'; id: string; help: false }
	| { mode: 'proxy'; id?: string; help: false }
	| { mode?: never; help: true };

/**
 * Parse `cam spec` args. The command takes exactly one positional argument:
 * an issue id string (e.g. 'CAM-42' or '42'). A leading prefix is preserved
 * as-is; a bare integer is accepted and prefixed by the caller. `--write-docs`
 * selects the in-process write-docs channel (US-003); `--persist` selects the
 * in-process persist channel (US-001, CAM-213); their absence keeps the
 * existing thin-proxy path (US-004) unchanged.
 *
 * Returns `null` on a parse error (the caller prints the usage hint).
 */
export function parseSpecArgs(args: string[]): ParsedSpecArgs | null {
	const writeDocs = args.includes('--write-docs');
	const persist = args.includes('--persist');
	const rest = args.filter((a) => a !== '--write-docs' && a !== '--persist');

	const parsed = parseSubcommandArgs(rest, {
		onUnknownOption: (arg) => printError(
			`unknown spec option: ${arg}`,
			'cam spec takes an issue id, e.g. `cam spec CAM-42`',
		),
		onTooMany: () => printError(
			'cam spec: too many arguments',
			'expected a single issue id, e.g. `cam spec CAM-42`',
		),
	});
	if (parsed === null) return null;
	if (parsed.help) return { help: true };
	const id = parsed.positional;
	if (id !== undefined && id.length === 0) {
		printError(
			'cam spec: empty issue id',
			'expected an issue id, e.g. `cam spec CAM-42`',
		);
		return null;
	}

	if (writeDocs) {
		if (id === undefined) {
			printError(
				'cam spec --write-docs: missing issue id',
				'usage: echo \'<json>\' | cam spec --write-docs <id>',
			);
			return null;
		}
		return { mode: 'write-docs', id, help: false };
	}

	if (persist) {
		if (id === undefined) {
			printError(
				'cam spec --persist: missing issue id',
				'usage: echo \'<json>\' | cam spec --persist <id>',
			);
			return null;
		}
		return { mode: 'persist', id, help: false };
	}

	return id !== undefined ? { mode: 'proxy', id, help: false } : { mode: 'proxy', help: false };
}

/** Injectable deps for dispatchSpec -- all optional; production uses real impls. */
export interface SpecDispatchDeps {
	/**
	 * Inject a fake for the --write-docs branch.
	 * Default: calls runSpecWriteDocs({ id }) (reads stdin JSON, in-process,
	 * no tmux).
	 */
	writeDocsFn?: (id: string) => Promise<number>;
	/**
	 * Inject a fake for the --persist branch.
	 * Default: calls runSpecPersist({ id }) (reads stdin JSON, in-process,
	 * no tmux).
	 */
	persistFn?: (id: string) => Promise<number>;
	/** Inject a fake for the thin-proxy branch. Default: calls runSpec({ id }). */
	runSpecFn?: (id: string) => Promise<number>;
}

/**
 * Route a parsed `cam spec` call: mode 'write-docs' => runSpecWriteDocs
 * in-process (NO tmux calls, no send-keys, no pane bootstrap, no liveness
 * check); mode 'persist' => runSpecPersist in-process (same no-tmux
 * guarantee); mode 'proxy' => the existing runSpec thin-proxy. Exported so
 * unit tests can inject fakes for all branches and prove each in-process path
 * never touches the thin-proxy (and vice versa).
 */
export async function dispatchSpec(
	parsed: ParsedSpecArgs,
	deps?: SpecDispatchDeps,
): Promise<number> {
	if (parsed.mode === 'write-docs') {
		const writeDocsFn = deps?.writeDocsFn ?? ((id: string) => runSpecWriteDocs({ id }));
		return writeDocsFn(parsed.id);
	}
	if (parsed.mode === 'persist') {
		const persistFn = deps?.persistFn ?? ((id: string) => runSpecPersist({ id }));
		return persistFn(parsed.id);
	}
	const id = parsed.mode === 'proxy' ? parsed.id : undefined;
	if (!id) {
		printError('cam spec: missing issue id', 'usage: cam spec <id>  e.g. cam spec CAM-42');
		printFatalHint('run `cam spec --help` for usage');
		return 1;
	}
	const runSpecFn = deps?.runSpecFn ?? ((idArg: string) => runSpec({ id: idArg }));
	return runSpecFn(id);
}

/**
 * Parse next-specific flags. Accepts `--max-iter N` / `--max-iter=N` and
 * `--completion-promise STR` / `--completion-promise=STR`. Both are
 * optional; defaults applied in `runNext`.
 *
 * NOTE: This parser does NOT accept `--permission-mode` -- that's the US-007
 * acceptance criterion 7 invariant. `test/no-permission-mode-flag.test.ts`
 * greps this file for the literal `--permission-mode` and fails the build
 * if it appears.
 */
export function parseNextArgs(
	args: string[],
): { maxIterations?: number; completionPromise?: string; help: boolean } | null {
	const result: { maxIterations?: number; completionPromise?: string; help: boolean } = {
		help: false,
	};
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === '--help' || arg === '-h') {
			result.help = true;
			continue;
		}
		if (arg === '--max-iter' || arg === '--max-iterations') {
			const next = args[i + 1];
			if (next === undefined) {
				printError(`${arg} requires a number`);
				return null;
			}
			const parsed = Number.parseInt(next, 10);
			if (!Number.isFinite(parsed) || parsed <= 0) {
				printError(`${arg} expects a positive integer, got ${JSON.stringify(next)}`);
				return null;
			}
			result.maxIterations = parsed;
			i += 1;
			continue;
		}
		if (arg.startsWith('--max-iter=') || arg.startsWith('--max-iterations=')) {
			const value = arg.slice(arg.indexOf('=') + 1);
			const parsed = Number.parseInt(value, 10);
			if (!Number.isFinite(parsed) || parsed <= 0) {
				printError(`${arg.split('=')[0]} expects a positive integer, got ${JSON.stringify(value)}`);
				return null;
			}
			result.maxIterations = parsed;
			continue;
		}
		if (arg === '--completion-promise') {
			const next = args[i + 1];
			if (next === undefined) {
				printError('--completion-promise requires a string');
				return null;
			}
			result.completionPromise = next;
			i += 1;
			continue;
		}
		if (arg.startsWith('--completion-promise=')) {
			result.completionPromise = arg.slice('--completion-promise='.length);
			continue;
		}
		printError(`unknown next option: ${arg}`);
		return null;
	}
	return result;
}

/**
 * Parse resume-specific flags. Accepts:
 *
 *   --mode <name>   one of: reset-current-story | reset-prd | reset-branch
 *   --mode=<name>   joined form
 *   --dry-run       classify + print, no mutations
 *   --force         skip the destructive-mode confirmation prompt
 *   --help / -h     show RESUME_HELP
 *
 * Returns `null` on a parse error (caller prints the diagnostic + exits 1).
 *
 * NOTE: This parser does NOT accept `--permission-mode` — that's the US-007
 * acceptance criterion 7 invariant. The textual smoke in
 * `test/no-permission-mode-flag.test.ts` greps this file for any registration
 * of `--permission-mode`; resume is bound by the same invariant.
 */
const RESUME_MODES = new Set<ExplicitMode>([
	'reset-current-story',
	'reset-prd',
	'reset-branch',
]);

function isExplicitMode(value: string): value is ExplicitMode {
	return (RESUME_MODES as Set<string>).has(value);
}

export function parseResumeArgs(
	args: string[],
): { mode?: ExplicitMode; dryRun: boolean; force: boolean; help: boolean } | null {
	const result: { mode?: ExplicitMode; dryRun: boolean; force: boolean; help: boolean } = {
		dryRun: false,
		force: false,
		help: false,
	};
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === '--help' || arg === '-h') {
			result.help = true;
			continue;
		}
		if (arg === '--dry-run') {
			result.dryRun = true;
			continue;
		}
		if (arg === '--force') {
			result.force = true;
			continue;
		}
		if (arg === '--mode') {
			const next = args[i + 1];
			if (next === undefined) {
				printError('--mode requires a value (one of reset-current-story | reset-prd | reset-branch)');
				return null;
			}
			if (!isExplicitMode(next)) {
				printError(`--mode expects reset-current-story | reset-prd | reset-branch, got ${JSON.stringify(next)}`);
				return null;
			}
			result.mode = next;
			i += 1;
			continue;
		}
		if (arg.startsWith('--mode=')) {
			const value = arg.slice('--mode='.length);
			if (!isExplicitMode(value)) {
				printError(`--mode expects reset-current-story | reset-prd | reset-branch, got ${JSON.stringify(value)}`);
				return null;
			}
			result.mode = value;
			continue;
		}
		printError(`unknown resume option: ${arg}`);
		return null;
	}
	return result;
}

/**
 * Parse `cam review` args. The command accepts no positional arguments and
 * only the standard --help / -h flag. Any other argument is an error.
 *
 * NOTE: This parser does NOT accept `--permission-mode` -- that is the
 * US-007 acceptance criterion 7 invariant. `test/no-permission-mode-flag.test.ts`
 * greps this file for the literal `--permission-mode` and fails the build
 * if a parser registers it.
 */
export function parseReviewArgs(args: string[]): { help: boolean } | null {
	const result = { help: false };
	for (const arg of args) {
		if (arg === '--help' || arg === '-h') {
			result.help = true;
			continue;
		}
		printError(`unknown review option: ${arg}`);
		return null;
	}
	return result;
}

/**
 * Parse `cam ship` args. The command accepts no positional arguments and
 * only the standard --help / -h flag. Any other argument is an error.
 *
 * NOTE: This parser does NOT accept `--permission-mode` -- that is the
 * US-007 acceptance criterion 7 invariant. `test/no-permission-mode-flag.test.ts`
 * greps this file for the literal `--permission-mode` and fails the build
 * if a parser registers it.
 */
export function parseShipArgs(args: string[]): { help: boolean; finalize: boolean; bump: boolean } | null {
	const result = { help: false, finalize: false, bump: false };
	for (const arg of args) {
		if (arg === '--help' || arg === '-h') {
			result.help = true;
			continue;
		}
		if (arg === '--finalize') {
			result.finalize = true;
			continue;
		}
		if (arg === '--bump') {
			result.bump = true;
			continue;
		}
		printError(`unknown ship option: ${arg}`);
		return null;
	}
	return result;
}

// ---------------------------------------------------------------------------
// cam ship dispatch (exported for unit testing with injectable deps)
// ---------------------------------------------------------------------------

/** Injectable deps for dispatchShip — all optional; production uses real impls. */
export interface ShipDispatchDeps {
	/** Inject a fake finalizeCycleClose wrapper; default: uses real fs + spawnSync. */
	finalizeFn?: () => FinalizeCycleCloseResult;
	/** Inject a fake runShipBump wrapper; default: uses real fs + spawnSync. */
	bumpFn?: () => ShipBumpResult;
	/** Inject a fake runShip; default: calls the real runShip({}) thin-proxy. */
	runShipFn?: () => Promise<number>;
}

/**
 * Route a parsed `cam ship` call:
 *   --finalize => finalizeCycleClose (in-process, no tmux needed)
 *   --bump     => runShipBump (in-process, DI'd spawnFn + clock)
 *   otherwise  => runShip thin-proxy
 *
 * Exported so unit tests can inject fakes for all branches.
 */
export async function dispatchShip(
	parsed: { help: boolean; finalize: boolean; bump: boolean },
	deps?: ShipDispatchDeps,
): Promise<number> {
	if (parsed.finalize) {
		const finalizeFn = deps?.finalizeFn ?? (() => finalizeCycleClose(buildShipFinalizeOpts(process.cwd())));
		try {
			finalizeFn();
			return 0;
		} catch (err) {
			printError(`cam ship --finalize failed: ${String(err)}`);
			return 1;
		}
	}
	if (parsed.bump) {
		const bumpFn = deps?.bumpFn ?? (() => runShipBump(buildShipBumpOpts(process.cwd())));
		try {
			bumpFn();
			return 0;
		} catch (err) {
			printError(`cam ship --bump failed: ${String(err)}`);
			return 1;
		}
	}
	const ship = deps?.runShipFn ?? (() => runShip({}));
	return ship();
}

// ---------------------------------------------------------------------------
// cam journal dispatch (exported for unit testing with injectable deps)
// ---------------------------------------------------------------------------

/**
 * Discriminated union returned by parseJournalArgs.
 * - mode === 'append': dispatch the journal append subcommand.
 * - mode === 'archive': dispatch the journal archive subcommand (no stdin).
 * - help === true: caller should print JOURNAL_HELP and exit 0.
 */
export type ParsedJournalArgs =
	| { mode: 'append'; force: boolean; cycleClose: boolean; help: false }
	| { mode: 'archive'; threshold: number; help: false }
	| { mode?: never; help: true };

const JOURNAL_USAGE =
	'Usage: cam journal append [--force] [--cycle-close]  (reads JSON from stdin)\n' +
	'       cam journal archive [--threshold N]';

export function parseJournalArgs(args: string[]): ParsedJournalArgs | null {
	if (args.includes('--help') || args.includes('-h')) {
		return { help: true };
	}
	const subCommand = args[0];
	if (subCommand === 'archive') {
		const rest = args.slice(1);
		const thresholdFlagIdx = rest.indexOf('--threshold');
		if (thresholdFlagIdx === -1) {
			return { mode: 'archive', threshold: JOURNAL_ARCHIVE_DEFAULT_THRESHOLD, help: false };
		}
		const rawValue = rest[thresholdFlagIdx + 1];
		const threshold = rawValue !== undefined ? Number(rawValue) : NaN;
		if (!Number.isInteger(threshold) || threshold <= 0) {
			printFatalHint('Usage: cam journal archive [--threshold N]  (N must be a positive integer)');
			return null;
		}
		return { mode: 'archive', threshold, help: false };
	}
	if (subCommand !== 'append') {
		printFatalHint(JOURNAL_USAGE);
		return null;
	}
	const rest = args.slice(1);
	const force = rest.includes('--force');
	const cycleClose = rest.includes('--cycle-close');
	return { mode: 'append', force, cycleClose, help: false };
}

/** Injectable deps for dispatchJournal -- all optional; production uses real impls. */
export interface JournalDispatchDeps {
	/** Injectable stdin reader. Default: `Bun.stdin.text()`. */
	readStdin?: () => Promise<string>;
	/**
	 * Injectable appendJournalEntryOnMain.
	 * Default: calls the real impl with process.cwd() and a real spawnSync.
	 */
	appendFn?: (entry: JournalCycleEntry, force: boolean) => AppendJournalEntryOnMainResult;
	/**
	 * Injectable archiveJournalOnMain, keyed by a threshold value.
	 * Default: calls the real impl with process.cwd() and a real spawnSync.
	 * Used on two paths, sharing one dep so tests and production stay in sync:
	 *   1. 'archive' mode: keyed by the parsed --threshold value.
	 *   2. --cycle-close (US-003): auto-invoked with the default threshold as
	 *      a best-effort check after CAM_JOURNAL_APPENDED + recordCycleTokens
	 *      and before the recycle marker is armed. Plain 'append' (no
	 *      --cycle-close) never calls this.
	 */
	archiveFn?: (threshold: number) => ArchiveJournalOnMainResult;
	/**
	 * Injectable archivePatternsOnMain (US-003, CAM-226). Auto-invoked, best-effort,
	 * on the --cycle-close path only, after the journal archiveFn check and strictly
	 * before the recycle marker is armed. Default: calls the real archivePatternsOnMain
	 * with process.cwd() and a real spawnSync (mirrors defaultArchiveFn).
	 */
	patternsArchiveFn?: () => ArchivePatternsOnMainResult;
	/** Injectable stdout writer. Default: `process.stdout.write`. */
	writeStdout?: (line: string) => void;
	/**
	 * Injectable: persist the per-cycle token accounting (US-001 cycle-tokens event).
	 * Called AFTER CAM_JOURNAL_APPENDED is written and BEFORE CAM_ORCH_HANDOFF_DUE
	 * is emitted -- sequence is load-bearing (durable memory saved before handoff).
	 * Default: calls recordCycleTokens with the parsed entry cycleId/issue and
	 * production cwd/claudeDir.
	 */
	recordCycleTokensFn?: () => void;
	/**
	 * Injectable: check whether the orchestrator handoff file
	 * `.claude/.cam-orch-handoff.json` exists.  Used on the --cycle-close path to
	 * enforce handoff-before-marker ordering.
	 * Default: `existsSync(join(process.cwd(), '.claude', '.cam-orch-handoff.json'))`.
	 */
	handoffExistsFn?: () => boolean;
	/**
	 * Injectable: write the recycle marker file `.claude/.cam-orch-recycle`.
	 * Called on the --cycle-close success path (handoff confirmed present AND
	 * watcher confirmed alive).
	 * Default: writes an empty file at `<cwd>/.claude/<ORCH_RECYCLE_MARKER>`.
	 */
	armRecycleMarkerFn?: () => void;
	/**
	 * Injectable: check whether the recycle watcher process is alive.
	 * On the --cycle-close path this guard sits between the handoff-exists check
	 * (exit 3) and the armMarker call: if no live watcher is found, the command
	 * prints an actionable error (naming the missing pid file and the manual
	 * /exit fallback) and returns exit code 4.
	 * Default: `watcherAlive(join(process.cwd(), '.claude'))` (reads
	 * `.claude/.cam-watcher.pid` + signal-0 probe).
	 */
	watcherAliveFn?: () => boolean;
}

/**
 * Default archiveFn: the real archiveJournalOnMain with process.cwd() and a
 * real spawnSync. Shared by the 'archive' mode dispatch and the --cycle-close
 * auto-invoked check (US-003) so both paths fall back to the same production
 * behavior when a test/caller does not inject `deps.archiveFn`.
 */
function defaultArchiveFn(threshold: number): ArchiveJournalOnMainResult {
	return archiveJournalOnMain({
		cwd: process.cwd(),
		spawnFn: (cmd, args, opts) =>
			spawnSync(cmd, args, { ...opts, stdio: 'pipe' }) as SpawnSyncReturns<string>,
		threshold,
	});
}

/**
 * Route a parsed `cam journal` call.  Exported so unit tests can inject fakes
 * for stdin, appendFn, and writeStdout to verify sentinel emission, the
 * invalid-JSON guard, and --force propagation without touching real git or I/O.
 */
export async function dispatchJournal(
	parsed: ParsedJournalArgs,
	deps?: JournalDispatchDeps,
): Promise<number> {
	if (parsed.help) {
		process.stdout.write(JOURNAL_HELP);
		return 0;
	}
	const writeStdout =
		deps?.writeStdout ?? ((line: string) => { process.stdout.write(line); });

	// 'archive' branches BEFORE any stdin read: it takes no input and must not
	// block waiting on a stdin stream the caller never intends to provide.
	if (parsed.mode === 'archive') {
		const archiveFn = deps?.archiveFn ?? defaultArchiveFn;
		const archiveResult = archiveFn(parsed.threshold);
		if (!archiveResult.ok) {
			// printError already fired inside archiveJournalOnMain
			return 1;
		}
		if (archiveResult.archived === 0) {
			writeStdout(
				`CAM_JOURNAL_ARCHIVE=noop entries=${archiveResult.entries} threshold=${parsed.threshold}\n`,
			);
			return 0;
		}
		writeStdout(`CAM_JOURNAL_ARCHIVED=${archiveResult.archived} sha=${archiveResult.sha}\n`);
		return 0;
	}

	const readStdin = deps?.readStdin ?? (() => Bun.stdin.text());

	const stdinText = await readStdin();
	let journalEntry: JournalCycleEntry;
	try {
		journalEntry = JSON.parse(stdinText) as JournalCycleEntry;
	} catch (err) {
		printError(`cam journal append: invalid JSON from stdin: ${String(err)}`);
		return 1;
	}

	const journalResult: AppendJournalEntryOnMainResult = deps?.appendFn
		? deps.appendFn(journalEntry, parsed.force)
		: appendJournalEntryOnMain({
				cwd: process.cwd(),
				entry: journalEntry,
				spawnFn: (cmd, args, opts) =>
					spawnSync(cmd, args, { ...opts, stdio: 'pipe' }) as SpawnSyncReturns<string>,
				force: parsed.force,
		  });

	if (!journalResult.ok) {
		// printError already fired inside appendJournalEntryOnMain
		return 1;
	}

	writeStdout(`CAM_JOURNAL_APPENDED=${journalResult.cycleId} sha=${journalResult.sha}\n`);

	// US-002: persist per-cycle token accounting before emitting the handoff signal.
	// Sequence is load-bearing: journal entry persisted -> cycle-tokens persisted -> THEN handoff.
	const recordFn =
		deps?.recordCycleTokensFn ??
		(() => {
			recordCycleTokens({
				cycleId: journalEntry.cycleId,
				issueNumber: journalEntry.issue,
				cwd: process.cwd(),
				claudeDir: process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude'),
			});
		});
	recordFn();

	// --cycle-close: arm the recycle marker only when the handoff is already present.
	// Ordering is load-bearing: marker must not be written before the handoff exists,
	// so the sidecar recycle is only triggered on genuine end-of-cycle transitions.
	if (parsed.cycleClose) {
		const handoffExists =
			deps?.handoffExistsFn !== undefined
				? deps.handoffExistsFn()
				: existsSync(join(process.cwd(), '.claude', '.cam-orch-handoff.json'));
		if (!handoffExists) {
			printError(
				'cam journal append --cycle-close: handoff file absent (.claude/.cam-orch-handoff.json); ' +
					'write the cycle-close handoff before arming the recycle marker.',
			);
			return 3;
		}
		const isWatcherAlive =
			deps?.watcherAliveFn !== undefined
				? deps.watcherAliveFn()
				: watcherAlive(join(process.cwd(), '.claude'));
		if (!isWatcherAlive) {
			printError(
				'cam journal append --cycle-close: no live recycle watcher ' +
					'(.claude/.cam-watcher.pid absent or process dead); ' +
					'use /exit manually or start cam run to restart the watcher.',
			);
			return 4;
		}

		// US-003: auto-invoke the archive check (default threshold) at cycle
		// close, deterministically -- no operator/orchestrator discretion.
		// Ordering is load-bearing: strictly AFTER CAM_JOURNAL_APPENDED +
		// recordCycleTokens (both already ran above), strictly BEFORE the
		// marker is armed and CAM_ORCH_HANDOFF_DUE is emitted, because once the
		// marker is armed the watcher can SIGTERM this process mid-archive.
		// Best-effort: a throw or ok:false logs a warning only -- it must never
		// change dispatchJournal's exit code or block marker arming / handoff.
		const archiveFn = deps?.archiveFn ?? defaultArchiveFn;
		try {
			const archiveResult = archiveFn(JOURNAL_ARCHIVE_DEFAULT_THRESHOLD);
			if (!archiveResult.ok) {
				printWarning(
					`cam journal append --cycle-close: archive check failed (${archiveResult.reason}); continuing`,
				);
			}
		} catch (err) {
			printWarning(`cam journal append --cycle-close: archive check threw; continuing: ${String(err)}`);
		}

		// US-003 (CAM-226): auto-invoke the patterns archive check, mirroring the
		// journal archive check above -- same ordering guarantee (strictly before
		// armMarker, since the watcher can SIGTERM this process once the marker is
		// armed) and the same best-effort contract (a throw or ok:false only logs
		// a warning, never changes the exit code or blocks the marker/handoff).
		const patternsArchiveFn = deps?.patternsArchiveFn ?? defaultPatternsArchiveFn;
		try {
			const patternsArchiveResult = patternsArchiveFn();
			if (!patternsArchiveResult.ok) {
				printWarning(
					`cam journal append --cycle-close: patterns archive check failed (${patternsArchiveResult.reason}); continuing`,
				);
			}
		} catch (err) {
			printWarning(
				`cam journal append --cycle-close: patterns archive check threw; continuing: ${String(err)}`,
			);
		}

		const armMarker =
			deps?.armRecycleMarkerFn ??
			(() => {
				const claudeDir = join(process.cwd(), '.claude');
				mkdirSync(claudeDir, { recursive: true });
				writeFileSync(join(claudeDir, ORCH_RECYCLE_MARKER), '', 'utf8');
			});
		armMarker();
	}

	// Unconditional handoff signal: no token threshold, fired strictly after durable writes.
	writeStdout('CAM_ORCH_HANDOFF_DUE=true\n');
	return 0;
}

// ---------------------------------------------------------------------------
// cam patterns dispatch (exported for unit testing with injectable deps)
// ---------------------------------------------------------------------------

/**
 * Discriminated union returned by parsePatternsArgs.
 * - mode === 'archive': dispatch the patterns archive subcommand.
 * - help === true: caller should print PATTERNS_HELP and exit 0. This is the
 *   default for both `--help`/`-h` AND no subcommand at all (unlike
 *   parseJournalArgs, which errors on a bare `cam journal`): patterns has a
 *   single subcommand, so a bare `cam patterns` showing usage is more useful
 *   than an error.
 */
export type ParsedPatternsArgs =
	| { mode: 'archive'; help: false }
	| { mode?: never; help: true };

const PATTERNS_USAGE = 'Usage: cam patterns archive';

export function parsePatternsArgs(args: string[]): ParsedPatternsArgs | null {
	if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
		return { help: true };
	}
	const subCommand = args[0];
	if (subCommand !== 'archive') {
		printFatalHint(PATTERNS_USAGE);
		return null;
	}
	return { mode: 'archive', help: false };
}

/** Injectable deps for dispatchPatterns -- all optional; production uses real impls. */
export interface PatternsDispatchDeps {
	/**
	 * Injectable archivePatternsOnMain.
	 * Default: calls the real impl with process.cwd() and a real spawnSync.
	 */
	archiveFn?: () => ArchivePatternsOnMainResult;
	/** Injectable stdout writer. Default: `process.stdout.write`. */
	writeStdout?: (line: string) => void;
}

/**
 * Default archiveFn: the real archivePatternsOnMain with process.cwd() and a
 * real spawnSync.
 */
function defaultPatternsArchiveFn(): ArchivePatternsOnMainResult {
	return archivePatternsOnMain({
		cwd: process.cwd(),
		spawnFn: (cmd, args, opts) =>
			spawnSync(cmd, args, { ...opts, stdio: 'pipe' }) as SpawnSyncReturns<string>,
	});
}

/**
 * Route a parsed `cam patterns` call. Exported so unit tests can inject fakes
 * for archiveFn and writeStdout to verify sentinel emission and exit codes
 * without touching real git or stdout. No --threshold arg: archival is
 * marker-based (see RESOLVED_MARKER_RE in src/commands/patterns-archive.ts),
 * not count-based.
 */
export function dispatchPatterns(
	parsed: ParsedPatternsArgs,
	deps?: PatternsDispatchDeps,
): number {
	if (parsed.help) {
		process.stdout.write(PATTERNS_HELP);
		return 0;
	}
	const writeStdout =
		deps?.writeStdout ?? ((line: string) => { process.stdout.write(line); });

	const archiveFn = deps?.archiveFn ?? defaultPatternsArchiveFn;
	const result = archiveFn();
	if (!result.ok) {
		// printError already fired inside archivePatternsOnMain
		return 1;
	}
	if (result.archived === 0) {
		writeStdout('CAM_PATTERNS_ARCHIVE=noop\n');
		return 0;
	}
	writeStdout(`CAM_PATTERNS_ARCHIVED=${result.archived} sha=${result.sha}\n`);
	return 0;
}

// ---------------------------------------------------------------------------
// cam suggestions dispatch (exported for unit testing with injectable deps)
// ---------------------------------------------------------------------------

/**
 * Discriminated union returned by parseSuggestionsArgs.
 * - mode === 'list': dispatch the suggestions list subcommand.
 * - mode === 'promote'/'dismiss': dispatch the matching triage subcommand for
 *   the given fingerprint (US-005, CAM-285).
 * - help === true: caller should print SUGGESTIONS_HELP and exit 0. This is
 *   the default for both `--help`/`-h` AND no subcommand at all (mirrors
 *   parsePatternsArgs: showing usage is more useful than an error).
 */
export type ParsedSuggestionsArgs =
	| { mode: 'list'; help: false }
	| { mode: 'promote'; help: false; fingerprint: string }
	| { mode: 'dismiss'; help: false; fingerprint: string }
	| { mode?: never; help: true };

const SUGGESTIONS_USAGE =
	'Usage: cam suggestions list|promote <fingerprint>|dismiss <fingerprint>';

export function parseSuggestionsArgs(args: string[]): ParsedSuggestionsArgs | null {
	if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
		return { help: true };
	}
	const subCommand = args[0];
	if (subCommand === 'list') {
		const rest = args.slice(1);
		if (rest.length > 0) {
			printFatalHint(SUGGESTIONS_USAGE);
			return null;
		}
		return { mode: 'list', help: false };
	}
	if (subCommand === 'promote' || subCommand === 'dismiss') {
		const rest = args.slice(1);
		const fingerprint = rest[0];
		if (fingerprint === undefined || rest.length > 1) {
			printFatalHint(SUGGESTIONS_USAGE);
			return null;
		}
		return { mode: subCommand, help: false, fingerprint };
	}
	printFatalHint(SUGGESTIONS_USAGE);
	return null;
}

/** Injectable deps for dispatchSuggestions -- all optional; production uses real impls. */
export interface SuggestionsDispatchDeps {
	/**
	 * Injectable readSuggestionsFromMain.
	 * Default: calls the real impl with process.cwd() and a real spawnSync.
	 */
	readFn?: () => SuggestionEntry[];
	/**
	 * Injectable promoteSuggestionOnMain.
	 * Default: calls the real impl with process.cwd(), a real spawnSync, a
	 * real clock, and readProjectToml reading scripts/cam/project.toml.
	 */
	promoteFn?: (fingerprint: string) => PromoteSuggestionOnMainResult;
	/**
	 * Injectable dismissSuggestionOnMain.
	 * Default: calls the real impl with process.cwd() and a real spawnSync.
	 */
	dismissFn?: (fingerprint: string) => DismissSuggestionOnMainResult;
	/** Injectable stdout writer. Default: `process.stdout.write`. */
	writeStdout?: (line: string) => void;
}

/**
 * Default readFn: the real readSuggestionsFromMain with process.cwd() and a
 * real spawnSync.
 */
function defaultReadSuggestionsFn(): SuggestionEntry[] {
	return readSuggestionsFromMain(process.cwd(), (cmd, args, opts) =>
		spawnSync(cmd, args, { ...opts, stdio: 'pipe' }) as SpawnSyncReturns<string>,
	);
}

/** Injectable-friendly wrapper for the real spawnSync, shared by promote/dismiss defaults. */
function realSuggestionsSpawnFn(
	cmd: string,
	args: string[],
	opts: { encoding: 'utf8'; env?: Record<string, string>; input?: string },
): SpawnSyncReturns<string> {
	return spawnSync(cmd, args, { ...opts, stdio: 'pipe' }) as SpawnSyncReturns<string>;
}

/**
 * Default promoteFn: the real promoteSuggestionOnMain with process.cwd(), a
 * real spawnSync, a real clock, and readProjectToml reading the project's
 * scripts/cam/project.toml (same wiring `cam issue --file-local` uses).
 */
function defaultPromoteSuggestionFn(fingerprint: string): PromoteSuggestionOnMainResult {
	const cwd = process.cwd();
	return promoteSuggestionOnMain({
		cwd,
		fingerprint,
		spawnFn: realSuggestionsSpawnFn,
		clock: () => new Date().toISOString(),
		readProjectToml: () => readFileSync(join(cwd, 'scripts/cam/project.toml'), 'utf8'),
	});
}

/**
 * Default dismissFn: the real dismissSuggestionOnMain with process.cwd() and
 * a real spawnSync.
 */
function defaultDismissSuggestionFn(fingerprint: string): DismissSuggestionOnMainResult {
	return dismissSuggestionOnMain({
		cwd: process.cwd(),
		fingerprint,
		spawnFn: realSuggestionsSpawnFn,
	});
}

/**
 * Route a parsed `cam suggestions` call. Exported so unit tests can inject
 * fakes for readFn/promoteFn/dismissFn and writeStdout to verify rendering,
 * mutation outcomes, and exit codes without touching real git or stdout.
 */
export function dispatchSuggestions(
	parsed: ParsedSuggestionsArgs,
	deps?: SuggestionsDispatchDeps,
): number {
	if (parsed.help) {
		process.stdout.write(SUGGESTIONS_HELP);
		return 0;
	}
	const writeStdout =
		deps?.writeStdout ?? ((line: string) => { process.stdout.write(line); });

	if (parsed.mode === 'promote') {
		const promoteFn = deps?.promoteFn ?? defaultPromoteSuggestionFn;
		const result = promoteFn(parsed.fingerprint);
		if (!result.ok) {
			// printError already fired inside promoteSuggestionOnMain.
			return 1;
		}
		printHint(
			`promoted ${result.fingerprint} -> filed ${result.issueId} on main (${result.sha})`,
		);
		writeStdout(`CAM_SUGGESTIONS_PROMOTED=${result.fingerprint} issue=${result.issueId}\n`);
		return 0;
	}

	if (parsed.mode === 'dismiss') {
		const dismissFn = deps?.dismissFn ?? defaultDismissSuggestionFn;
		const result = dismissFn(parsed.fingerprint);
		if (!result.ok) {
			// printError already fired inside dismissSuggestionOnMain.
			return 1;
		}
		printHint(`dismissed ${result.fingerprint} from the pen (${result.sha})`);
		writeStdout(`CAM_SUGGESTIONS_DISMISSED=${result.fingerprint}\n`);
		return 0;
	}

	const readFn = deps?.readFn ?? defaultReadSuggestionsFn;
	const entries = readFn();

	writeStdout('cam suggestions list\n\n');
	if (entries.length === 0) {
		writeStdout('No pending SUGGESTIONs in the pen.\n\n');
		return 0;
	}
	for (const entry of entries) {
		const roundSuffix = entry.reviewRound !== undefined ? ` round ${entry.reviewRound}` : '';
		writeStdout(`${entry.fingerprint}  ${entry.title}  (${entry.sourceBranch}${roundSuffix})\n`);
	}
	writeStdout('\n');
	return 0;
}

// ---------------------------------------------------------------------------
// cam issue dispatch (exported for unit testing with injectable deps)
// ---------------------------------------------------------------------------

/** Injectable deps for dispatchIssue — all optional; production uses real impls. */
export interface IssueDispatchDeps {
	/**
	 * Inject a fake for the WHOLE --file-local branch (full bypass). Default:
	 * reads stdin as JSON and routes to createLocalIssueOnMain (in-process, no
	 * tmux). Takes priority over `createLocalIssueOnMainFn`/`readStdinFn` below
	 * when present, preserving the existing branch-isolation tests (US-003).
	 */
	fileLocalFn?: () => Promise<number>;
	/**
	 * Inject a fake for the --file-local branch's underlying createLocalIssueOnMain
	 * call. Only consulted when `fileLocalFn` is absent. Default:
	 * `createLocalIssueOnMain(_buildCreateIssueOpts(process.cwd(), stdinData, flags))`
	 * (production spawnFn+clock). The printing (printHint on success, the machine
	 * CAM_ISSUE_RESULT line) and exit-code mapping always run in dispatchIssue
	 * itself, regardless of injection (US-001, CAM-212).
	 */
	createLocalIssueOnMainFn?: (
		stdinData: FileLocalStdinPayload,
		flags: { specSource?: 'grill' | 'derived' | 'operator'; derivedFrom?: string[] },
	) => CreateLocalIssueOnMainOutcome;
	/**
	 * Inject a fake stdin-text reader for the --file-local branch. Only
	 * consulted when `fileLocalFn` is absent. Default: `Bun.stdin.text()`.
	 */
	readStdinFn?: () => Promise<string>;
	/** Inject a fake runIssue thin-proxy. Default: calls the real runIssue with the parsed text. */
	runIssueFn?: () => Promise<number>;
	/**
	 * Inject a fake for the `list` branch. Default: calls the real runIssueList
	 * in-process (no tmux, no thin-proxy, no claude spawn).
	 */
	issueListFn?: () => Promise<number>;
	/**
	 * Inject a fake for the `close <id>` branch's underlying closeIssueOnMain
	 * call. Default: `defaultCloseIssueFn(process.cwd(), id)` (production
	 * spawnFn+clock; reuses the same wiring as ship-pr.ts/sidecar.ts to avoid
	 * duplicating the real-spawnSync closure). The printing (printHint on
	 * success, the machine CAM_ISSUE_RESULT line) and exit-code mapping always
	 * run in dispatchIssue itself, regardless of injection (US-002).
	 */
	closeIssueOnMainFn?: (id: string) => CloseIssueOnMainOutcome;
	/**
	 * Inject a fake for the `abandon <id>` branch's underlying abandonIssueOnMain
	 * call. Default: `defaultAbandonIssueFn(process.cwd(), id)` (production
	 * spawnFn+clock; mirrors closeIssueOnMainFn's wiring). The printing (printHint
	 * on success, the machine CAM_ISSUE_RESULT line) and exit-code mapping always
	 * run in dispatchIssue itself, regardless of injection (US-003).
	 */
	abandonIssueOnMainFn?: (id: string) => AbandonIssueOnMainOutcome;
	/**
	 * Inject a fake for the `demote <id>` branch's underlying demoteIssueOnMain
	 * call. Default: `defaultDemoteIssueFn(process.cwd(), id)` (production
	 * spawnFn+clock; mirrors closeIssueOnMainFn/abandonIssueOnMainFn's wiring).
	 * The printing (printHint on success, the machine CAM_ISSUE_RESULT line)
	 * and exit-code mapping always run in dispatchIssue itself, regardless of
	 * injection (US-002, CAM-210).
	 */
	demoteIssueOnMainFn?: (id: string) => DemoteIssueOnMainOutcome;
}

/** Shape of the JSON payload `cam issue --file-local` reads from stdin. */
type FileLocalStdinPayload = {
	title: string;
	description?: string;
	priority?: string;
	wsjf?: WsjfScore;
};

/** Build production CreateLocalIssueOnMainOptions from project root + parsed stdin JSON + CLI flags. */
function _buildCreateIssueOpts(
	cwd: string,
	parsedStdin: FileLocalStdinPayload,
	flags?: { specSource?: 'grill' | 'derived' | 'operator'; derivedFrom?: string[] },
): CreateLocalIssueOnMainOptions {
	return {
		cwd,
		title: parsedStdin.title,
		...(parsedStdin.description !== undefined ? { description: parsedStdin.description } : {}),
		...(parsedStdin.priority !== undefined ? { priority: parsedStdin.priority } : {}),
		...(parsedStdin.wsjf !== undefined ? { wsjf: parsedStdin.wsjf } : {}),
		...(flags?.specSource !== undefined ? { specSource: flags.specSource } : {}),
		...(flags?.derivedFrom !== undefined && flags.derivedFrom.length > 0 ? { derivedFrom: flags.derivedFrom } : {}),
		spawnFn: realOnMainSpawnFn,
		clock: () => new Date().toISOString(),
		readProjectToml: () => readFileSync(join(cwd, 'scripts/cam/project.toml'), 'utf8'),
	};
}

/**
 * Default --file-local implementation: reads stdin as JSON, routes to
 * createLocalIssueOnMain, and owns the CAM_ISSUE_RESULT machine-line
 * convention for every outcome (CAM-212 retrofit, mirrors close/abandon).
 *
 *   - unparseable stdin JSON: CAM_ISSUE_RESULT=ERROR reason=invalid-json,
 *     emitted BEFORE createLocalIssueOnMainFn runs (invalid-json is a
 *     file-local-specific token, not a member of CreateLocalIssueOnMainOutcome).
 *   - createLocalIssueOnMainFn returns { ok: false, reason }: the pre-existing
 *     printError already fired inside createLocalIssueOnMain; this function
 *     additionally emits CAM_ISSUE_RESULT=ERROR reason=<reason>.
 *   - the create path throws: CAM_ISSUE_RESULT=ERROR reason=exception.
 *   - success: the pre-existing printHint plus CAM_ISSUE_RESULT=<id>.
 */
async function runFileLocalDefault(
	parsed: Extract<ParsedIssueArgs, { mode: 'file-local' }>,
	deps?: IssueDispatchDeps,
): Promise<number> {
	const readStdin = deps?.readStdinFn ?? (() => Bun.stdin.text());
	const stdinText = await readStdin();
	let stdinData: FileLocalStdinPayload;
	try {
		stdinData = JSON.parse(stdinText) as FileLocalStdinPayload;
	} catch (err) {
		printError(`cam issue --file-local: invalid JSON from stdin: ${String(err)}`);
		process.stdout.write('CAM_ISSUE_RESULT=ERROR reason=invalid-json\n');
		return 1;
	}
	// Derive specSource from CLI flags (never from content heuristics).
	const specSource: 'operator' | 'derived' | undefined = parsed.fastTrack
		? 'operator'
		: parsed.derivedFrom.length > 0
			? 'derived'
			: undefined;
	const flags = {
		...(specSource !== undefined ? { specSource } : {}),
		...(parsed.derivedFrom.length > 0 ? { derivedFrom: parsed.derivedFrom } : {}),
	};
	const createLocalIssueOnMainFn =
		deps?.createLocalIssueOnMainFn ??
		((data, f) => createLocalIssueOnMain(_buildCreateIssueOpts(process.cwd(), data, f)));
	try {
		const result = createLocalIssueOnMainFn(stdinData, flags);
		if (!result.ok) {
			// printError already fired inside createLocalIssueOnMain
			process.stdout.write(`CAM_ISSUE_RESULT=ERROR reason=${result.reason}\n`);
			return 1;
		}
		printHint(`filed ${result.id} on main (${result.sha})`);
		process.stdout.write(`CAM_ISSUE_RESULT=${result.id}\n`);
		return 0;
	} catch (err) {
		printError(`cam issue --file-local failed: ${String(err)}`);
		process.stdout.write('CAM_ISSUE_RESULT=ERROR reason=exception\n');
		return 1;
	}
}

/**
 * Route a parsed `cam issue` call: --file-local => createLocalIssueOnMain (in-process,
 * reads stdin as JSON, no tmux needed); otherwise => runIssue thin-proxy. Exported so
 * unit tests can inject fakes for both branches and prove the --file-local path NEVER
 * calls runIssue.
 */
export async function dispatchIssue(
	parsed: ParsedIssueArgs,
	deps?: IssueDispatchDeps,
): Promise<number> {
	if (parsed.mode === 'list') {
		// Deliberate design decision (US-002, CAM-212), not a forgotten path:
		// CAM_ISSUE_RESULT is a mutation-outcome contract (it carries the id of
		// the single acted-on issue, or ERROR, for a command that creates,
		// closes, or abandons ONE issue). `list` is a read over MANY issues with
		// no single id to report, so it emits NO CAM_ISSUE_RESULT line on any
		// code path; its handback is the rendered table plus the process exit
		// code alone. Do not retrofit a machine line here.
		const issueListFn =
			deps?.issueListFn ??
			(async () => runIssueList({ cwd: process.cwd(), all: parsed.all, json: parsed.json }));
		return issueListFn();
	}
	if (parsed.mode === 'close') {
		const closeIssueOnMainFn =
			deps?.closeIssueOnMainFn ?? ((id: string) => defaultCloseIssueFn(process.cwd(), id));
		const result = closeIssueOnMainFn(parsed.id);
		if (!result.ok) {
			printError(`cam issue close ${parsed.id} failed: ${result.reason}`);
			process.stdout.write(`CAM_ISSUE_RESULT=ERROR reason=${result.reason}\n`);
			return 1;
		}
		printHint(`closed ${result.id} on main (${result.sha})`);
		process.stdout.write(`CAM_ISSUE_RESULT=${result.id}\n`);
		return 0;
	}
	if (parsed.mode === 'abandon') {
		const abandonIssueOnMainFn =
			deps?.abandonIssueOnMainFn ?? ((id: string) => defaultAbandonIssueFn(process.cwd(), id));
		const result = abandonIssueOnMainFn(parsed.id);
		if (!result.ok) {
			printError(`cam issue abandon ${parsed.id} failed: ${result.reason}`);
			process.stdout.write(`CAM_ISSUE_RESULT=ERROR reason=${result.reason}\n`);
			return 1;
		}
		printHint(`abandoned ${result.id} on main (${result.sha})`);
		process.stdout.write(`CAM_ISSUE_RESULT=${result.id}\n`);
		return 0;
	}
	if (parsed.mode === 'demote') {
		const demoteIssueOnMainFn =
			deps?.demoteIssueOnMainFn ?? ((id: string) => defaultDemoteIssueFn(process.cwd(), id));
		const result = demoteIssueOnMainFn(parsed.id);
		if (!result.ok) {
			printError(`cam issue demote ${parsed.id} failed: ${result.reason}`);
			process.stdout.write(`CAM_ISSUE_RESULT=ERROR reason=${result.reason}\n`);
			return 1;
		}
		printHint(`demoted ${result.id} on main (${result.sha})`);
		process.stdout.write(`CAM_ISSUE_RESULT=${result.id}\n`);
		return 0;
	}
	if (parsed.mode === 'file-local') {
		// `fileLocalFn` (whole-branch override) takes priority when present,
		// preserving the pre-CAM-212 branch-isolation tests (US-003). The
		// finer-grained default below owns the CAM_ISSUE_RESULT machine-line
		// convention regardless of whether `createLocalIssueOnMainFn`/
		// `readStdinFn` are individually injected.
		const fileLocalFn = deps?.fileLocalFn ?? (() => runFileLocalDefault(parsed, deps));
		return fileLocalFn();
	}
	// Free-text thin-proxy path (text mode or unexpected help=true — help is handled in main()).
	const text = parsed.mode === 'text' ? parsed.text : '';
	const issueFn = deps?.runIssueFn ?? (() => runIssue({ text }));
	return issueFn();
}

// ---------------------------------------------------------------------------
// cam triage dispatch (exported for unit testing with injectable deps)
// ---------------------------------------------------------------------------

/** Injectable deps for dispatchTriage -- optional; production uses real impl. */
export interface TriageDispatchDeps {
	/**
	 * Inject a fake runTriage wrapper; default: calls the real runTriage with
	 * process.cwd() and a production spawnSync.
	 */
	triageFn?: () => TriageResult;
}

/**
 * Route a `cam triage` call.  Always calls runTriage in-process (no tmux needed).
 * Exported so unit tests can inject a fake triageFn and assert exit codes.
 */
export function dispatchTriage(deps?: TriageDispatchDeps): number {
	const triageFn =
		deps?.triageFn ??
		(() =>
			runTriage({
				cwd: process.cwd(),
				spawnFn: realOnMainSpawnFn,
				clock: () => new Date().toISOString(),
			}));

	const result = triageFn();
	return result.ok ? 0 : 1;
}

/**
 * Single source of truth for the CLI's command set (US-001, CAM-278).
 * Every command dispatched by `main()` — including the internal/hidden ones
 * spawned by `cam run` (sidecar, orch-recycle-watch, sidecar-liveness-watch,
 * retry-monitor) — MUST be listed here exactly once. `HELP_REGISTRY` and the
 * dispatch `switch` below are both typed against `Command`, so adding a
 * command to `COMMANDS` without a matching `HELP_REGISTRY` entry or switch
 * case now fails `bun run typecheck` instead of silently re-opening the
 * CAM-211 `--help` footgun.
 */
const COMMANDS = [
	'init',
	'setup',
	'config',
	'run',
	'plan',
	'spec',
	'issue',
	'next',
	'review',
	'ship',
	'tag',
	'dashboard',
	'status',
	'orch-budget',
	'stop',
	'drain',
	'resume',
	'claude',
	'sidecar',
	'orch-recycle-watch',
	'sidecar-liveness-watch',
	'retry-monitor',
	'journal',
	'patterns',
	'triage',
	'suggestions',
] as const;

type Command = (typeof COMMANDS)[number];

/**
 * Type guard narrowing a raw argv token to `Command`. Used in `main()` to
 * narrow `argv[2]` BEFORE the dispatch switch, so the "unknown command"
 * branch can live ahead of the switch instead of in its `default:` case.
 */
function isCommand(value: string): value is Command {
	return (COMMANDS as readonly string[]).includes(value);
}

/**
 * Central --help/-h registry (US-001, CAM-211). Maps every registered
 * command name to its help text. This is the single source of truth the
 * dispatch guard below reads from: a command showing up in a `switch (command)`
 * case but missing here means `--help` falls through un-guarded for it, so
 * every case (including the internal ones spawned by `cam run`) MUST have an
 * entry. Retyped to `Record<Command, string>` (US-001, CAM-278): a `Command`
 * added to `COMMANDS` without an entry here now fails typecheck.
 */
const HELP_REGISTRY: Record<Command, string> = {
	init: INIT_HELP,
	setup: INIT_HELP,
	config: CONFIG_HELP,
	run: RUN_HELP,
	plan: PLAN_HELP,
	spec: SPEC_HELP,
	issue: ISSUE_HELP,
	next: NEXT_HELP,
	review: REVIEW_HELP,
	ship: SHIP_HELP,
	tag: TAG_HELP,
	dashboard: DASHBOARD_HELP,
	status: STATUS_HELP,
	'orch-budget': ORCH_BUDGET_HELP,
	stop: STOP_HELP,
	drain: DRAIN_HELP,
	resume: RESUME_HELP,
	claude: CLAUDE_HELP,
	sidecar: SIDECAR_HELP,
	'orch-recycle-watch': ORCH_RECYCLE_WATCH_HELP,
	'sidecar-liveness-watch': SIDECAR_LIVENESS_WATCH_HELP,
	'retry-monitor': RETRY_MONITOR_HELP,
	journal: JOURNAL_HELP,
	patterns: PATTERNS_HELP,
	triage: TRIAGE_HELP,
	suggestions: SUGGESTIONS_HELP,
};

/**
 * Decide whether a `--help`/`-h` in `tail` (argv after the command name)
 * short-circuits the given command. Every command matches anywhere-in-tail
 * (mirrors the per-command parsers this guard supersedes), EXCEPT `claude`:
 * `cam claude` forwards all args verbatim to the child claude process and
 * only treats a LEADING --help/-h as its own (see parseClaudeArgs in
 * src/commands/claude.ts) — a blanket anywhere-match here would over-capture
 * a `--help` the operator meant to forward to claude itself (US-001 AC5).
 */
export function isHelpRequested(command: string, tail: string[]): boolean {
	if (command === 'claude') {
		return tail[0] === '--help' || tail[0] === '-h';
	}
	return tail.includes('--help') || tail.includes('-h');
}

async function main(argv: string[]): Promise<number> {
	const command = argv[2];
	if (!command || command === 'help' || command === '--help' || command === '-h') {
		process.stdout.write(HELP);
		return 0;
	}
	// `cam --version` / `cam -v` / `cam version`. We accept all three
	// because Unix CLIs are inconsistent about which form is canonical and
	// shipping just one would surprise muscle memory. The output shape is
	// `cam 0.1.0` (single line, trailing newline).
	if (command === '--version' || command === '-v' || command === 'version') {
		// `cam --version` is a machine-readable contract: emit exactly
		// `cam X.Y.Z\n` so scripts piping into `head -1` or doing `==`
		// comparisons keep working. The "leading/trailing blank line"
		// convention applies to human-facing screens, not to version probes.
		process.stdout.write(`cam ${CAM_VERSION}\n`);
		return 0;
	}

	// Narrow argv[2] to Command BEFORE the dispatch switch (US-001, CAM-278).
	// This is where "unknown command" is now reported — moved ahead of the
	// switch's `default:`, which is exhaustiveness-only from here on.
	if (!isCommand(command)) {
		printError(`unknown command: ${command}`);
		printFatalHint('run `cam help` to see the available commands');
		return 1;
	}

	// Central --help/-h short-circuit (US-001, CAM-211): runs BEFORE the
	// command switch body, for every registered command. This is the fix for
	// the CAM-211 footgun — `cam sidecar --help` (and the other internal
	// commands) previously ran straight into their body with zero guard.
	const dispatchTail = argv.slice(3);
	if (isHelpRequested(command, dispatchTail)) {
		const helpText = HELP_REGISTRY[command];
		if (helpText !== undefined) {
			process.stdout.write(helpText);
			return 0;
		}
	}

	switch (command) {
		case 'init': {
			const setupArgs = parseSetupArgs(argv.slice(3));
			if (setupArgs === null) {
				printFatalHint('run `cam init --help` for usage');
				return 1;
			}
			if (setupArgs.help) {
				process.stdout.write(INIT_HELP);
				return 0;
			}
			const machineCode = await runInit();
			if (machineCode !== 0) return machineCode;
			return runSetup({
				projectMode: setupArgs.projectMode,
				issueSystem: setupArgs.issueSystem,
				mergeMode: setupArgs.mergeMode,
				planApproval: setupArgs.planApproval,
				description: setupArgs.description,
				noTmux: setupArgs.noTmux,
			});
		}
		case 'setup': {
			// Skip Stage 1 (machine validation) — exposes the SetupScreen directly
			// for previewing/iterating on its layout without re-running `cam init`.
			// Accepts the same flags as `cam init` Stage 2.
			const setupArgs = parseSetupArgs(argv.slice(3));
			if (setupArgs === null) {
				printFatalHint('run `cam init --help` for usage (setup shares its flags)');
				return 1;
			}
			if (setupArgs.help) {
				process.stdout.write(INIT_HELP);
				return 0;
			}
			return runSetup({
				projectMode: setupArgs.projectMode,
				issueSystem: setupArgs.issueSystem,
				mergeMode: setupArgs.mergeMode,
				planApproval: setupArgs.planApproval,
				description: setupArgs.description,
				noTmux: setupArgs.noTmux,
			});
		}
		case 'config': {
			const tail = argv.slice(3);
			const showFlag = tail.includes('--show');
			const unknownFlags = tail.filter((a) => a !== '--show');
			if (unknownFlags.length > 0) {
				printError(`unknown config option: ${unknownFlags[0]}`);
				printFatalHint('run `cam config --help` for usage');
				return 1;
			}
			return runConfig({ show: showFlag });
		}
		case 'run': {
			const parsed = parseRunArgs(argv.slice(3));
			if (parsed === null) {
				printFatalHint('run `cam run --help` for usage');
				return 1;
			}
			if (parsed.help) {
				process.stdout.write(RUN_HELP);
				return 0;
			}
			return runRun({ noAttach: parsed.noAttach });
		}
		case 'plan': {
			const parsed = parsePlanArgs(argv.slice(3));
			if (parsed === null) {
				printFatalHint('run `cam plan --help` for usage');
				return 1;
			}
			if (parsed.help) {
				process.stdout.write(PLAN_HELP);
				return 0;
			}
			return runPlan({ issue: parsed.issue });
		}
		case 'spec': {
			const parsed = parseSpecArgs(argv.slice(3));
			if (parsed === null) {
				printFatalHint('run `cam spec --help` for usage');
				return 1;
			}
			if (parsed.help) {
				process.stdout.write(SPEC_HELP);
				return 0;
			}
			return dispatchSpec(parsed);
		}
		case 'issue': {
			const parsed = parseIssueArgs(argv.slice(3));
			if (parsed === null) {
				printFatalHint('Usage: cam issue "<free text>" | cam issue --file-local');
				return 1;
			}
			if (parsed.help) {
				process.stdout.write(ISSUE_HELP);
				return 0;
			}
			return dispatchIssue(parsed);
		}
		case 'next': {
			const parsed = parseNextArgs(argv.slice(3));
			if (parsed === null) {
				printFatalHint('run `cam next --help` for usage');
				return 1;
			}
			if (parsed.help) {
				process.stdout.write(NEXT_HELP);
				return 0;
			}
			return runNext({
				maxIterations: parsed.maxIterations,
				completionPromise: parsed.completionPromise,
			});
		}
		case 'review': {
			const parsed = parseReviewArgs(argv.slice(3));
			if (parsed === null) {
				printFatalHint('run `cam review --help` for usage');
				return 1;
			}
			if (parsed.help) {
				process.stdout.write(REVIEW_HELP);
				return 0;
			}
			return runReview({});
		}
		case 'ship': {
			const parsed = parseShipArgs(argv.slice(3));
			if (parsed === null) {
				printFatalHint('run `cam ship --help` for usage');
				return 1;
			}
			if (parsed.help) {
				process.stdout.write(SHIP_HELP);
				return 0;
			}
			return dispatchShip(parsed);
		}
		case 'tag': {
			const tail = argv.slice(3);
			if (tail.includes('--help') || tail.includes('-h')) {
				process.stdout.write(TAG_HELP);
				return 0;
			}
			if (tail.length > 0) {
				printError(`unknown tag option: ${tail[0]}`);
				printFatalHint('run `cam tag --help` for usage');
				return 1;
			}
			const tagResult = runTag({
				cwd: process.cwd(),
				spawnFn: (cmd, args, opts) => spawnSync(cmd, args, { ...opts, cwd: process.cwd() }),
			});
			return tagResult.ok ? 0 : 1;
		}
		case 'dashboard': {
			const tail = argv.slice(3);
			if (tail.includes('--help') || tail.includes('-h')) {
				process.stdout.write(DASHBOARD_HELP);
				return 0;
			}
			// Optional positional: orchPane (tmux pane id, e.g. %5). Injected by
			// `cam run` so the keybar can dispatch to the orchestrator. Omitted
			// when the dashboard is run standalone.
			const remaining = [...tail];
			let orchPane: string | undefined;
			if (remaining.length > 0 && !remaining[0]!.startsWith('-')) {
				orchPane = remaining.shift();
			}
			if (remaining.length > 0) {
				printError(`unknown dashboard option: ${remaining[0]}`);
				printFatalHint('run `cam dashboard --help` for usage');
				return 1;
			}
			return runDashboardInk({ ...(orchPane !== undefined ? { orchPane } : {}) });
		}
		case 'status': {
			const tail = argv.slice(3);
			if (tail.includes('--help') || tail.includes('-h')) {
				process.stdout.write(STATUS_HELP);
				return 0;
			}
			if (tail.length > 0) {
				printError(`unknown status option: ${tail[0]}`);
				printFatalHint('run `cam status --help` for usage');
				return 1;
			}
			return runStatus();
		}
		case 'orch-budget': {
			// CAM-23 US-001: machine-parseable orchestrator token-budget line.
			// Read-only, no flags; the orchestrator agent invokes it each cycle.
			return runOrchBudget();
		}
		case 'stop': {
			const tail = argv.slice(3);
			if (tail.includes('--help') || tail.includes('-h')) {
				process.stdout.write(STOP_HELP);
				return 0;
			}
			if (tail.length > 0) {
				printError(`unknown stop option: ${tail[0]}`);
				printFatalHint('run `cam stop --help` for usage');
				return 1;
			}
			return runStop();
		}
		case 'drain': {
			const drainParsed = parseDrainArgs(argv.slice(3));
			if (drainParsed === null) {
				printError(`unknown drain option: ${argv[3] ?? ''}`);
				printFatalHint('run `cam drain --help` for usage');
				return 1;
			}
			if (drainParsed.help) {
				process.stdout.write(DRAIN_HELP);
				return 0;
			}
			return runDrain({ flag: drainParsed.flag });
		}
		case 'resume': {
			const parsed = parseResumeArgs(argv.slice(3));
			if (parsed === null) {
				printFatalHint('run `cam resume --help` for usage');
				return 1;
			}
			if (parsed.help) {
				process.stdout.write(RESUME_HELP);
				return 0;
			}
			return runResume({
				...(parsed.mode ? { mode: parsed.mode } : {}),
				dryRun: parsed.dryRun,
				force: parsed.force,
			});
		}
		case 'claude': {
			const parsed = parseClaudeArgs(argv.slice(3));
			// `parsed.help` is unreachable here: the central --help guard above
			// already intercepted a leading --help/-h before this switch ran.
			// This narrowing check only satisfies parseClaudeArgs's
			// discriminated-union type (forwardedArgs is absent on the help
			// branch) — it no longer writes the help text itself.
			if (parsed.help) return 0;
			return runClaude({ args: parsed.forwardedArgs });
		}
		// Internal subcommand — not listed in top-level HELP.
		// Spawned as a detached background process by cam run (US-FIX-002).
		// Polls the active flag in .claude/cam-loop.local.md and calls
		// runSupervisor when active:true with non-operator stories pending.
		case 'sidecar': {
			await runSidecar();
			return 0;
		}
		// Internal subcommand — not listed in top-level HELP.
		// Polls for the ORCH_RECYCLE_MARKER, resolves the orchestrator claude PID
		// via ps ppid-walk (ps -ax -o pid=,ppid= filtered by ppid==wrapperPid,
		// immune to process-title rewriting; CAM-165 fix), sends SIGTERM, and
		// consumes the marker once.
		// Spawned as a detached background process by cam run alongside cam sidecar.
		case 'orch-recycle-watch': {
			await runOrchRecycleWatch();
			return 0;
		}
		// Internal subcommand — not listed in top-level HELP.
		// Polls sidecarAlive() to detect a dead container sidecar and either
		// respawns it (bounded, with backoff) or, on respawn exhaustion, writes
		// the shared .cam-sidecar-stalled.json marker (reason 'sidecar-died')
		// and stops respawning (escalate, never hot-loop).
		// Spawned as a background process by cam run, ONLY in container
		// worker_isolation mode (no-op in host mode; see run.ts).
		case 'sidecar-liveness-watch': {
			await runSidecarLivenessWatch();
			return 0;
		}
		// Internal subcommand — not listed in top-level HELP.
		// Forked as a detached background process by forkMonitor() when running
		// inside a tmux session.
		case 'retry-monitor': {
			const parsed = parseRetryMonitorArgs(argv.slice(3));
			if (parsed === null) {
				printFatalHint('run `cam retry-monitor --help` for usage');
				return 1;
			}
			if (parsed.help) {
				process.stdout.write(RETRY_MONITOR_HELP);
				return 0;
			}
			return runRetryMonitor({ pane: parsed.pane, pid: parsed.pid });
		}
		case 'journal': {
			const parsed = parseJournalArgs(argv.slice(3));
			if (parsed === null) return 1;
			if (parsed.help) {
				process.stdout.write(JOURNAL_HELP);
				return 0;
			}
			return dispatchJournal(parsed);
		}
		case 'patterns': {
			const parsed = parsePatternsArgs(argv.slice(3));
			if (parsed === null) return 1;
			if (parsed.help) {
				process.stdout.write(PATTERNS_HELP);
				return 0;
			}
			return dispatchPatterns(parsed);
		}
		case 'triage': {
			const tail = argv.slice(3);
			if (tail.length > 0) {
				printError(`unknown triage option: ${tail[0]}`);
				printFatalHint('run `cam triage --help` for usage');
				return 1;
			}
			return dispatchTriage();
		}
		case 'suggestions': {
			const parsed = parseSuggestionsArgs(argv.slice(3));
			if (parsed === null) return 1;
			if (parsed.help) {
				process.stdout.write(SUGGESTIONS_HELP);
				return 0;
			}
			return dispatchSuggestions(parsed);
		}
		default: {
			// Exhaustiveness check (US-001, CAM-278): `command` is `Command`
			// here, narrowed by `isCommand` above. If every case above covers
			// all of `COMMANDS`, TS narrows `command` to `never` in this
			// branch. Adding a member to `COMMANDS` without a matching case
			// widens `command` back to a non-`never` type here, so this
			// assignment fails `bun run typecheck`. Unreachable at runtime.
			const _never: never = command;
			throw new Error(`unhandled command: ${String(_never)}`);
		}
	}
}

// Only execute when invoked as a script (not when imported by a test).
// `import.meta.main` is true exactly once — when this module is the entry
// point passed to `bun`. Tests that import this file to exercise
// `parsePlanArgs` / `parseNextArgs` skip the dispatcher entirely.
if (import.meta.main) {
	const exitCode = await main(process.argv);
	process.exit(exitCode);
}

export { main, HELP_REGISTRY, COMMANDS };
export type { Command };


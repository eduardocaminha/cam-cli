#!/usr/bin/env bun
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
//   No subcommand parser registers a `--permission-mode` flag. Permission
//   mode is a hardcoded `bypassPermissions` literal at each spawn site, not
//   a CLI knob. The unit test `test/no-permission-mode-flag.test.ts` greps
//   this file (and every file in `src/commands/`) for `--permission-mode`
//   patterns and fails the build on a registration. Search markers
//   documented in that test.

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
import {
	upsertCycleMetricsRowOnMain,
	type UpsertCycleMetricsRowOnMainResult,
} from './src/commands/cycle-metrics.ts';
import {
	prunePatternRecordsOnMain,
	type PrunePatternRecordsOnMainResult,
} from './src/commands/patterns-prune.ts';
import { runIssueList } from './src/commands/issue-list.ts';
import { getIssueOnMain, type GetIssueOnMainOutcome } from './src/commands/issue-get.ts';
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
import { runSpecWriteDocs, runSpecPersist } from './src/commands/spec.ts';
import { runReview } from './src/commands/review.ts';
import { runShip } from './src/commands/ship.ts';
import {
	finalizeCycleClose,
	type FinalizeCycleCloseResult,
} from './src/commands/ship-finalize.ts';
import { buildShipFinalizeOpts, buildShipBumpOpts } from './src/commands/ship-deps.ts';
import { runShipBump, type ShipBumpResult } from './src/release/ship-bump.ts';
import { runResume, type ExplicitMode } from './src/commands/resume.ts';
import { runDecide, parseDecideArgs } from './src/commands/decide.ts';
import { runPrune, parsePruneArgs } from './src/commands/prune.ts';
import { runStatus } from './src/commands/status.ts';
import { runOrchBudget } from './src/commands/orch-budget.ts';
import { runOrchResolve } from './src/commands/orch-resolve.ts';
import { runStatsTokens, runStatsCycles } from './src/commands/stats.ts';
import { runStop } from './src/commands/stop.ts';
import { runDrain, parseDrainArgs } from './src/commands/drain.ts';
import { runPause, parsePauseArgs } from './src/commands/pause.ts';
import { runConfig } from './src/commands/config.ts';
import { DEFAULT_WEB_PORT, runWeb } from './src/commands/web.ts';
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
import type { Spec } from './src/issues/spec.ts';
import { printError, printFatalHint, printHint, printWarning } from './src/logging/color.ts';
import { renderHelp } from './src/logging/help.ts';
import { CAM_VERSION } from './src/version.ts';

const HELP = renderHelp({
	title: 'gship',
	tagline: 'Gateship: a local software-delivery runtime for coding agents',
	usage: 'gship [command] [options]',
	sections: [
		{
			heading: 'Web-first',
			entries: [
				{ name: '(default)', description: 'Start the local web control surface on 127.0.0.1:7777' },
				{ name: 'init [options]', description: 'Validate the machine and write optional project metadata' },
				{ name: 'web [--port N]', description: 'Serve the local web control surface on a custom port' },
				{ name: 'run [--port N]', description: 'Compatibility alias for the web control surface' },
			],
		},
		{
			heading: 'Maintenance',
			entries: [
				{ name: 'config [--show]', description: 'Interactive wizard to set model per phase and backend' },
				{ name: 'issue list|get|close|abandon|demote', description: 'Inspect or maintain backlog issues deterministically' },
				{ name: 'spec --persist|--write-docs', description: 'Internal deterministic spec write channels' },
				{ name: 'tag', description: 'Create and push the vX.Y.Z git tag for the current CAM_VERSION on main' },
				{ name: 'journal append', description: 'Append a structured cycle entry to scripts/cam/journal.md on main' },
				{ name: 'journal archive', description: 'Archive the oldest third of the legacy journal after its threshold' },
				{ name: 'patterns archive|prune', description: 'archive: move resolved-marked bullets from patterns.md to patterns.archive.md on main. prune: demote/archive stale or unconfirmed scripts/cam/pattern-records.jsonl entries on main' },
				{ name: 'prune [--force]', description: 'Deterministic branch cleanup after a PR is merged or abandoned' },
				{ name: 'version', description: 'Print the installed Gateship version (also `--version` / `-v`)' },
				{ name: 'help', description: 'Show this help' },
			],
		},
		{
			heading: 'Legacy session drain (temporary)',
			entries: [
				{ name: 'plan [<N>]', description: 'Control an already-running legacy session' },
				{ name: 'next [options]', description: 'Trigger an already-running legacy sidecar loop' },
				{ name: 'review', description: 'Request review in an already-running legacy session' },
				{ name: 'ship', description: 'Request ship in an already-running legacy session' },
				{ name: 'dashboard', description: 'Standalone read-only TUI (alt-screen) for monitoring a loop' },
				{ name: 'status', description: 'Show current loop state at a glance (idle / active / paused)' },
				{ name: 'stats tokens|cycles', description: 'Print per-issue token spend (orch/worker/total) or per-cycle worker/review-round counts from the event log' },
				{ name: 'stop', description: 'Cancel a running loop (clears state file + kills the per-project tmux session)' },
				{ name: 'pause', description: 'Set the operator pause brake marker (.claude/.cam-pause), separate from loop state' },
				{ name: 'drain [--stop|--clear]', description: 'Set or clear the inter-cycle drain kill-switch without killing the sidecar' },
				{ name: 'resume [options]', description: 'Reconcile loop state after interrupt; auto-detect or --mode <name>' },
				{ name: 'decide <decision>', description: 'Record your choice into the active operator-decision gate so the sidecar resumes deterministically' },
			],
		},
		{
			heading: 'Internal',
			entries: [
				{
					name: 'sidecar',
					description: 'Retained only for an already-running legacy session; never spawned by the web runtime',
				},
				{
					name: 'orch-recycle-watch',
					description: 'Retained only to drain a legacy orchestrator that is already running',
				},
				{
					name: 'sidecar-liveness-watch',
					description: 'Retained only to drain a legacy sidecar that is already running',
				},
				{
					name: 'orch-budget',
					description: 'Legacy orchestrator budget helper; unused by the web runtime',
				},
			],
		},
	],
	footer:
		'Run `gship <command> --help` for command-specific options. The web runtime\n' +
		'is the default; no command starts a new legacy tmux session. The remaining\n' +
		'legacy controls exist only to drain a session that was already running.',
});

const INIT_HELP = renderHelp({
	title: 'gship init',
	tagline: 'Validate the machine and set up the project for the gship loop',
	usage: 'gship init [options]',
	sections: [
		{
			heading: 'Options',
			entries: [
				{ name: '--new', description: 'Treat this as a new project (skip the new/existing question)' },
				{ name: '--existing', description: 'Treat this as an existing project' },
				{ name: '--issue-system <x>', description: 'linear | github | local. Skip the issue-system question' },
				{ name: '--description "<t>"', description: 'Project description for new projects (skip the prompt)' },
			],
		},
		{
			heading: 'Behaviour',
			body:
				'Stage 1 — Machine validation:\n' +
				'  1. Checks `claude` is on PATH.\n' +
				'\n' +
				'Stage 2 — Project setup wizard (if stage 1 passes):\n' +
				'  1. Asks: new project or existing?\n' +
				'  2. Verifies claude is installed and logged in.\n' +
				'  3. Asks: which issue system (linear | github | local)?\n' +
				'  4. If new: asks for a brief project description.\n' +
				'  5. Writes scripts/cam/project.toml with optional project metadata.\n' +
				'  6. Installs no agent personas, hooks, slash commands, or sidecars.\n' +
				'  7. Returns to the web-first flow; run `gship` to open the local UI.',
		},
	],
});

const RUN_HELP = renderHelp({
	title: 'gship run',
	tagline: 'Compatibility alias for the local web control surface',
	usage: 'gship run [--port N]',
	sections: [
		{
			heading: 'Options',
			entries: [
				{
					name: '--port <N>',
					description: 'Positive TCP port to listen on (default: 7777)',
				},
			],
		},
		{
			heading: 'Behaviour',
			body:
				'Starts the same Bun + SQLite localhost service as bare `gship` and\n' +
				'`gship web`. It never creates, attaches to, or sends keys through tmux.\n' +
				'The retired `--no-attach` option is rejected instead of starting a\n' +
				'background process with ambiguous ownership.',
		},
	],
	footer: 'Binds only to 127.0.0.1 and persists runs in .gship/runtime.sqlite.',
});

const PLAN_HELP = renderHelp({
	title: 'gship plan',
	tagline: 'Open a planning pane in the project session',
	usage: 'gship plan [<N>]',
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
				'1. Permission mode is a hardcoded bypassPermissions literal at the\n' +
				'   spawn site. gship does NOT accept a --permission-mode flag.\n' +
				'2. Ensures the project session exists (cam-orch-<basename>-<hash>);\n' +
				'   creates it (with 2-pane layout: orchestrator + dashboard) if needed.\n' +
				'3. Opens a new pane inside the session running:\n' +
				'     claude --permission-mode <mode> "/cam-plan" (or "/cam-plan N")\n' +
				'4. Returns 0 immediately. The planning flow runs inside the pane.\n' +
				'5. If not already inside the session, prints a hint:\n' +
				'     Run `gship run` to open the project session.',
		},
	],
	footer:
		'gship plan accepts only an issue number; any other argument is an error.\n' +
		'Without a number, gship dispatches a bare `/cam-plan` and the planner\n' +
		'picks the highest-priority open issue itself.',
});

const SPEC_HELP = renderHelp({
	title: 'gship spec',
	tagline: 'Deterministic internal spec write channels',
	usage:
		'gship spec --write-docs <id> | gship spec --persist <id>  (reads JSON from stdin)',
	sections: [
		{
			heading: 'Arguments',
			entries: [
				{
					name: '<id>',
					description:
						'Issue id to update (e.g. CAM-42). The issue must have stage:idea and status:open.',
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
						'`gship journal append` / `gship issue --file-local`.',
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
				'Both modes read JSON from stdin and write in-process. They never attach to\n' +
				'tmux, bootstrap an orchestrator, or send keystrokes. Operator-facing\n' +
				'specification of new and existing tasks belongs to `gship web`.',
		},
	],
	footer:
		'`echo \'<json>\' | gship spec --write-docs CAM-42` exits 0 on { ok: true }\n' +
		'(including the noOp empty-payload outcome) and 1 on malformed JSON, an\n' +
		'invalid payload, or a guard failure (diverged / detached-head / missing-main).\n' +
		'`echo \'<json>\' | gship spec --persist CAM-42` exits 0 on { ok: true }, printing\n' +
		'CAM_SPEC_RESULT=CAM-42 sha=<sha>, and 1 on malformed JSON (reason=invalid-json)\n' +
		'or any specifyIssueOnMain guard/validation failure (reason=<reason>).',
});

const ISSUE_HELP = renderHelp({
	title: 'gship issue',
	tagline: 'Maintain and inspect the issue backlog',
	usage:
		'gship issue list [--all] [--json] | gship issue close <id> | gship issue abandon <id> | gship issue demote <id> | gship issue get <id> | gship issue --file-local',
	sections: [
		{
			heading: 'Arguments',
			entries: [
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
						'Deterministically set stage:idea on main for a defective specified issue, so it can be re-specified (specified->idea for re-spec; in-process, no tmux, no LLM).',
				},
				{
					name: 'get <id>',
					description:
						"Print a single issue's JSON from main to stdout (in-process, no tmux, no LLM). Read-only: never mutates or commits anything. Exits nonzero with a clear message when the id does not exist.",
				},
			],
		},
	],
	footer: 'Create new operator-specified tasks in `gship web`.',
});

const JOURNAL_HELP = renderHelp({
	title: 'gship journal',
	tagline: 'Append a structured cycle entry to scripts/cam/journal.md on main',
	usage: 'gship journal append [--force] [--cycle-close]  |  gship journal archive [--threshold N]',
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
				'          /exit manually or start `gship run` to restart the watcher.\n' +
				'\n' +
				'Cycle-metrics row (always on, every append): after recording the\n' +
				'per-cycle token accounting, every `gship journal append` -- not only\n' +
				'--cycle-close -- also upserts one row into scripts/cam/cycle-metrics.jsonl\n' +
				'on main, best-effort (a failure or throw only logs a warning; it never\n' +
				'changes the exit code, the recycle marker, or CAM_ORCH_HANDOFF_DUE).\n' +
				'\n' +
				'`gship journal archive [--threshold N]`:\n' +
				'  Does not read stdin. Moves the oldest floor(entries/3) post-marker\n' +
				'  entries from journal.md to journal.archive.md in one atomic on-main\n' +
				'  commit when the entry count exceeds N (default 50). Prints\n' +
				'  `CAM_JOURNAL_ARCHIVED=<k> sha=<commit-sha>` and exits 0 on a successful\n' +
				'  archive; prints `CAM_JOURNAL_ARCHIVE=noop entries=<n> threshold=<t>` and\n' +
				'  exits 0 when at or below the threshold; exits 1 on failure.',
		},
	],
	footer:
		'The orchestrator calls `gship journal append` at cycle close time as the\n' +
		'deterministic housekeeping channel (read-only orchestrator, gated write via gship).',
});

const PATTERNS_HELP = renderHelp({
	title: 'gship patterns',
	tagline: 'Move resolved-marked bullets to patterns.archive.md; demote/archive stale pattern-records.jsonl entries. Both on main.',
	usage: 'gship patterns archive|prune',
	sections: [
		{
			heading: 'Subcommands',
			entries: [
				{
					name: 'archive',
					description: 'Move bullets carrying `[resolved YYYY-MM]` from patterns.md to patterns.archive.md on main via commit-tree',
				},
				{
					name: 'prune',
					description: 'Demote/archive scripts/cam/pattern-records.jsonl entries on main by confirmationScore, shelf-life, or anchor-decay',
				},
			],
		},
		{
			heading: 'archive behaviour',
			body:
				'1. Reads scripts/cam/patterns.md from main via `git show main:...`\n' +
				'   (never from the working tree -- the commit-tree-to-main pattern).\n' +
				'2. Selection is MARKER-based only: a bullet moves if and only if it\n' +
				'   carries `[resolved YYYY-MM]` anywhere in its text. Unlike `gship\n' +
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
		{
			heading: 'prune behaviour',
			body:
				'1. Reads scripts/cam/pattern-records.jsonl (and the companion\n' +
				'   pattern-records.archive.jsonl) from main via `git show main:...`.\n' +
				'2. Three independent triggers, at most one demotion per record per\n' +
				'   run: (a) confirmationScore below threshold demotes one tier\n' +
				'   (foundational -> tactical -> observational -> archived); (b) a\n' +
				'   tactical/observational record stale past its shelf life (30d / 14d\n' +
				'   from recorded_at or its last outcome) archives directly; (c) a\n' +
				'   record whose dir_anchors ALL point at paths that no longer exist\n' +
				'   demotes one tier (anchor-decay). No CLI flags: thresholds are fixed\n' +
				'   constants in src/commands/patterns-prune.ts.\n' +
				'3. Writes both files to main in one atomic commit-tree commit.\n' +
				'4. Best-effort push to origin main (non-zero exit is logged, not fatal).\n' +
				'5. On success with mutations: prints `CAM_PATTERNS_PRUNED=<k>\n' +
				'   sha=<commit-sha>` and exits 0.\n' +
				'6. On success with nothing to prune: prints `CAM_PATTERNS_PRUNED=noop`\n' +
				'   and exits 0.\n' +
				'7. On failure (diverged, detached HEAD, missing main): exits 1.',
		},
	],
	footer:
		'To mark a bullet resolved, append `[resolved YYYY-MM]` anywhere in its\n' +
		'text on main; `gship patterns archive` then relocates it verbatim.',
});

const SUGGESTIONS_HELP = renderHelp({
	title: 'gship suggestions',
	tagline: 'Triage the pen of penned reviewer SUGGESTIONs (scripts/cam/suggestions.jsonl)',
	usage: 'gship suggestions list|promote <fingerprint> [<fingerprint> ...]|dismiss <fingerprint>',
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
					name: 'promote <fingerprint> [<fingerprint> ...]',
					description:
						'File the matching pen entry (or entries) as ONE real issue (derivedFrom + a suggestion-fingerprint line per entry preserved), then remove all promoted lines from the pen',
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
				'3. `promote` files ONE issue and removes every promoted pen line in ONE\n' +
				'   atomic on-main commit (merging derivedFrom from every entry\'s\n' +
				'   sourceIssue and embedding a `suggestion-fingerprint: <fp>` description\n' +
				'   line per entry so future terminal reviews still dedup against each\n' +
				'   one). Two or more fingerprints compose into a single issue; this is\n' +
				'   the supported way to promote entries that share a fix site.\n' +
				'4. `dismiss` removes the one matching line from the pen; no issue is filed.\n' +
				'5. Both mutations use the on-main commit-tree plumbing and rewrite only\n' +
				'   the matching-fingerprint line(s) -- every other line is byte-preserved.\n' +
				'6. An unknown fingerprint anywhere in the promote list prints an error,\n' +
				'   exits non-zero, and mutates nothing (all fingerprints are validated\n' +
				'   before any mutation).',
		},
	],
	footer:
		'The pen is filled by the terminal-verdict hook (CAM-189) when a review\n' +
		'ends CLEAN with non-blocking SUGGESTIONs.',
});

export const NEXT_HELP = renderHelp({
	title: 'gship next',
	tagline: 'Open a loop pane in the project session',
	usage: 'gship next [--max-iter <N>] [--completion-promise <STR>] [--skip-preflight] [--headless]',
	sections: [
		{
			heading: 'Options',
			entries: [
				{ name: '--max-iter <N>', description: 'Max iterations before auto-stop (default: 30)' },
				{
					name: '--completion-promise <STR>',
					description: 'Phrase the assistant emits to end the loop (default: COMPLETE)',
				},
				{
					name: '--skip-preflight',
					description:
						'Bypass the deterministic preflight (git sync, clean tree, typecheck,\n' +
						'  tests) and proceed straight to the signal write (resume escape)',
				},
				{
					name: '--headless',
					description:
						'Pure per-invocation flag: never persisted by config, never sticky\n' +
						'  across an invocation that omits it (default: off)',
				},
			],
		},
		{
			heading: 'Behaviour',
			body:
				'1. Permission mode is a hardcoded bypassPermissions literal at the\n' +
				'   spawn site. gship does NOT accept a --permission-mode flag.\n' +
				'2. Pre-arms the cam-loop plugin by writing\n' +
				'   .claude/cam-loop.local.md (vendored template at\n' +
				'   vendor/cam-loop.local.md.tmpl).\n' +
				'3. Ensures the project session exists (cam-orch-<basename>-<hash>);\n' +
				'   creates it (with 2-pane layout: orchestrator + dashboard) if needed.\n' +
				'4. Opens a new pane inside the session running:\n' +
				'     claude --permission-mode <mode> "/cam-next"\n' +
				'5. Returns 0 immediately. The loop runs inside the pane.\n' +
				'6. If not already inside the session, prints a hint:\n' +
				'     Run `gship run` to open the project session.',
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
	title: 'gship review',
	tagline: 'Write phase:review to the loop state file',
	usage: 'gship review',
	sections: [
		{
			heading: 'Behaviour',
			body:
				'1. Checks whether a live orchestrator session exists\n' +
				'   (cam-orch-<basename>-<hash>).\n' +
				'2. On hit: refuses unless the sidecar is alive, then writes\n' +
				'   phase:review to .claude/cam-loop.local.md, preserving all\n' +
				'   other state-file fields; the sidecar runs the review pipeline\n' +
				'   and returns immediately.\n' +
				'3. On miss: bootstraps the orchestrator via `gship run --no-attach`,\n' +
				'   waits for .claude/.cam-orch-ready + liveness re-check, then\n' +
				'   writes phase:review.\n' +
				'4. If not already inside the session, prints a hint:\n' +
				'     Run `gship run` to open the project session.',
		},
	],
	footer: 'gship review accepts no arguments. gship does NOT accept a --permission-mode flag.',
});

const SHIP_HELP = renderHelp({
	title: 'gship ship',
	tagline: 'Write phase:shipping to the loop state file, or finalize a cycle in-process',
	usage: 'gship ship [--finalize] [--bump]',
	sections: [
		{
			heading: 'Behaviour (default)',
			body:
				'1. Checks whether a live orchestrator session exists\n' +
				'   (cam-orch-<basename>-<hash>).\n' +
				'2. On hit: writes phase:shipping to .claude/cam-loop.local.md,\n' +
				'   preserving all other state-file fields; the sidecar runs the\n' +
				'   deterministic ship runner and returns immediately.\n' +
				'3. On miss: bootstraps the orchestrator via `gship run --no-attach`,\n' +
				'   waits for .claude/.cam-orch-ready + liveness re-check, then\n' +
				'   writes phase:shipping.\n' +
				'4. If not already inside the session, prints a hint:\n' +
				'     Run `gship run` to open the project session.',
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
	footer: 'gship does NOT accept a --permission-mode flag.',
});

const TAG_HELP = renderHelp({
	title: 'gship tag',
	tagline: 'Create and push the vX.Y.Z git tag for the current CAM_VERSION',
	usage: 'gship tag',
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
	title: 'gship status',
	tagline: 'Show current loop state at a glance',
	usage: 'gship status',
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
	title: 'gship dashboard',
	tagline: 'Read-only TUI for monitoring a running loop',
	usage: 'gship dashboard [orchPane]',
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
		'gship run places this command in pane 0.1 of the project session (permanent,\n' +
		'always visible). You can also run it standalone in any terminal.',
});

const WEB_HELP = renderHelp({
	title: 'gship web',
	tagline: 'Serve the local web control surface',
	usage: 'gship web [--port N]',
	sections: [
		{
			heading: 'Options',
			entries: [
				{ name: '--port <N>', description: 'Positive TCP port to listen on (default: 7777)' },
			],
		},
	],
	footer:
		'Binds only to 127.0.0.1 and never opens a browser automatically. Runs persist in .gship/runtime.sqlite.',
});

const STOP_HELP = renderHelp({
	title: 'gship stop',
	tagline: 'Cleanly cancel a running loop',
	usage: 'gship stop',
	sections: [
		{
			heading: 'What it does',
			body:
				'1. Removes .claude/cam-loop.local.md (the plugin state file).\n' +
				'2. Kills the per-project tmux session (derived from the project root\n' +
				'   path) if alive; unrelated tmux sessions are NOT touched.\n' +
				'3. Exits 0. Idempotent: calling `gship stop` with nothing to clean is the\n' +
				'   success state, not a failure.',
		},
	],
	footer: 'After `gship stop`, the next `gship next` will not detect a stale loop.',
});

const PAUSE_HELP = renderHelp({
	title: 'gship pause',
	tagline: 'Set the operator pause brake marker',
	usage: 'gship pause',
	sections: [
		{
			heading: 'What it does',
			body:
				'Writes .claude/.cam-pause, a dedicated marker file. This is DISTINCT\n' +
				'from the loop-state `active` field: the sidecar re-stamps `active:true`\n' +
				'every iteration, which would silently clobber a brake stored there.',
		},
	],
	footer: 'Run `gship resume` to clear the pause and continue the loop.',
});

const DRAIN_HELP = renderHelp({
	title: 'gship drain',
	tagline: 'Set or clear the inter-cycle drain kill-switch',
	usage: 'gship drain [--stop | --clear]',
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
				'`gship drain --stop` writes only the drain marker (.claude/.cam-drain-stop).\n' +
				'It does NOT send SIGTERM to the sidecar or remove any other marker.\n' +
				'Use `gship stop` to fully cancel the session.',
		},
	],
	footer: '`gship stop` also clears the drain kill-switch as part of its full cleanup.',
});

const RESUME_HELP = renderHelp({
	title: 'gship resume',
	tagline: 'Reconcile loop state after an interrupt',
	usage: 'gship resume [--mode <name>] [--dry-run] [--force]',
	sections: [
		{
			heading: 'Auto-detected modes (no --mode flag)',
			entries: [
				{ name: 'idle', description: 'No state file → run `gship next` to start fresh' },
				{
					name: 'respawn',
					description: 'State file + heartbeat dead + recent commit (≤24h) → re-spawn `gship next`',
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
					description: 'Print `git reset --hard origin/main` + remove state file (gship does NOT run reset)',
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

const DECIDE_HELP = renderHelp({
	title: 'gship decide',
	tagline: 'Record your choice into the active operator-decision gate',
	usage: 'gship decide <decision>',
	sections: [
		{
			heading: 'Arguments',
			entries: [
				{
					name: '<decision>',
					description:
						'Must be a member of the active gate\'s options[]. Validated and written into the SAME gate file (.claude/.cam-gate.json) the sidecar polls -- no split across the loop state file.',
				},
			],
		},
		{
			heading: 'Behaviour',
			body:
				'1. Reads the active gate file (fail-closed -- absent/malformed exits non-zero).\n' +
				'2. Validates <decision> is a member of the gate\'s options[]; an invalid\n' +
				'   decision exits non-zero, lists the valid options, and leaves the gate\n' +
				'   file unmodified.\n' +
				'3. Writes decision back into the same gate file so the sidecar can resume\n' +
				'   deterministically on its next poll.',
		},
	],
	footer: 'Distinct from `gship resume` (interrupt recovery) -- this resolves a live operator-decision gate.',
});

const PRUNE_HELP = renderHelp({
	title: 'gship prune',
	tagline: 'Deterministic branch-cleanup after a PR is merged (or abandoned)',
	usage: 'gship prune [--force]',
	sections: [
		{
			heading: 'Flags',
			entries: [
				{
					name: '--force',
					description:
						'Skip the non-cam/* branch and open-PR confirmations. Never bypasses the dirty-tree or main-branch STOP.',
				},
			],
		},
		{
			heading: 'Behaviour',
			body:
				'1. STOPs (nonzero exit) if the working tree is dirty, or if already on main.\n' +
				'2. STOPs unless --force if the current branch is not cam/*, or if it has\n' +
				'   an open (unmerged) PR.\n' +
				'3. Otherwise: git checkout main, git pull origin main, git branch -D\n' +
				'   <branch>, git fetch --prune.',
		},
	],
	footer: 'Zero-LLM: pure git/gh dance, no pane spawned. Never deletes main/master; never force-pushes.',
});

const CONFIG_HELP =
	'Usage: gship config [--show]\n' +
	'  Interactive wizard to set model per phase and backend\n' +
	'  --show  Print current config without prompting (US-008)\n';

const TRIAGE_HELP =
	'Usage: gship triage\n' +
	'  Rank {specified,open} issues from main using WSJF topo-sort.\n' +
	'  Writes updated ranks to main (off-main commit-tree; no checkout).\n' +
	'  No-op when ranks are unchanged (idempotent).\n';

// Internal commands (US-001, CAM-211): not listed in top-level HELP, but each
// needs a real help entry so the central --help/-h guard below can short-
// circuit them without ever running their body (e.g. `cam sidecar --help`
// must never boot the long-lived daemon).

const SIDECAR_HELP = renderHelp({
	title: 'gship sidecar',
	tagline: 'Internal command — not for direct use',
	usage: 'gship sidecar',
	sections: [
		{
			heading: 'Behaviour',
			body:
				'Spawned as a detached background process by `gship run`. Polls the\n' +
				'`active` flag in .claude/cam-loop.local.md and drives the supervisor\n' +
				'loop (runSupervisor) when active. Loops until killed by `gship run`\'s\n' +
				'cleanup. Not listed in top-level `gship help`.',
		},
	],
});

const ORCH_RECYCLE_WATCH_HELP = renderHelp({
	title: 'gship orch-recycle-watch',
	tagline: 'Internal command — not for direct use',
	usage: 'gship orch-recycle-watch',
	sections: [
		{
			heading: 'Behaviour',
			body:
				'Spawned as a detached background process by `gship run`. Polls for the\n' +
				'orchestrator recycle marker and sends SIGTERM to the orchestrator\n' +
				'claude PID when armed (consume-once). Not listed in top-level\n' +
				'`gship help`.',
		},
	],
});

const SIDECAR_LIVENESS_WATCH_HELP = renderHelp({
	title: 'gship sidecar-liveness-watch',
	tagline: 'Internal command — not for direct use',
	usage: 'gship sidecar-liveness-watch',
	sections: [
		{
			heading: 'Behaviour',
			body:
				'Spawned by `gship run` only in container worker_isolation mode. Detects\n' +
				'a dead container sidecar, attempts a bounded respawn, and escalates via\n' +
				'the .cam-sidecar-stalled.json marker on exhaustion. Not listed in\n' +
				'top-level `gship help`.',
		},
	],
});

const ORCH_BUDGET_HELP = renderHelp({
	title: 'gship orch-budget',
	tagline: 'Internal command — not for direct use',
	usage: 'gship orch-budget',
	sections: [
		{
			heading: 'Behaviour',
			body:
				'Read-only, no flags. Prints a single machine-parseable line\n' +
				'(CAM_ORCH_BUDGET=<spend>/<threshold> over=<true|false>) and always\n' +
				'exits 0. Invoked each cycle by the orchestrator agent. Not listed in\n' +
				'top-level `gship help`.',
		},
	],
});

const ORCH_RESOLVE_HELP = renderHelp({
	title: 'gship orch-resolve',
	tagline: 'Internal command — not for direct use',
	usage: 'gship orch-resolve',
	sections: [
		{
			heading: 'Behaviour',
			body:
				'Read-only, no flags. Re-reads scripts/cam/project.toml and prints a\n' +
				'single JSON line ({"model":...,"backend":...,"effort":...}) for the\n' +
				'orchestrator phase, so a respawn can pick up config edits without\n' +
				'forking resolvePhaseModel\'s rules into bash. Exits 0 on success; on a\n' +
				'not-ok model resolution, prints the resolution message to stderr and\n' +
				'exits 1 with nothing on stdout. Not listed in top-level `gship help`.',
		},
	],
});

const STATS_HELP = renderHelp({
	title: 'gship stats',
	tagline: 'Per-issue token spend or per-cycle round counts from the event log',
	usage: 'gship stats tokens|cycles',
	sections: [
		{
			heading: 'Subcommands',
			entries: [
				{
					name: 'tokens',
					description: 'Print per-issue orch/worker/total token spend plus global mean/median',
				},
				{
					name: 'cycles [--rebuild]',
					description:
						"Print per-cycle worker/review-round counts and token totals; --rebuild regenerates scripts/cam/cycle-metrics.jsonl",
				},
			],
		},
		{
			heading: 'Behaviour',
			body:
				'Reads .claude/cam-worker-events.jsonl and aggregates every \'cycle-tokens\'\n' +
				"event by detail.issueNumber (aggregateTokensPerIssue, src/stats/tokens.ts).\n" +
				'Raw \'tokens\' spend not covered by any \'cycle-tokens\' marker is reported\n' +
				'separately as unattributed spend, never dropped or folded into a row.\n' +
				'The orch component of a cycle-tokens total excludes output tokens (input +\n' +
				'cacheCreation + cacheRead only); the worker component includes all four\n' +
				'fields. Totals are used as recorded, not recomputed from transcripts.\n' +
				"`stats cycles` bounds each row to the slice between two consecutive\n" +
				"'cycle-tokens' markers (ADR-0053, aggregateCycleMetrics in\n" +
				'src/stats/cycles.ts): the span before the FIRST marker has no established\n' +
				'left bound and is disclosed as an unattributed leading span instead of\n' +
				'being folded into a row. `--rebuild` regenerates the whole committed\n' +
				'artifact from the log; without it, `stats cycles` is read-only.\n' +
				'Always exits 0, including on a missing or empty event log (no data is not\n' +
				'an error).',
		},
	],
});

// --- Argv parsers ----------------------------------------------------------

/**
 * Discriminated union returned by parseIssueArgs.
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
 *     etc. are preserved) so the issue can be re-specified.
 * - mode === 'get': deterministic in-process read of a single issue's JSON
 *     from main (US-002, CAM-400). id is the required positional issue id;
 *     read-only -- never mutates or commits anything (contrast with
 *     close/abandon/demote above).
 * - help === true: caller should print ISSUE_HELP and exit 0.
 */
export type ParsedIssueArgs =
	| { mode: 'file-local'; fastTrack: boolean; derivedFrom: string[]; help: false }
	| { mode: 'list'; all: boolean; json: boolean; help: false }
	| { mode: 'close'; id: string; help: false }
	| { mode: 'abandon'; id: string; help: false }
	| { mode: 'demote'; id: string; help: false }
	| { mode: 'get'; id: string; help: false }
	| { mode?: never; help: true };

/**
 * Shared subcommand arg-parse idiom used by parsePlanArgs and parseSpecArgs:
 * --help/-h detection,
 * unknown-option rejection, too-many-arguments rejection, and single-
 * positional capture. Callers own their exact error messages (passed via
 * `onTooMany`/`onUnknownOption`) and any further validation of the captured
 * positional (e.g. plan's integer parse, spec's empty-id check) -- this
 * helper only factors the control flow that was previously cloned across
 * the two parsers (the regression class that raised the dup ratchet at
 * the CAM-107 ship).
 *
 * `onUnknownOption` is optional: omit it to allow tokens starting with `-`
 * to be captured as the positional.
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
	// Deterministic issue maintenance subcommands.
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
	// A missing close id is a parse error.
	if (args[0] === 'close') {
		const id = args[1];
		if (id === undefined) {
			printError('gship issue close requires an id (e.g. CAM-42)');
			return null;
		}
		if (args.length > 2) {
			printError(`unexpected argument: ${args[2]}`);
			return null;
		}
		return { mode: 'close', id, help: false };
	}
	// A missing abandon id is a parse error.
	if (args[0] === 'abandon') {
		const id = args[1];
		if (id === undefined) {
			printError('gship issue abandon requires an id (e.g. CAM-42)');
			return null;
		}
		if (args.length > 2) {
			printError(`unexpected argument: ${args[2]}`);
			return null;
		}
		return { mode: 'abandon', id, help: false };
	}
	// A missing demote id is a parse error.
	if (args[0] === 'demote') {
		const id = args[1];
		if (id === undefined) {
			printError('gship issue demote requires an id (e.g. CAM-42)');
			return null;
		}
		if (args.length > 2) {
			printError(`unexpected argument: ${args[2]}`);
			return null;
		}
		return { mode: 'demote', id, help: false };
	}
	// A missing get id is a parse error.
	if (args[0] === 'get') {
		const id = args[1];
		if (id === undefined) {
			printError('gship issue get requires an id (e.g. CAM-42)');
			return null;
		}
		if (args.length > 2) {
			printError(`unexpected argument: ${args[2]}`);
			return null;
		}
		return { mode: 'get', id, help: false };
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
	printError('unknown gship issue subcommand; create tasks in `gship web`');
	return null;
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
			'gship plan takes an issue number, e.g. `gship plan 21`',
		),
		onTooMany: () => printError(
			'gship plan: too many arguments',
			'expected a single issue number, e.g. `gship plan 21`',
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
			'gship plan: invalid issue reference',
			'expected an issue number, e.g. `gship plan 21`',
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
 * - help === true: caller should print SPEC_HELP and exit 0.
 *
 * NOTE: This parser does NOT accept `--permission-mode` (US-007 invariant).
 */
export type ParsedSpecArgs =
	| { mode: 'write-docs'; id: string; help: false }
	| { mode: 'persist'; id: string; help: false }
	| { mode?: never; help: true };

/**
 * Parse internal `gship spec` writer args. Each mode takes exactly one issue
 * id string (e.g. 'CAM-42' or '42'). A leading prefix is preserved as-is;
 * a bare integer is accepted and prefixed by the caller. `--write-docs`
 * selects the in-process write-docs channel (US-003); `--persist` selects the
 * in-process persist channel (US-001, CAM-213). Without either mode, operator
 * specification belongs to the web runtime.
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
			'use `gship spec --write-docs <id>` or `gship spec --persist <id>`',
		),
		onTooMany: () => printError(
			'gship spec: too many arguments',
			'expected one issue id after --write-docs or --persist',
		),
	});
	if (parsed === null) return null;
	if (parsed.help) return { help: true };
	const id = parsed.positional;
	if (id !== undefined && id.length === 0) {
		printError(
			'gship spec: empty issue id',
			'expected one issue id after --write-docs or --persist',
		);
		return null;
	}

	if (writeDocs) {
		if (id === undefined) {
			printError(
				'gship spec --write-docs: missing issue id',
				'usage: echo \'<json>\' | gship spec --write-docs <id>',
			);
			return null;
		}
		return { mode: 'write-docs', id, help: false };
	}

	if (persist) {
		if (id === undefined) {
			printError(
				'gship spec --persist: missing issue id',
				'usage: echo \'<json>\' | gship spec --persist <id>',
			);
			return null;
		}
		return { mode: 'persist', id, help: false };
	}

	printError('interactive specification moved to `gship web`');
	return null;
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
}

/**
 * Route a parsed `gship spec` call: mode 'write-docs' => runSpecWriteDocs
 * in-process (NO tmux calls, no send-keys, no pane bootstrap, no liveness
 * check); mode 'persist' => runSpecPersist in-process (same no-tmux
 * guarantee). Exported so unit tests can inject the two deterministic writers.
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
	return 0;
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
): {
	maxIterations?: number;
	completionPromise?: string;
	skipPreflight?: boolean;
	headless?: boolean;
	help: boolean;
} | null {
	const result: {
		maxIterations?: number;
		completionPromise?: string;
		skipPreflight?: boolean;
		headless?: boolean;
		help: boolean;
	} = {
		help: false,
	};
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === '--help' || arg === '-h') {
			result.help = true;
			continue;
		}
		if (arg === '--skip-preflight') {
			result.skipPreflight = true;
			continue;
		}
		if (arg === '--headless') {
			result.headless = true;
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

export function parseWebArgs(args: string[]): { port: number; help: boolean } | null {
	let port = DEFAULT_WEB_PORT;
	let help = false;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === '--help' || arg === '-h') {
			help = true;
			continue;
		}

		let rawPort: string | undefined;
		if (arg === '--port') {
			rawPort = args[i + 1];
			if (rawPort !== undefined) i += 1;
		} else if (arg.startsWith('--port=')) {
			rawPort = arg.slice('--port='.length);
		} else {
			printError(`unknown web option: ${arg}`);
			return null;
		}

		const parsedPort = rawPort === undefined ? Number.NaN : Number(rawPort);
		if (!Number.isFinite(parsedPort) || !Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65_535) {
			printError(`--port expects an integer from 1 to 65535, got ${JSON.stringify(rawPort)}`);
			return null;
		}
		port = parsedPort;
	}
	return { port, help };
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
			printError(`gship ship --finalize failed: ${String(err)}`);
			return 1;
		}
	}
	if (parsed.bump) {
		const bumpFn = deps?.bumpFn ?? (() => runShipBump(buildShipBumpOpts(process.cwd())));
		try {
			bumpFn();
			return 0;
		} catch (err) {
			printError(`gship ship --bump failed: ${String(err)}`);
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
	'Usage: gship journal append [--force] [--cycle-close]  (reads JSON from stdin)\n' +
	'       gship journal archive [--threshold N]';

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
			printFatalHint('Usage: gship journal archive [--threshold N]  (N must be a positive integer)');
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
	/**
	 * Injectable upsertCycleMetricsRowOnMain (US-004, CAM-470). Auto-invoked,
	 * best-effort, UNCONDITIONALLY on every successful append (not gated on
	 * --cycle-close, unlike archiveFn/patternsArchiveFn) -- mirrors
	 * recordCycleTokens itself being unconditional, so no cycle-tokens marker
	 * can exist without a matching cycle-metrics row. Called strictly after
	 * recordCycleTokensFn and strictly before the --cycle-close branch's
	 * armRecycleMarkerFn (once the marker is armed the watcher can SIGTERM this
	 * process mid-write). Default: calls the real upsertCycleMetricsRowOnMain
	 * with process.cwd(), the current .claude/cam-worker-events.jsonl content,
	 * and a real spawnSync (mirrors defaultArchiveFn / defaultPatternsArchiveFn).
	 */
	cycleMetricsAppendFn?: (cycleId: string) => UpsertCycleMetricsRowOnMainResult;
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
 * Default cycleMetricsAppendFn: the real upsertCycleMetricsRowOnMain with
 * process.cwd(), the current .claude/cam-worker-events.jsonl content, and a
 * real spawnSync. Mirrors defaultArchiveFn / defaultPatternsArchiveFn: the
 * unconditional cycle-metrics call in dispatchJournal falls back to this when
 * a test/caller does not inject `deps.cycleMetricsAppendFn`.
 */
function defaultCycleMetricsAppendFn(cycleId: string): UpsertCycleMetricsRowOnMainResult {
	const cwd = process.cwd();
	let eventLogJsonl: string | null;
	try {
		eventLogJsonl = readFileSync(join(cwd, '.claude', 'cam-worker-events.jsonl'), 'utf8');
	} catch {
		eventLogJsonl = null;
	}
	return upsertCycleMetricsRowOnMain({
		cwd,
		eventLogJsonl,
		cycleId,
		spawnFn: (cmd, args, opts) =>
			spawnSync(cmd, args, { ...opts, stdio: 'pipe' }) as SpawnSyncReturns<string>,
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
		printError(`gship journal append: invalid JSON from stdin: ${String(err)}`);
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

	// US-004 (CAM-470): unconditionally upsert the cycle-metrics row for this
	// closed cycle. UNLIKE the archive checks below (--cycle-close only), this
	// runs on EVERY `cam journal append` -- recordCycleTokens itself is
	// unconditional, so no cycle-tokens marker may ever exist without a
	// matching cycle-metrics row. Ordering is load-bearing: strictly AFTER the
	// recordCycleTokens call above, strictly BEFORE armRecycleMarkerFn is
	// reached (below, --cycle-close only), since once the marker is armed the
	// watcher can SIGTERM this process mid-write. Best-effort: a throw or
	// ok:false logs a warning only -- it must never change dispatchJournal's
	// exit code or block the recycle marker / handoff signal.
	const cycleMetricsAppendFn = deps?.cycleMetricsAppendFn ?? defaultCycleMetricsAppendFn;
	try {
		const cycleMetricsResult = cycleMetricsAppendFn(journalEntry.cycleId);
		if (!cycleMetricsResult.ok) {
			printWarning(
				`gship journal append: cycle-metrics upsert failed (${cycleMetricsResult.reason}); continuing`,
			);
		}
	} catch (err) {
		printWarning(`gship journal append: cycle-metrics upsert threw; continuing: ${String(err)}`);
	}

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
				'gship journal append --cycle-close: handoff file absent (.claude/.cam-orch-handoff.json); ' +
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
				'gship journal append --cycle-close: no live recycle watcher ' +
					'(.claude/.cam-watcher.pid absent or process dead); ' +
					'use /exit manually or start gship run to restart the watcher.',
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
					`gship journal append --cycle-close: archive check failed (${archiveResult.reason}); continuing`,
				);
			}
		} catch (err) {
			printWarning(`gship journal append --cycle-close: archive check threw; continuing: ${String(err)}`);
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
					`gship journal append --cycle-close: patterns archive check failed (${patternsArchiveResult.reason}); continuing`,
				);
			}
		} catch (err) {
			printWarning(
				`gship journal append --cycle-close: patterns archive check threw; continuing: ${String(err)}`,
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
 * - mode === 'prune': dispatch the patterns prune (decay/demotion) subcommand
 *   (US-004, CAM-64) -- NOT `cam prune`, which is the unrelated branch-cleanup
 *   command (.claude/commands/cam-prune.md); this is `cam patterns prune`.
 * - help === true: caller should print PATTERNS_HELP and exit 0. This is the
 *   default for both `--help`/`-h` AND no subcommand at all (unlike
 *   parseJournalArgs, which errors on a bare `cam journal`): a bare
 *   `cam patterns` showing usage is more useful than an error.
 */
export type ParsedPatternsArgs =
	| { mode: 'archive'; help: false }
	| { mode: 'prune'; help: false }
	| { mode?: never; help: true };

const PATTERNS_USAGE = 'Usage: gship patterns archive|prune';

export function parsePatternsArgs(args: string[]): ParsedPatternsArgs | null {
	if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
		return { help: true };
	}
	const subCommand = args[0];
	if (subCommand === 'archive') {
		return { mode: 'archive', help: false };
	}
	if (subCommand === 'prune') {
		return { mode: 'prune', help: false };
	}
	printFatalHint(PATTERNS_USAGE);
	return null;
}

/** Injectable deps for dispatchPatterns -- all optional; production uses real impls. */
export interface PatternsDispatchDeps {
	/**
	 * Injectable archivePatternsOnMain.
	 * Default: calls the real impl with process.cwd() and a real spawnSync.
	 */
	archiveFn?: () => ArchivePatternsOnMainResult;
	/**
	 * Injectable prunePatternRecordsOnMain (US-004).
	 * Default: calls the real impl with process.cwd() and a real spawnSync.
	 */
	pruneFn?: () => PrunePatternRecordsOnMainResult;
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
 * Default pruneFn: the real prunePatternRecordsOnMain with process.cwd() and
 * a real spawnSync.
 */
function defaultPatternsPruneFn(): PrunePatternRecordsOnMainResult {
	return prunePatternRecordsOnMain({
		cwd: process.cwd(),
		spawnFn: (cmd, args, opts) =>
			spawnSync(cmd, args, { ...opts, stdio: 'pipe' }) as SpawnSyncReturns<string>,
	});
}

/**
 * Route a parsed `cam patterns` call. Exported so unit tests can inject fakes
 * for archiveFn/pruneFn and writeStdout to verify sentinel emission and exit
 * codes without touching real git or stdout. No --threshold arg: archival is
 * marker-based (see RESOLVED_MARKER_RE in src/commands/patterns-archive.ts),
 * not count-based; prune's thresholds (score/shelf-life/anchor-decay) are
 * fixed constants in src/commands/patterns-prune.ts, also not CLI flags.
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

	if (parsed.mode === 'prune') {
		const pruneFn = deps?.pruneFn ?? defaultPatternsPruneFn;
		const pruneResult = pruneFn();
		if (!pruneResult.ok) {
			// printError already fired inside prunePatternRecordsOnMain (via checkMainUpToDate)
			return 1;
		}
		if (pruneResult.pruned === 0) {
			writeStdout('CAM_PATTERNS_PRUNED=noop\n');
			return 0;
		}
		writeStdout(`CAM_PATTERNS_PRUNED=${pruneResult.pruned} sha=${pruneResult.sha}\n`);
		return 0;
	}

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
// cam stats dispatch (exported for unit testing with injectable deps)
// ---------------------------------------------------------------------------

/**
 * Discriminated union returned by parseStatsArgs.
 * - mode === 'tokens': dispatch the stats tokens subcommand.
 * - mode === 'cycles': dispatch the stats cycles subcommand; `rebuild` is
 *   true only when `--rebuild` was passed (regenerate the committed
 *   artifact) -- otherwise `stats cycles` is read-only (CAM-470 US-002).
 * - help === true: caller should print STATS_HELP and exit 0. This is the
 *   default for both `--help`/`-h` AND no subcommand at all (mirrors
 *   parsePatternsArgs: a bare `cam stats` showing usage is more useful than
 *   an error).
 */
export type ParsedStatsArgs =
	| { mode: 'tokens'; help: false }
	| { mode: 'cycles'; help: false; rebuild: boolean }
	| { mode?: never; help: true };

const STATS_USAGE = 'Usage: gship stats tokens|cycles';

export function parseStatsArgs(args: string[]): ParsedStatsArgs | null {
	if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
		return { help: true };
	}
	const subCommand = args[0];
	if (subCommand === 'tokens') return { mode: 'tokens', help: false };
	if (subCommand === 'cycles') {
		return { mode: 'cycles', help: false, rebuild: args.slice(1).includes('--rebuild') };
	}
	printFatalHint(STATS_USAGE);
	return null;
}

/** Injectable deps for dispatchStats -- all optional; production uses the real runStatsTokens/runStatsCycles. */
export interface StatsDispatchDeps {
	/** Injectable runStatsTokens. Default: real impl with process.cwd(). */
	statsTokensFn?: () => number;
	/** Injectable runStatsCycles. Default: real impl with process.cwd(). */
	statsCyclesFn?: (rebuild: boolean) => number;
}

/**
 * Route a parsed `cam stats` call. Exported so unit tests can inject fake
 * statsTokensFn/statsCyclesFn deps to verify wiring without touching the
 * real event log or stdout (the report content itself is tested against
 * runStatsTokens/runStatsCycles directly in test/commands/stats.test.ts and
 * test/commands/stats-cycles.test.ts).
 */
export function dispatchStats(parsed: ParsedStatsArgs, deps?: StatsDispatchDeps): number {
	if (parsed.help) {
		process.stdout.write(STATS_HELP);
		return 0;
	}
	if (parsed.mode === 'cycles') {
		const statsCyclesFn =
			deps?.statsCyclesFn ?? ((rebuild: boolean) => runStatsCycles({ cwd: process.cwd(), rebuild }));
		return statsCyclesFn(parsed.rebuild);
	}
	const statsTokensFn = deps?.statsTokensFn ?? (() => runStatsTokens({ cwd: process.cwd() }));
	return statsTokensFn();
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
	| { mode: 'promote'; help: false; fingerprints: string[] }
	| { mode: 'dismiss'; help: false; fingerprint: string }
	| { mode?: never; help: true };

const SUGGESTIONS_USAGE =
	'Usage: gship suggestions list|promote <fingerprint> [<fingerprint> ...]|dismiss <fingerprint>';

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
	if (subCommand === 'promote') {
		// Variadic (US-001, CAM-378): two or more fingerprints compose ONE
		// issue; a single fingerprint stays the pre-CAM-378 single-fp promote.
		const fingerprints = args.slice(1);
		if (fingerprints.length === 0) {
			printFatalHint(SUGGESTIONS_USAGE);
			return null;
		}
		return { mode: 'promote', help: false, fingerprints };
	}
	if (subCommand === 'dismiss') {
		const rest = args.slice(1);
		const fingerprint = rest[0];
		if (fingerprint === undefined || rest.length > 1) {
			printFatalHint(SUGGESTIONS_USAGE);
			return null;
		}
		return { mode: 'dismiss', help: false, fingerprint };
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
	promoteFn?: (fingerprints: string[]) => PromoteSuggestionOnMainResult;
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
function defaultPromoteSuggestionFn(fingerprints: string[]): PromoteSuggestionOnMainResult {
	const cwd = process.cwd();
	return promoteSuggestionOnMain({
		cwd,
		fingerprints,
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
		const result = promoteFn(parsed.fingerprints);
		if (!result.ok) {
			// printError already fired inside promoteSuggestionOnMain.
			return 1;
		}
		const fingerprintList = result.fingerprints.join('+');
		printHint(
			`promoted ${fingerprintList} -> filed ${result.issueId} on main (${result.sha})`,
		);
		writeStdout(`CAM_SUGGESTIONS_PROMOTED=${fingerprintList} issue=${result.issueId}\n`);
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

	writeStdout('gship suggestions list\n\n');
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
		flags: { specSource?: 'interview' | 'derived' | 'operator'; derivedFrom?: string[] },
	) => CreateLocalIssueOnMainOutcome;
	/**
	 * Inject a fake stdin-text reader for the --file-local branch. Only
	 * consulted when `fileLocalFn` is absent. Default: `Bun.stdin.text()`.
	 */
	readStdinFn?: () => Promise<string>;
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
	/**
	 * Inject a fake for the `get <id>` branch's underlying getIssueOnMain call.
	 * Default: `getIssueOnMain(process.cwd(), id)` (production spawnSync, no
	 * CAS/commit -- read-only). The printing (raw JSON to stdout on success,
	 * printError on failure) and exit-code mapping always run in dispatchIssue
	 * itself, regardless of injection (US-002, CAM-400).
	 */
	getIssueOnMainFn?: (id: string) => GetIssueOnMainOutcome;
}

/**
 * Shape of the JSON payload `cam issue --file-local` reads from stdin.
 *
 * `spec`, when present, is forwarded verbatim to createLocalIssueOnMain and
 * validated there via validateSpec (src/issues/spec.ts): a non-empty
 * spec.acceptanceCriteria array and a non-empty spec.scope string are
 * REQUIRED whenever the filing flags (--fast-track / --derived-from) are
 * used, because those flags promote the filed issue straight to
 * stage:'specified' (ADR-0051).
 */
type FileLocalStdinPayload = {
	title: string;
	description?: string;
	priority?: string;
	wsjf?: WsjfScore;
	spec?: Spec;
};

/** Build production CreateLocalIssueOnMainOptions from project root + parsed stdin JSON + CLI flags. */
function _buildCreateIssueOpts(
	cwd: string,
	parsedStdin: FileLocalStdinPayload,
	flags?: { specSource?: 'interview' | 'derived' | 'operator'; derivedFrom?: string[] },
): CreateLocalIssueOnMainOptions {
	return {
		cwd,
		title: parsedStdin.title,
		...(parsedStdin.description !== undefined ? { description: parsedStdin.description } : {}),
		...(parsedStdin.priority !== undefined ? { priority: parsedStdin.priority } : {}),
		...(parsedStdin.wsjf !== undefined ? { wsjf: parsedStdin.wsjf } : {}),
		...(parsedStdin.spec !== undefined ? { spec: parsedStdin.spec } : {}),
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
		printError(`gship issue --file-local: invalid JSON from stdin: ${String(err)}`);
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
		printError(`gship issue --file-local failed: ${String(err)}`);
		process.stdout.write('CAM_ISSUE_RESULT=ERROR reason=exception\n');
		return 1;
	}
}

/**
 * Route a parsed `gship issue` maintenance call. New task intake belongs to
 * `gship web`; every retained CLI branch is deterministic and in-process.
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
			printError(`gship issue close ${parsed.id} failed: ${result.reason}`);
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
			printError(`gship issue abandon ${parsed.id} failed: ${result.reason}`);
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
			printError(`gship issue demote ${parsed.id} failed: ${result.reason}`);
			process.stdout.write(`CAM_ISSUE_RESULT=ERROR reason=${result.reason}\n`);
			return 1;
		}
		printHint(`demoted ${result.id} on main (${result.sha})`);
		process.stdout.write(`CAM_ISSUE_RESULT=${result.id}\n`);
		return 0;
	}
	if (parsed.mode === 'get') {
		// Read-only: no CAM_ISSUE_RESULT machine line (that contract is scoped to
		// mutation outcomes -- see the `list` branch's comment above). Success
		// prints the raw issue JSON to stdout; failure prints a clear error and
		// exits nonzero.
		const getIssueOnMainFn =
			deps?.getIssueOnMainFn ?? ((id: string) => getIssueOnMain(process.cwd(), id));
		const result = getIssueOnMainFn(parsed.id);
		if (!result.ok) {
			printError(`gship issue get ${parsed.id} failed: issue not found`);
			return 1;
		}
		process.stdout.write(result.content);
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
	return 0;
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
 * Every command dispatched by `main()` — including retained internal legacy
 * commands — MUST be listed here exactly once. `HELP_REGISTRY` and the
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
	'web',
	'status',
	'stats',
	'orch-budget',
	'orch-resolve',
	'stop',
	'pause',
	'drain',
	'resume',
	'decide',
	'prune',
	'sidecar',
	'orch-recycle-watch',
	'sidecar-liveness-watch',
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
 * every case (including retained internal legacy commands) MUST have an
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
	web: WEB_HELP,
	status: STATUS_HELP,
	stats: STATS_HELP,
	'orch-budget': ORCH_BUDGET_HELP,
	'orch-resolve': ORCH_RESOLVE_HELP,
	stop: STOP_HELP,
	pause: PAUSE_HELP,
	drain: DRAIN_HELP,
	resume: RESUME_HELP,
	decide: DECIDE_HELP,
	prune: PRUNE_HELP,
	sidecar: SIDECAR_HELP,
	'orch-recycle-watch': ORCH_RECYCLE_WATCH_HELP,
	'sidecar-liveness-watch': SIDECAR_LIVENESS_WATCH_HELP,
	journal: JOURNAL_HELP,
	patterns: PATTERNS_HELP,
	triage: TRIAGE_HELP,
	suggestions: SUGGESTIONS_HELP,
};

/**
 * Decide whether a `--help`/`-h` in `tail` (argv after the command name)
 * short-circuits the given command. Every command matches anywhere-in-tail,
 * mirroring the per-command parsers this guard supersedes.
 */
export function isHelpRequested(_command: string, tail: string[]): boolean {
	return tail.includes('--help') || tail.includes('-h');
}

async function main(argv: string[]): Promise<number> {
	const command = argv[2];
	if (!command) {
		return runWeb({ port: DEFAULT_WEB_PORT, cwd: process.cwd() });
	}
	if (command === 'help' || command === '--help' || command === '-h') {
		process.stdout.write(HELP);
		return 0;
	}
	// `gship --version` / `gship -v` / `gship version`. We accept all three
	// because Unix CLIs are inconsistent about which form is canonical and
	// shipping just one would surprise muscle memory. The output shape is
	// `gateship 0.1.0` (single line, trailing newline) -- the product name,
	// not the typed alias, per ADR-0054 (usage examples use `gship`, version
	// identification uses `gateship`).
	if (command === '--version' || command === '-v' || command === 'version') {
		// `--version` is a machine-readable contract: emit exactly
		// `gateship X.Y.Z\n` so scripts piping into `head -1` or doing `==`
		// comparisons keep working. The "leading/trailing blank line"
		// convention applies to human-facing screens, not to version probes.
		process.stdout.write(`gateship ${CAM_VERSION}\n`);
		return 0;
	}

	// Narrow argv[2] to Command BEFORE the dispatch switch (US-001, CAM-278).
	// This is where "unknown command" is now reported — moved ahead of the
	// switch's `default:`, which is exhaustiveness-only from here on.
	if (!isCommand(command)) {
		printError(`unknown command: ${command}`);
		printFatalHint('run `gship help` to see the available commands');
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
				printFatalHint('run `gship init --help` for usage');
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
			});
		}
		case 'setup': {
			// Skip Stage 1 (machine validation) — exposes the SetupScreen directly
			// for previewing/iterating on its layout without re-running `cam init`.
			// Accepts the same flags as `cam init` Stage 2.
			const setupArgs = parseSetupArgs(argv.slice(3));
			if (setupArgs === null) {
				printFatalHint('run `gship init --help` for usage (setup shares its flags)');
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
			});
		}
		case 'config': {
			const tail = argv.slice(3);
			const showFlag = tail.includes('--show');
			const unknownFlags = tail.filter((a) => a !== '--show');
			if (unknownFlags.length > 0) {
				printError(`unknown config option: ${unknownFlags[0]}`);
				printFatalHint('run `gship config --help` for usage');
				return 1;
			}
			return runConfig({ show: showFlag });
		}
		case 'run': {
			const tail = argv.slice(3);
			if (tail.includes('--no-attach')) {
				printError('`gship run --no-attach` was retired; `gship run` now starts the web runtime');
				return 1;
			}
			const parsed = parseWebArgs(tail);
			if (parsed === null) {
				printFatalHint('run `gship run --help` for usage');
				return 1;
			}
			if (parsed.help) {
				process.stdout.write(RUN_HELP);
				return 0;
			}
			return runWeb({ port: parsed.port, cwd: process.cwd() });
		}
		case 'plan': {
			const parsed = parsePlanArgs(argv.slice(3));
			if (parsed === null) {
				printFatalHint('run `gship plan --help` for usage');
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
				printFatalHint('use `gship web`; `gship spec --help` documents internal channels');
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
				printFatalHint('Use `gship issue --help`; create new tasks in `gship web`.');
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
				printFatalHint('run `gship next --help` for usage');
				return 1;
			}
			if (parsed.help) {
				process.stdout.write(NEXT_HELP);
				return 0;
			}
			return runNext({
				maxIterations: parsed.maxIterations,
				completionPromise: parsed.completionPromise,
				skipPreflight: parsed.skipPreflight,
				headless: parsed.headless,
			});
		}
		case 'review': {
			const parsed = parseReviewArgs(argv.slice(3));
			if (parsed === null) {
				printFatalHint('run `gship review --help` for usage');
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
				printFatalHint('run `gship ship --help` for usage');
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
				printFatalHint('run `gship tag --help` for usage');
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
				printFatalHint('run `gship dashboard --help` for usage');
				return 1;
			}
			return runDashboardInk({ ...(orchPane !== undefined ? { orchPane } : {}) });
		}
		case 'web': {
			const parsed = parseWebArgs(argv.slice(3));
			if (parsed === null) {
				printFatalHint('run `gship web --help` for usage');
				return 1;
			}
			if (parsed.help) {
				process.stdout.write(WEB_HELP);
				return 0;
			}
			return runWeb({ port: parsed.port, cwd: process.cwd() });
		}
		case 'status': {
			const tail = argv.slice(3);
			if (tail.includes('--help') || tail.includes('-h')) {
				process.stdout.write(STATUS_HELP);
				return 0;
			}
			if (tail.length > 0) {
				printError(`unknown status option: ${tail[0]}`);
				printFatalHint('run `gship status --help` for usage');
				return 1;
			}
			return runStatus();
		}
		case 'stats': {
			const parsed = parseStatsArgs(argv.slice(3));
			if (parsed === null) return 1;
			return dispatchStats(parsed);
		}
		case 'orch-budget': {
			// CAM-23 US-001: machine-parseable orchestrator token-budget line.
			// Read-only, no flags; the orchestrator agent invokes it each cycle.
			return runOrchBudget();
		}
		case 'orch-resolve': {
			// US-001 (CAM-425): deterministic {model, backend, effort} JSON line
			// for the orchestrator phase. Read-only, no flags; re-reads
			// project.toml on every invocation so a respawn picks up config edits.
			return runOrchResolve();
		}
		case 'stop': {
			const tail = argv.slice(3);
			if (tail.includes('--help') || tail.includes('-h')) {
				process.stdout.write(STOP_HELP);
				return 0;
			}
			if (tail.length > 0) {
				printError(`unknown stop option: ${tail[0]}`);
				printFatalHint('run `gship stop --help` for usage');
				return 1;
			}
			return runStop();
		}
		case 'pause': {
			const pauseParsed = parsePauseArgs(argv.slice(3));
			if (pauseParsed === null) {
				printError(`unknown pause option: ${argv[3] ?? ''}`);
				printFatalHint('run `gship pause --help` for usage');
				return 1;
			}
			if (pauseParsed.help) {
				process.stdout.write(PAUSE_HELP);
				return 0;
			}
			return runPause();
		}
		case 'drain': {
			const drainParsed = parseDrainArgs(argv.slice(3));
			if (drainParsed === null) {
				printError(`unknown drain option: ${argv[3] ?? ''}`);
				printFatalHint('run `gship drain --help` for usage');
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
				printFatalHint('run `gship resume --help` for usage');
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
		case 'decide': {
			const parsed = parseDecideArgs(argv.slice(3));
			if (parsed === null) {
				printError('gship decide requires exactly one <decision> argument');
				printFatalHint('run `gship decide --help` for usage');
				return 1;
			}
			if (parsed.help) {
				process.stdout.write(DECIDE_HELP);
				return 0;
			}
			return runDecide({ decision: parsed.decision });
		}
		case 'prune': {
			const parsed = parsePruneArgs(argv.slice(3));
			if (parsed === null) {
				printFatalHint('run `gship prune --help` for usage');
				return 1;
			}
			if (parsed.help) {
				process.stdout.write(PRUNE_HELP);
				return 0;
			}
			return runPrune({ force: parsed.force });
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
				printFatalHint('run `gship triage --help` for usage');
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

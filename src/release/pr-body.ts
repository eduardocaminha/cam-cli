// src/release/pr-body.ts
//
// composePrTitle / composePrBody -- pure string composers that render the PR
// title and body from an in-memory PRD snapshot, so the ship phase needs no
// LLM to author the PR (CAM-149 US-001).
//
// Both functions are pure: they accept a PrdSnapshot object and return a
// string, with no filesystem, git, or network I/O. The snapshot must be
// captured by the caller BEFORE `cam ship --finalize` removes prd.json.
//
// Mirrors the PR body template hand-authored in templates/commands/cam-ship.md
// (Summary, Stories completed, Testing, Notes, Setup checklist).
//
// CAM-149 US-001. Setup checklist added CAM-52 US-003.

/** Minimal structural story shape the composer needs from prd.json. */
export interface PrdSnapshotStory {
	id: string;
	title: string;
	passes?: boolean;
	requires?: string | null;
}

/**
 * Minimal structural prd.json shape the composer needs. Defined locally
 * (not imported from a command-layer module) so this file stays a pure,
 * dependency-free composer.
 */
export interface PrdSnapshot {
	project?: string;
	description?: string;
	issueNumber?: number | string;
	userStories?: PrdSnapshotStory[];
	/** Optional PRD-level remarks. Absent on today's prd.json writer; forward-compatible. */
	notes?: string;
	/** Conventional-commit type carried from the issue (US-004). Defaults to 'feat' when absent. */
	type?: string;
}

const NO_SUMMARY_TEXT = 'No summary provided.';
const NO_STORIES_TEXT = 'No stories recorded.';
const NO_NOTES_TEXT = 'None.';
const NO_SETUP_CHECKLIST_TEXT = 'No manual setup actions detected.';
const TESTING_LINE = 'The deterministic gate spine (`bun run check:all`) ran green at ship time.';
const DEFAULT_TYPE = 'feat';

/** One detection heuristic: a cue regex plus the row it renders when matched. */
interface SetupChecklistCue {
	pattern: RegExp;
	item: string;
	where: string;
	how: string;
}

/**
 * Non-exhaustive cues for manual user setup actions (config/env/install),
 * mirrored from the reporter project's ralph-ship.md Step 14 checklist
 * heuristics, narrowed to what PrdSnapshot actually carries: prd.description,
 * prd.notes, and every story's title (PrdSnapshotStory has no notes field).
 */
const SETUP_CHECKLIST_CUES: SetupChecklistCue[] = [
	{
		pattern: /\.env\b|\benv(?:ironment)?\s*var/i,
		item: 'New environment variable(s)',
		where: '.env / deploy config',
		how: 'Review the diff for new env vars and set them in your environment.',
	},
	{
		pattern: /\bmigration\b/i,
		item: 'Database migration',
		where: 'database',
		how: 'Apply the migration manually if it was not run automatically.',
	},
	{
		pattern: /\binstall\b|\bdependency\b/i,
		item: 'New dependency / install step',
		where: 'package manager',
		how: 'Install the new dependency in your environment.',
	},
	{
		pattern: /\bapi key\b|\btoken\b|\bcredential\b|\bsecret\b|\boauth\b/i,
		item: 'Credential / API key setup',
		where: 'vendor dashboard',
		how: 'Create or rotate the credential and store it securely.',
	},
	{
		pattern: /\bwebhook\b/i,
		item: 'Webhook registration',
		where: 'vendor dashboard',
		how: 'Register the webhook URL with the vendor.',
	},
	{
		// Requires config/configuration to co-occur with a change/setup signal
		// (an action verb, or a config-artifact token) rather than matching a
		// bare standalone word -- 'the configuration option is already
		// documented' should NOT fire this cue (US-001, CAM-334). The gap is
		// newline-bounded (excludes newline characters, not the previous
		// any-character gap) so the two tokens must co-occur within the same
		// haystack field (description, notes, or a single story title): a verb
		// in one field and an unrelated standalone config word in another field
		// must NOT co-fire (US-001, CAM-343).
		pattern:
			/\bconfig(?:uration)?\b[^\n]*?\b(?:new|update|change|edit|add|set)\b|\b(?:new|update|change|edit|add|set)\b[^\n]*?\bconfig(?:uration)?\b|\bproject\.toml\b|\bconfig(?:uration)?\s+file\b/i,
		item: 'Configuration change',
		where: 'project config',
		how: 'Review the updated configuration and apply any required settings.',
	},
];

/**
 * Render the PR title from the PRD snapshot.
 *
 * Returns `'<type>: <descriptive text> (CAM-<issueNumber>)'`, where the
 * descriptive text is `prd.description` when present (trimmed, non-empty),
 * falling back to `prd.project`, falling back to a generic placeholder
 * (never empty). `type` defaults to 'feat' when the snapshot lacks one
 * (PRDs authored before US-004). The issue reference uses the textual
 * 'CAM-<N>' form (never '#<N>', which would link to an unrelated GitHub
 * entity) and is omitted entirely, with no trailing whitespace or
 * parentheses, when issueNumber is null/absent.
 */
export function composePrTitle(prd: PrdSnapshot): string {
	const type = prd.type?.trim() || DEFAULT_TYPE;

	const description = prd.description?.trim();
	const text = description || prd.project?.trim() || 'Untitled PRD';

	const issueSuffix = prd.issueNumber != null && String(prd.issueNumber).trim() !== '' ? ` (CAM-${prd.issueNumber})` : '';

	return `${type}: ${text}${issueSuffix}`;
}

/**
 * Render the stories table for the "Stories completed" section.
 * Every userStories entry gets one row (id, title, checked box when passes is true).
 */
function renderStoriesTable(stories: PrdSnapshotStory[]): string {
	if (stories.length === 0) return NO_STORIES_TEXT;

	const header = '| Story | Title | Done |\n| --- | --- | --- |';
	const rows = stories.map((story) => `| ${story.id} | ${story.title} | ${story.passes ? '[x]' : '[ ]'} |`);
	return [header, ...rows].join('\n');
}

/**
 * Render the "Setup checklist" table: manual user actions (config/env/install)
 * detected by scanning prd.description, prd.notes, and every story title for
 * cue keywords (see SETUP_CHECKLIST_CUES). Renders a clear empty-state line,
 * never an empty table, when no cue matches.
 */
function renderSetupChecklist(prd: PrdSnapshot): string {
	const haystack = [prd.description ?? '', prd.notes ?? '', ...(prd.userStories ?? []).map((story) => story.title)].join('\n');

	const matched = SETUP_CHECKLIST_CUES.filter((cue) => cue.pattern.test(haystack));
	if (matched.length === 0) return NO_SETUP_CHECKLIST_TEXT;

	const header = '| # | Item | Where | How | Status |\n| --- | --- | --- | --- | --- |';
	const rows = matched.map((cue, index) => `| ${index + 1} | ${cue.item} | ${cue.where} | ${cue.how} | pending |`);
	return [header, ...rows].join('\n');
}

/**
 * Render the full PR body from the PRD snapshot: Summary, Stories completed,
 * Testing, Notes, Setup checklist (the sections of
 * templates/commands/cam-ship.md's PR body template).
 */
export function composePrBody(prd: PrdSnapshot): string {
	const summary = prd.description?.trim() || NO_SUMMARY_TEXT;
	const storiesTable = renderStoriesTable(prd.userStories ?? []);
	const notes = prd.notes?.trim() || NO_NOTES_TEXT;
	const setupChecklist = renderSetupChecklist(prd);

	return [
		'## Summary',
		'',
		summary,
		'',
		'## Stories completed',
		'',
		storiesTable,
		'',
		'## Testing',
		'',
		`- ${TESTING_LINE}`,
		'',
		'## Notes',
		'',
		notes,
		'',
		'## Setup checklist',
		'',
		setupChecklist,
		'',
	].join('\n');
}

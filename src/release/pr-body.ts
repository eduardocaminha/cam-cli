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
// Mirrors the four-section PR body template hand-authored in
// templates/commands/cam-ship.md (Summary, Stories completed, Testing, Notes).
//
// CAM-149 US-001.

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
}

const NO_SUMMARY_TEXT = 'No summary provided.';
const NO_STORIES_TEXT = 'No stories recorded.';
const NO_NOTES_TEXT = 'None.';
const TESTING_LINE = 'The deterministic gate spine (`bun run check:all`) ran green at ship time.';

/**
 * Render the PR title from the PRD snapshot.
 *
 * Returns `prd.description` when present (trimmed, non-empty), falling back
 * to `prd.project`, falling back to a generic placeholder. Never returns an
 * empty string.
 */
export function composePrTitle(prd: PrdSnapshot): string {
	const description = prd.description?.trim();
	if (description) return description;

	const project = prd.project?.trim();
	if (project) return project;

	return 'Untitled PRD';
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
 * Render the full PR body from the PRD snapshot: Summary, Stories completed,
 * Testing, Notes (the four sections of templates/commands/cam-ship.md's PR
 * body template).
 */
export function composePrBody(prd: PrdSnapshot): string {
	const summary = prd.description?.trim() || NO_SUMMARY_TEXT;
	const storiesTable = renderStoriesTable(prd.userStories ?? []);
	const notes = prd.notes?.trim() || NO_NOTES_TEXT;

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
	].join('\n');
}

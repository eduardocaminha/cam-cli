// src/supervisor/task-prompt.ts
//
// Builds the per-story task prompt injected into the implementer worker spawn.
//
// US-001 (CAM-224): decideNextAction's storyId is authoritative for the
// implement dispatch. The supervisor matches that id against the already-read
// prd.json snapshot and embeds the exact story record (id, title,
// description, acceptanceCriteria, priority, requires) plus the PRD's
// branchName into the worker's task prompt, replacing the generic "pick a
// story yourself" instruction that made the worker re-read the full prd.json
// to self-select.

import type { PrdSnapshot } from './decide.ts';

/** The story shape consumed by buildImplementerTaskPrompt: a single entry
 *  from PrdSnapshot['userStories']. */
export type TaskPromptStory = NonNullable<PrdSnapshot['userStories']>[number];

/**
 * Build the free-text task prompt sent to the implementer worker for a single,
 * supervisor-selected story.
 *
 * Embeds the story's id, title, description, acceptanceCriteria, priority,
 * and requires, plus branchName, so the worker implements exactly this story
 * without re-reading prd.json to self-select.
 */
export function buildImplementerTaskPrompt(story: TaskPromptStory, branchName: string): string {
	const criteria = (story.acceptanceCriteria ?? []).map((c, i) => `  ${i + 1}. ${c}`);
	return [
		`Implement user story ${story.id ?? 'unknown'} from scripts/cam/prd.json per your AGENT.md.`,
		'This exact story has already been selected by the supervisor; do not self-select a different story.',
		'',
		`Story ID: ${story.id ?? 'unknown'}`,
		`Title: ${story.title ?? ''}`,
		`Description: ${story.description ?? ''}`,
		`Priority: ${story.priority ?? ''}`,
		`Requires: ${story.requires ?? 'none'}`,
		`Branch: ${branchName}`,
		'Acceptance Criteria:',
		...(criteria.length > 0 ? criteria : ['  (none listed)']),
	].join('\n');
}

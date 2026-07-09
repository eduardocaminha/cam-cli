// test/release/pr-body.test.ts
//
// Unit tests for composePrTitle and composePrBody (src/release/pr-body.ts).
//
// Verifies: title format '<type>: <descriptive text> (CAM-<N>)' (type
// defaults to feat, descriptive text falls back description -> project ->
// placeholder, issue reference is textual 'CAM-<N>' and cleanly omitted when
// absent), the four PR body sections, stories table rendering (id, title,
// checked box on passes:true), Testing/Notes fallback text, and the
// no-em-dash persisted-artifact rule.
//
// CAM-149 US-001, US-005.

import { describe, expect, test } from 'bun:test';
import { composePrBody, composePrTitle, type PrdSnapshot } from '../../src/release/pr-body.ts';

const BASE_PRD: PrdSnapshot = {
	project: 'cam-cli',
	description: 'Deterministic ship runner for the sidecar loop.',
	issueNumber: 149,
	type: 'feat',
	userStories: [
		{ id: 'US-001', title: 'Add deterministic PR title/body composer', passes: true },
		{ id: 'US-002', title: 'Implement the pre-PR ship sequence', passes: false },
	],
};

describe('composePrTitle', () => {
	test('returns "<type>: <description> (CAM-<N>)" when all fields are present', () => {
		expect(composePrTitle(BASE_PRD)).toBe('feat: Deterministic ship runner for the sidecar loop. (CAM-149)');
	});

	test('falls back to the project name when description is absent', () => {
		expect(composePrTitle({ project: 'cam-cli', type: 'fix', issueNumber: 7 })).toBe('fix: cam-cli (CAM-7)');
	});

	test('falls back to the project name when description is empty/whitespace', () => {
		expect(composePrTitle({ project: 'cam-cli', description: '   ', type: 'feat', issueNumber: 7 })).toBe('feat: cam-cli (CAM-7)');
	});

	test('never returns an empty string, even with an empty snapshot', () => {
		const title = composePrTitle({});
		expect(title.length).toBeGreaterThan(0);
	});

	test('defaults type to feat when the snapshot lacks one', () => {
		expect(composePrTitle({ description: 'No type on this PRD.', issueNumber: 5 })).toBe('feat: No type on this PRD. (CAM-5)');
	});

	test('uses the textual CAM-<N> issue reference, never #<N>', () => {
		const title = composePrTitle(BASE_PRD);
		expect(title).toContain('CAM-149');
		expect(title).not.toContain('#');
	});

	test('cleanly omits the issue suffix when issueNumber is absent, no trailing whitespace or parens', () => {
		const title = composePrTitle({ description: 'No issue on this PRD.', type: 'feat' });
		expect(title).toBe('feat: No issue on this PRD.');
		expect(title.endsWith(')')).toBe(false);
		expect(title.endsWith(' ')).toBe(false);
	});

	test('cleanly omits the issue suffix when issueNumber is null', () => {
		const title = composePrTitle({ description: 'Null issue.', type: 'feat', issueNumber: null as unknown as undefined });
		expect(title).toBe('feat: Null issue.');
	});
});

describe('composePrBody', () => {
	test('renders all four sections in order', () => {
		const body = composePrBody(BASE_PRD);
		const summaryIdx = body.indexOf('## Summary');
		const storiesIdx = body.indexOf('## Stories completed');
		const testingIdx = body.indexOf('## Testing');
		const notesIdx = body.indexOf('## Notes');

		expect(summaryIdx).toBeGreaterThanOrEqual(0);
		expect(storiesIdx).toBeGreaterThan(summaryIdx);
		expect(testingIdx).toBeGreaterThan(storiesIdx);
		expect(notesIdx).toBeGreaterThan(testingIdx);
	});

	test('Summary section carries prd.description', () => {
		const body = composePrBody(BASE_PRD);
		expect(body).toContain('Deterministic ship runner for the sidecar loop.');
	});

	test('Summary falls back to placeholder text when description is absent', () => {
		const body = composePrBody({ project: 'cam-cli' });
		expect(body).toContain('No summary provided.');
	});

	test('Stories completed table lists every story with id, title, and checked box', () => {
		const body = composePrBody(BASE_PRD);
		expect(body).toContain('US-001');
		expect(body).toContain('Add deterministic PR title/body composer');
		expect(body).toContain('| US-001 | Add deterministic PR title/body composer | [x] |');
		expect(body).toContain('| US-002 | Implement the pre-PR ship sequence | [ ] |');
	});

	test('Stories completed falls back to placeholder text when there are no stories', () => {
		const body = composePrBody({ project: 'cam-cli' });
		expect(body).toContain('No stories recorded.');
	});

	test('Testing section states the deterministic gate spine ran green at ship time', () => {
		const body = composePrBody(BASE_PRD);
		expect(body).toContain('bun run check:all');
		expect(body).toContain('ran green at ship time');
	});

	test('Notes section carries PRD-level remarks when present', () => {
		const body = composePrBody({ ...BASE_PRD, notes: 'Reviewer flagged a follow-up for CAM-150.' });
		expect(body).toContain('Reviewer flagged a follow-up for CAM-150.');
	});

	test('Notes section falls back to placeholder text when absent', () => {
		const body = composePrBody(BASE_PRD);
		expect(body).toContain('## Notes\n\nNone.');
	});

	test('output contains no em-dash characters', () => {
		const body = composePrBody({
			...BASE_PRD,
			description: 'Some description without a dash',
			notes: 'Some notes without a dash',
		});
		expect(body).not.toContain('—');
	});
});

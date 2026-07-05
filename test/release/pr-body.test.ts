// test/release/pr-body.test.ts
//
// Unit tests for composePrTitle and composePrBody (src/release/pr-body.ts).
//
// Verifies: title fallback chain (description -> project -> placeholder,
// never empty), the four PR body sections, stories table rendering (id,
// title, checked box on passes:true), Testing/Notes fallback text, and the
// no-em-dash persisted-artifact rule.
//
// CAM-149 US-001.

import { describe, expect, test } from 'bun:test';
import { composePrBody, composePrTitle, type PrdSnapshot } from '../../src/release/pr-body.ts';

const BASE_PRD: PrdSnapshot = {
	project: 'cam-cli',
	description: 'Deterministic ship runner for the sidecar loop.',
	issueNumber: 149,
	userStories: [
		{ id: 'US-001', title: 'Add deterministic PR title/body composer', passes: true },
		{ id: 'US-002', title: 'Implement the pre-PR ship sequence', passes: false },
	],
};

describe('composePrTitle', () => {
	test('returns the PRD description when present', () => {
		expect(composePrTitle(BASE_PRD)).toBe('Deterministic ship runner for the sidecar loop.');
	});

	test('falls back to the project name when description is absent', () => {
		expect(composePrTitle({ project: 'cam-cli' })).toBe('cam-cli');
	});

	test('falls back to the project name when description is empty/whitespace', () => {
		expect(composePrTitle({ project: 'cam-cli', description: '   ' })).toBe('cam-cli');
	});

	test('never returns an empty string, even with an empty snapshot', () => {
		const title = composePrTitle({});
		expect(title.length).toBeGreaterThan(0);
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

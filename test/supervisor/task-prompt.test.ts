// test/supervisor/task-prompt.test.ts
//
// US-001 (CAM-224): unit tests for buildImplementerTaskPrompt, the
// supervisor-owned builder that embeds a selected story record + branchName
// into the implementer worker's task prompt.

import { describe, expect, test } from 'bun:test';
import { buildImplementerTaskPrompt } from '../../src/supervisor/task-prompt.ts';

describe('buildImplementerTaskPrompt', () => {
	test('embeds id, title, description, acceptanceCriteria, priority, requires, and branchName', () => {
		const story = {
			id: 'US-042',
			title: 'Add the widget frobnicator',
			description: 'As a user, I need the widget to frobnicate on demand.',
			acceptanceCriteria: ['Widget frobnicates on click.', 'Typecheck passes.'],
			priority: 3,
			passes: false,
			requires: null,
		};

		const prompt = buildImplementerTaskPrompt(story, 'cam/issue-224');

		expect(prompt).toContain('US-042');
		expect(prompt).toContain('Add the widget frobnicator');
		expect(prompt).toContain('As a user, I need the widget to frobnicate on demand.');
		expect(prompt).toContain('Widget frobnicates on click.');
		expect(prompt).toContain('Typecheck passes.');
		expect(prompt).toContain('3');
		expect(prompt).toContain('cam/issue-224');
	});

	test('renders requires: "operator" verbatim when present', () => {
		const story = {
			id: 'US-050',
			title: 'Manual E2E pass',
			description: 'Operator ceremony.',
			acceptanceCriteria: ['Operator confirms behavior.'],
			priority: 9,
			passes: false,
			requires: 'operator',
		};

		const prompt = buildImplementerTaskPrompt(story, 'cam/issue-224');

		expect(prompt).toContain('operator');
	});

	test('degrades gracefully when optional fields are absent', () => {
		const story = { id: 'US-999' };

		const prompt = buildImplementerTaskPrompt(story, 'main');

		expect(prompt).toContain('US-999');
		expect(prompt).toContain('main');
		expect(prompt).toContain('(none listed)');
	});
});

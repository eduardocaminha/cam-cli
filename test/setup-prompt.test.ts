// test/setup-prompt.test.ts
//
// Unit tests for buildSetupPrompt(). The function is a pure string builder;
// we assert that the returned prompt contains the check:all adaptation guidance
// for both 'new' and 'existing' project modes.

import { describe, expect, it } from 'bun:test';
import { buildSetupPrompt } from '../src/commands/setup.ts';

describe('buildSetupPrompt', () => {
	const modes = ['new', 'existing'] as const;

	for (const mode of modes) {
		it(`(${mode}) names bun run check:all as an adaptation point`, () => {
			const prompt = buildSetupPrompt({ projectMode: mode, description: 'test project' });
			expect(prompt).toContain('bun run check:all');
		});

		it(`(${mode}) instructs agent to map check:all to the project equivalent aggregate gate`, () => {
			const prompt = buildSetupPrompt({ projectMode: mode, description: 'test project' });
			// Must mention mapping to an equivalent aggregate gate
			expect(prompt).toMatch(/equivalent aggregate gate/);
		});

		it(`(${mode}) instructs agent to degrade to typecheck + test when no aggregate gate exists`, () => {
			const prompt = buildSetupPrompt({ projectMode: mode, description: 'test project' });
			expect(prompt).toMatch(/degrade to typecheck \+ test/);
		});
	}

	it('(new) includes the operator-provided project description', () => {
		const prompt = buildSetupPrompt({ projectMode: 'new', description: 'my cool app' });
		expect(prompt).toContain('my cool app');
	});

	it('(existing) instructs agent to infer from the codebase', () => {
		const prompt = buildSetupPrompt({ projectMode: 'existing', description: '' });
		expect(prompt).toContain('Infer everything from the codebase');
	});
});

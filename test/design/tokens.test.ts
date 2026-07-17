// test/design/tokens.test.ts
//
// US-001 (CAM-332): guards the brand-token module.
//   1. The four brand greens and five brand neutrals are exported with the
//      exact hex values the acceptance criteria specify.
//   2. `palette` (chrome status roles) stays exported separately from the
//      brand tokens, untouched.
//   3. The four subagent figure-only colors never leak into ANY exported
//      token of this module (mirrors the negative file-assert oracle), so a
//      future accidental addition to chrome fails the suite instead of only
//      failing at grep-time in CI.

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { brandGreens, brandNeutrals, palette } from '../../src/design/tokens';

const SUBAGENT_FIGURE_COLORS = ['#426DFF', '#AFE220', '#FFDF24', '#FF6666'];

describe('brandGreens', () => {
	test('exports the four brand greens with their exact hex values', () => {
		expect(brandGreens.firGreen).toBe('#10C66F');
		expect(brandGreens.forestGreen).toBe('#003333');
		expect(brandGreens.aeroGreen).toBe('#CAFFE3');
		expect(brandGreens.white).toBe('#FFFFFF');
	});
});

describe('brandNeutrals', () => {
	test('exports the five brand neutrals with their exact hex values', () => {
		expect(brandNeutrals.ink).toBe('#1F1F1F');
		expect(brandNeutrals.secondaryText).toBe('#6F6F6F');
		expect(brandNeutrals.secondaryTextOnDark).toBe('#9C9C9C');
		expect(brandNeutrals.surface).toBe('#EDECF0');
		expect(brandNeutrals.line).toBe('#E3E3E5');
	});
});

describe('palette (chrome, unaffected by brand tokens)', () => {
	test('keeps its existing semantic status roles', () => {
		expect(palette.accent).toBe('#4EBE7D');
		expect(palette.warning).toBe('#FFCB1F');
		expect(palette.destructive).toBe('#F25F5C');
		expect(palette.muted).toBe('#808080');
	});
});

describe('subagent figure-only colors', () => {
	test('never appear in any exported token value of the design-token module', () => {
		const exportedValues = [
			...Object.values(palette),
			...Object.values(brandGreens),
			...Object.values(brandNeutrals),
		];
		for (const figureColor of SUBAGENT_FIGURE_COLORS) {
			expect(exportedValues).not.toContain(figureColor);
		}
	});

	test('never appear anywhere in the design-token module source, including comments', () => {
		const source = readFileSync(`${import.meta.dir}/../../src/design/tokens.ts`, 'utf8');
		for (const figureColor of SUBAGENT_FIGURE_COLORS) {
			expect(source).not.toContain(figureColor);
		}
	});
});

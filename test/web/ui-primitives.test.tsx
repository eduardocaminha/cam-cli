// test/web/ui-primitives.test.tsx
//
// The four primitives the operator screen is built from, exercised through
// static rendering and no DOM harness (ADR-0067). What is asserted is what the
// operator or a screen reader can observe -- a real disclosure, a progress bar
// that states its position, a badge that carries its family -- never the class
// list a component happens to spell.

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { AttentionCard } from '../../webui/src/components/ui/attention-card.tsx';
import { Badge } from '../../webui/src/components/ui/badge.tsx';
import {
	CardDisclosure,
	CardPanel,
	CardSummary,
	CardTitle,
} from '../../webui/src/components/ui/card.tsx';
import { Progress } from '../../webui/src/components/ui/progress.tsx';
import { Separator } from '../../webui/src/components/ui/separator.tsx';
import { cn } from '../../webui/src/lib/cn.ts';

describe('ui primitives', () => {
	test('a card disclosure is native, and closed never means absent', () => {
		const html = renderToStaticMarkup(
			<CardDisclosure>
				<CardSummary>
					<CardTitle>Backlog plannable</CardTitle>
				</CardSummary>
				<CardPanel>duas issues</CardPanel>
			</CardDisclosure>,
		);

		expect(html.startsWith('<details')).toBe(true);
		expect(html).toContain('<summary');
		expect(html).toContain('>Backlog plannable</h2>');
		// Collapsed is a rendering state: the body is in the markup either way.
		expect(html).toContain('duas issues');
		expect(html).not.toContain('open=""');
		expect(renderToStaticMarkup(<CardDisclosure open />)).toContain('open=""');
	});

	test('progress states its position to assistive tech and to the eye', () => {
		const html = renderToStaticMarkup(<Progress label="Fase verify" value={33} />);

		expect(html).toContain('role="progressbar"');
		expect(html).toContain('aria-label="Fase verify"');
		expect(html).toContain('aria-valuenow="33"');
		expect(html).toContain('aria-valuetext="33%"');
		// The visible half: the label, the reading, and a track filled to it.
		expect(html).toContain('Fase verify');
		expect(html).toContain('>33%<');
		expect(html).toContain('width:33%');
	});

	test('a badge carries the family it was told, and is neutral by default', () => {
		// The family, not the tint strength: the alpha is a design value.
		expect(renderToStaticMarkup(<Badge variant="warning">waiting-user</Badge>))
			.toContain('bg-warning/');
		expect(renderToStaticMarkup(<Badge>ocioso</Badge>)).toContain('bg-primary');
	});

	test('the attention card is the acid surface and announces its title', () => {
		const html = renderToStaticMarkup(
			<AttentionCard title="O executor tem uma pergunta">corpo</AttentionCard>,
		);
		// The family, not the exact wash: acid marks what waits on the operator.
		expect(html).toContain('bg-attention-surface');
		expect(html).toContain('border-attention-ui');
		expect(html).toContain('O executor tem uma pergunta');
		expect(html).toContain('corpo');
	});

	test('the visual separator uses the native horizontal-rule semantic', () => {
		const html = renderToStaticMarkup(<Separator />);

		expect(html.startsWith('<hr')).toBe(true);
		expect(html).not.toContain('role="separator"');
	});

	test('cn keeps the declared order and drops the branches that produced nothing', () => {
		expect(cn('p-6', false, undefined, '', 'flex')).toBe('p-6 flex');
	});
});

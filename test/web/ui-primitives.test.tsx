// test/web/ui-primitives.test.tsx
//
// The four primitives the operator screen is built from, exercised through
// static rendering and no DOM harness (ADR-0067). What is asserted is what the
// operator or a screen reader can observe -- a real disclosure, a progress bar
// that states its position, a badge that carries its family. Layout primitives
// additionally assert their spacing roles, because those roles are their API.

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
import { CardGrid, CardSplit, CardStack, FormField, FormStack } from '../../webui/src/components/ui/card-layout.tsx';
import { EmptyState } from '../../webui/src/components/ui/empty-state.tsx';
import { Progress } from '../../webui/src/components/ui/progress.tsx';
import { Separator } from '../../webui/src/components/ui/separator.tsx';
import {
	Tabs,
	TabsList,
	TabsPanel,
	TabsTab,
} from '../../webui/src/components/ui/tabs.tsx';
import { cn } from '../../webui/src/lib/cn.ts';

describe('ui primitives', () => {
	test('card composition owns its standard, compact, split and form rhythm', () => {
		const standard = renderToStaticMarkup(<CardStack><div>one</div><div>two</div></CardStack>);
		const compact = renderToStaticMarkup(<CardGrid as="ul" compact equalHeight><li>one</li></CardGrid>);
		const split = renderToStaticMarkup(<CardSplit><div>left</div><div>right</div></CardSplit>);
		const form = renderToStaticMarkup(<FormStack><FormField htmlFor="name">Name</FormField></FormStack>);
		expect(standard).toContain('data-slot="card-stack"');
		expect(standard).toContain('gap-6');
		expect(compact).toContain('data-density="compact"');
		expect(compact).toContain('gap-4');
		expect(compact).toContain('auto-rows-fr');
		expect(split).toContain('xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]');
		expect(form).toContain('data-slot="form-stack"');
		expect(form).toContain('gap-3');
		expect(form).toContain('data-slot="form-field"');
		expect(form).toContain('gap-1');
	});
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

	test('tabs keep every label in a named horizontal scroller with reduced motion support', () => {
		const html = renderToStaticMarkup(
			<Tabs defaultValue="queue">
				<TabsList aria-label="Work">
					<TabsTab value="queue">Queue</TabsTab>
					<TabsTab value="approval">Approval</TabsTab>
					<TabsTab value="ideas">Ideas</TabsTab>
					<TabsTab value="suggestions">Suggestions</TabsTab>
				</TabsList>
				<TabsPanel value="queue">Queue panel</TabsPanel>
			</Tabs>,
		);

		expect(html).toContain('data-slot="tabs-scroll"');
		expect(html).toContain('overflow-x-auto');
		expect(html).toContain('after:to-muted');
		expect(html).toContain('pr-8');
		expect(html).toContain('sm:pr-0.5');
		expect(html).toContain('py-0.5');
		expect(html).toContain('pl-0.5');
		expect(html).toContain('aria-label="Work"');
		for (const label of ['Queue', 'Approval', 'Ideas', 'Suggestions']) {
			expect(html).toContain(`>${label}</button>`);
		}
		expect(html).toContain('whitespace-nowrap');
		expect(html).toContain('pointer-coarse:min-h-11');
		expect(html).toContain('motion-reduce:transition-none');
	});

	test('a compact empty state keeps its explanation without reserving a tall region', () => {
		const html = renderToStaticMarkup(<EmptyState compact>No pending proposals.</EmptyState>);

		expect(html).toContain('data-density="compact"');
		expect(html).toContain('No pending proposals.');
		expect(html).not.toContain('min-h-24');
		expect(html).not.toContain('p-6');
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

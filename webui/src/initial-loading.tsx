import React from 'react';
import { Button } from './components/ui/button.tsx';
import type { Locale } from './locale.ts';

/** A local main-area boundary while an operational scope is being hydrated. */
export function InitialOperationalLoading({ locale }: { locale: Locale }): React.ReactElement {
	return <main aria-busy="true" aria-label={locale === 'pt-BR' ? 'Carregamento operacional' : 'Operational loading'} className="flex min-h-0 w-full min-w-0 flex-1 overflow-y-auto p-4 lg:p-6" id="main-content" tabIndex={-1}>
		<div className="mx-auto flex w-full max-w-(--content-measure) flex-col gap-6" role="status">
			<span className="sr-only">{locale === 'pt-BR' ? 'Carregando dados operacionais…' : 'Loading operational data…'}</span>
			<div aria-hidden="true" className="flex flex-col gap-3">
				<div className="h-7 w-48 rounded-md bg-muted" />
				<div className="h-4 w-80 max-w-full rounded-md bg-muted" />
			</div>
			<div aria-hidden="true" className="rounded-2xl border border-border bg-card p-5">
				<div className="flex flex-col gap-4">
					<div className="h-4 w-1/3 rounded-md bg-muted" />
					<div className="h-4 w-full rounded-md bg-muted" />
					<div className="h-4 w-4/5 rounded-md bg-muted" />
				</div>
			</div>
		</div>
	</main>;
}

/** A failed first read remains explicit instead of rendering unknown data as empty. */
export function InitialOperationalFailure({
	locale,
	detail,
	onRetry,
}: {
	locale: Locale;
	detail: string;
	onRetry: () => void;
}): React.ReactElement {
	const Portuguese = locale === 'pt-BR';
	return <main aria-busy="false" className="flex min-h-0 w-full min-w-0 flex-1 overflow-y-auto p-4 lg:p-6" id="main-content" tabIndex={-1}>
		<div className="mx-auto flex w-full max-w-(--content-measure) flex-col gap-3">
			<p role="alert">{Portuguese ? 'Não foi possível carregar os dados operacionais.' : 'Operational data could not be loaded.'}</p>
			<p className="text-muted-foreground text-sm">{detail}</p>
			<Button className="mt-1 self-start" onClick={onRetry} type="button">{Portuguese ? 'Tentar novamente' : 'Try again'}</Button>
		</div>
	</main>;
}

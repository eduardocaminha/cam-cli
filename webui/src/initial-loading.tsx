import React from 'react';
import { Button } from './components/ui/button.tsx';
import type { Locale } from './locale.ts';

/** The only initial render allowed before a coherent operational snapshot. */
export function InitialOperationalLoading({ locale }: { locale: Locale }): React.ReactElement {
	return <main aria-busy="true" className="p-6" id="main-content" tabIndex={-1}>
		<p role="status">{locale === 'pt-BR' ? 'Carregando dados operacionais…' : 'Loading operational data…'}</p>
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
	return <main className="p-6" id="main-content" tabIndex={-1}>
		<p role="alert">{Portuguese ? 'Não foi possível carregar os dados operacionais.' : 'Operational data could not be loaded.'}</p>
		<p className="text-muted-foreground text-sm">{detail}</p>
		<Button className="mt-4" onClick={onRetry} type="button">{Portuguese ? 'Tentar novamente' : 'Try again'}</Button>
	</main>;
}

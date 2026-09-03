import React from 'react';
import type { Locale } from './locale.ts';

/** A failed read is named where its dependent surface would otherwise look empty. */
export function OperationalUnavailable({ resource, detail, locale }: {
	resource: string;
	detail: string;
	locale: Locale;
}): React.ReactElement {
	const Portuguese = locale === 'pt-BR';
	return <div className="rounded-xl border border-warning-ui bg-warning-surface p-4 text-sm" role="alert">
		<p className="font-medium">{Portuguese ? `${resource} está indisponível.` : `${resource} is unavailable.`}</p>
		<p className="mt-1 break-words text-muted-foreground">{detail}</p>
	</div>;
}

/** Keeps a previously revealed value visible while naming a failed refresh. */
export function OperationalReadPanel({ resource, detail, loaded, locale, children }: {
	resource: string;
	detail: string | undefined;
	loaded: boolean;
	locale: Locale;
	children: React.ReactNode;
}): React.ReactElement {
	if (detail === undefined) return <>{children}</>;
	const unavailable = <OperationalUnavailable detail={detail} locale={locale} resource={resource} />;
	return loaded ? <>{unavailable}{children}</> : unavailable;
}

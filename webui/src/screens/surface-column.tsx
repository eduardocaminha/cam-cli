import type React from 'react';
import { MAIN_CONTENT_ID } from '../app-shell.tsx';

/** Shared scrolling column for route-owned screens. */
export function SurfaceColumn({
	label,
	status,
	children,
}: {
	label: string;
	status: string | null;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<main
			aria-label={label}
			className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-y-auto p-4 lg:p-6"
			id={MAIN_CONTENT_ID}
			tabIndex={-1}
		>
			<div className="mx-auto flex w-full max-w-(--content-measure) flex-1 flex-col gap-6">
				{status === null ? null : (
					<output aria-live="polite" className="break-words text-muted-foreground text-sm">
						{status}
					</output>
				)}
				{children}
			</div>
		</main>
	);
}

import type React from 'react';
import { MAIN_CONTENT_ID, ShellContentFrame } from '../app-shell.tsx';
import { CardStack } from '../components/ui/card-layout.tsx';

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
			<ShellContentFrame className="flex flex-1 flex-col">
				<CardStack className="flex-1">
					{status === null ? null : (
						<output aria-live="polite" className="break-words text-muted-foreground text-sm">
							{status}
						</output>
					)}
					{children}
				</CardStack>
			</ShellContentFrame>
		</main>
	);
}

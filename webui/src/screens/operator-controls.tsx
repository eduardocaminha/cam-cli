// webui/src/screens/operator-controls.tsx

import React from 'react';
import { Button, buttonVariants } from '../components/ui/button.tsx';
import { CardAction, CardDisclosure, CardPanel, CardSummary, CardTitle } from '../components/ui/card.tsx';

export const BUTTON_CLASS = buttonVariants({ variant: 'outline' });
export const PRIMARY_BUTTON_CLASS = buttonVariants({ variant: 'default' });

export function ActionButton({ label, enabled, onClick }: { label: string; enabled: boolean; onClick: () => void }): React.ReactElement {
	return <Button variant="outline" disabled={!enabled} onClick={onClick} type="button">{label}</Button>;
}

export function ContextPanel({ title, description, open = false, children, actionLabels = { open: 'open', close: 'close' } }: { title: string; description: string; open?: boolean; children: React.ReactNode; actionLabels?: { open: string; close: string } }): React.ReactElement {
	return (
		<CardDisclosure className="group" open={open}>
			<CardSummary>
				<CardTitle>{title}</CardTitle>
				<CardAction aria-hidden="true">
					<span className="text-muted-foreground text-xs group-open:hidden">{actionLabels.open}</span>
					<span className="hidden text-muted-foreground text-xs group-open:inline">{actionLabels.close}</span>
				</CardAction>
			</CardSummary>
			<CardPanel>
				<p className="text-muted-foreground text-sm">{description}</p>
				{children}
			</CardPanel>
		</CardDisclosure>
	);
}

// webui/src/screens/unavailable-project-screen.tsx

import React from 'react';
import type { AppProps } from '../app-props.ts';
import type { RegisteredProjectView } from '../client.ts';
import { Badge } from '../components/ui/badge.tsx';
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '../components/ui/card.tsx';
import { LOCALE_CATALOG } from '../locale.ts';
import type { Locale } from '../locale.ts';
import { SurfaceColumn } from './surface-column.tsx';
import { UnregisterProjectPanel } from './projects.tsx';

export function UnavailableProjectSurface({
	project,
	locale,
	pending,
	status,
	onUnregisterProject,
}: Pick<AppProps, 'pending' | 'onUnregisterProject'> & {
	project: RegisteredProjectView;
	locale: Locale;
	status: string | null;
}): React.ReactElement {
	const catalog = LOCALE_CATALOG[locale].projects;
	return (
		<SurfaceColumn label={project.name} status={status}>
			<Card>
				<CardHeader>
					<CardTitle>{project.name}</CardTitle>
					<CardDescription>{project.repository ?? catalog.repositoryUnknown}</CardDescription>
				</CardHeader>
				<CardPanel>
					<Badge variant={project.readiness === 'ready' ? 'success' : 'warning'}>{catalog.readiness[project.readiness]}</Badge>
					<h2 className="font-semibold text-lg">{catalog.unavailableTitle}</h2>
					<p className="text-muted-foreground text-sm">{catalog.unavailableDescription}</p>
				</CardPanel>
			</Card>
			<UnregisterProjectPanel
				catalog={catalog}
				onUnregisterProject={onUnregisterProject}
				pending={pending}
				project={project}
			/>
		</SurfaceColumn>
	);
}

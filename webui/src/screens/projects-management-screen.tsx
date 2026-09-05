import React from 'react';
import type { AppProps } from '../app-props.ts';
import { LOCALE_CATALOG } from '../locale.ts';
import { SurfaceColumn } from './surface-column.tsx';
import { CardGrid } from '../components/ui/card-layout.tsx';
import { CreateProjectPanel, ImportProjectPanel, RegisterProjectPanel } from './projects.tsx';

/** Global registry management remains separate from the operational overview. */
export function ProjectsManagementSurface(props: AppProps): React.ReactElement {
	const catalog = LOCALE_CATALOG[props.locale].projects;
	return (
		<SurfaceColumn label={catalog.title} status={props.status}>
			<div>
				<h2 className="font-semibold text-xl tracking-tight">{catalog.title}</h2>
				<p className="mt-1 text-muted-foreground text-sm">{catalog.description}</p>
			</div>
			<CreateProjectPanel catalog={catalog} onCreateProject={props.onCreateProject} pending={props.pending} projectOnboardingPending={props.projectOnboardingPending} />
			<CardGrid className="md:grid-cols-2">
				<ImportProjectPanel catalog={catalog} onImportProject={props.onImportProject} pending={props.pending} projectOnboardingPending={props.projectOnboardingPending} />
				<RegisterProjectPanel catalog={catalog} onRegisterProject={props.onRegisterProject} pending={props.pending} />
			</CardGrid>
		</SurfaceColumn>
	);
}

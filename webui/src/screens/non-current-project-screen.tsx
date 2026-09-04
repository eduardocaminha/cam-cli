// webui/src/screens/non-current-project-screen.tsx

import React from 'react';
import type { AppProps } from '../app-props.ts';
import type { RegisteredProjectView } from '../client.ts';
import { LOCALE_CATALOG } from '../locale.ts';
import type { RouteSelection } from '../routes.ts';
import { HomeSurface } from './home-screen.tsx';
import { UnregisterProjectPanel } from './projects.tsx';
import { RunsSurface } from './runs-screen.tsx';
import { SettingsSurface } from './settings-screen.tsx';
import { UnavailableProjectSurface } from './unavailable-project-screen.tsx';
import { WorkSurface } from './work-screen.tsx';

export function NonCurrentProjectSurface({
	inspectorOpen,
	props,
	selectedProject,
	surface,
}: {
	inspectorOpen: boolean;
	props: AppProps;
	selectedProject: RegisteredProjectView;
	surface: RouteSelection['surface'];
}): React.ReactElement {
	if (selectedProject.readiness === 'ready') {
		if (surface === 'conversation') return <HomeSurface {...props} inspectorOpen={inspectorOpen} projectId={selectedProject.id} />;
		if (surface === 'runs') return <RunsSurface {...props} />;
		if (surface === 'work') return <WorkSurface {...props} />;
		if (surface === 'settings') {
			/* The remove card rides inside the Project tab: as a sibling of the
			 * surface it would join the shell's flex row and steal its width. */
			return (
				<SettingsSurface
					{...props}
					removePanel={
						<UnregisterProjectPanel
							catalog={LOCALE_CATALOG[props.locale].projects}
							onUnregisterProject={props.onUnregisterProject}
							pending={props.pending}
							project={selectedProject}
						/>
					}
				/>
			);
		}
	}
	return (
		<UnavailableProjectSurface
			locale={props.locale}
			onUnregisterProject={props.onUnregisterProject}
			pending={props.pending}
			project={selectedProject}
			status={props.status}
		/>
	);
}

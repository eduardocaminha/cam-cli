// webui/src/screens/onboarding-screen.tsx

import React from 'react';
import type { AppProps } from '../app-props.ts';
import type { ProjectStatusView } from '../client.ts';
import { Badge } from '../components/ui/badge.tsx';
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '../components/ui/card.tsx';
import { Separator } from '../components/ui/separator.tsx';
import type { OnboardingCatalog } from '../locale.ts';
import { SurfaceColumn } from './surface-column.tsx';
import { TEXT_LINK_CLASS } from './operator-links.ts';

export const PROJECT_RECOVERY_COMMAND: Readonly<Record<
	Exclude<ProjectStatusView, { state: 'ready' | 'empty' | 'checking' }>['reason'],
	string
>> = {
	'not-repository': 'cd /path/to/project && gship',
	'origin-missing': 'git remote add origin git@github.com:OWNER/REPO.git && git fetch origin main',
	'github-origin-required': 'git remote set-url origin git@github.com:OWNER/REPO.git',
	'origin-main-missing': 'git fetch origin main',
};

export function CommandLine({ children }: { children: string }): React.ReactElement {
	return (
		<code className="block overflow-x-auto rounded-lg bg-muted px-3 py-2 text-xs">
			{children}
		</code>
	);
}

/**
 * First-run guidance, not a project manager: a browser cannot change the cwd
 * of this process or a container mount, so every path ends by restarting
 * Gateship from the intended local clone.
 */
export function OnboardingSurface({
	catalog,
	project,
	settingsHref,
	status,
}: Pick<AppProps, 'project' | 'status'> & { catalog: OnboardingCatalog; settingsHref: string }): React.ReactElement {
	return (
		<SurfaceColumn label={catalog.title} status={status}>
			<Card>
				<CardHeader>
					<CardTitle>{catalog.cardTitle}</CardTitle>
					<CardDescription>{catalog.description}</CardDescription>
				</CardHeader>
				<CardPanel>
					{project.state === 'checking' ? (
						<p className="text-muted-foreground text-sm">{project.detail}</p>
					) : null}
					{project.state === 'empty' ? (
						<>
							<p className="text-muted-foreground text-sm">{project.detail}</p>
							<section className="flex flex-col gap-2">
								<h3 className="font-medium text-sm">{catalog.existingProject.title}</h3>
								<p className="text-muted-foreground text-sm">
									{catalog.existingProject.guidance}
								</p>
								<CommandLine>cd /path/to/project && gship</CommandLine>
							</section>
							<Separator />
							<section className="flex flex-col gap-2">
								<h3 className="font-medium text-sm">{catalog.newProject.title}</h3>
								<p className="text-muted-foreground text-sm">
									{catalog.newProject.guidance}
								</p>
								<CommandLine>gh repo create OWNER/REPO --private --add-readme --clone</CommandLine>
								<CommandLine>cd REPO && gship</CommandLine>
							</section>
						</>
					) : null}
					{project.state === 'needs-attention' ? (
						<>
							<div className="flex flex-col gap-2">
								<Badge variant="warning">{catalog.incompleteBadge}</Badge>
								<p className="text-sm">{project.detail}</p>
							</div>
							<CommandLine>{PROJECT_RECOVERY_COMMAND[project.reason]}</CommandLine>
							<p className="text-muted-foreground text-sm">
								{catalog.recoveryGuidance}
							</p>
						</>
					) : null}
					<p className="text-muted-foreground text-sm">
						{catalog.settingsGuidance.beforeLink}
						<a className={TEXT_LINK_CLASS} href={settingsHref}>
							{catalog.settingsGuidance.linkLabel}
						</a>
						{catalog.settingsGuidance.afterLink}
					</p>
				</CardPanel>
			</Card>
		</SurfaceColumn>
	);
}

/**
 * Settings is three operator questions behind tabs: who executes (providers
 * and their models), how execution behaves (chaining, executor handoff, the
 * diagnostic schedule), and what the project is (binding, brief, session
 * handoff). Panels are unchanged; only the disclosure is new, and every
 * panel stays mounted so find-in-page keeps seeing the whole surface.
 */

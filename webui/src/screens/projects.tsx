// webui/src/screens/projects.tsx

import React from 'react';
import type { AppProps } from '../app-props.ts';
import type { ProjectOverviewView, RegisteredProjectView } from '../client.ts';
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '../components/ui/card.tsx';
import { FormField, FormStack } from '../components/ui/card-layout.tsx';
import { Input } from '../components/ui/input.tsx';
import { SelectField } from '../components/ui/select.tsx';
import { cn } from '../lib/cn.ts';
import type { ProjectsCatalog } from '../locale.ts';
import { useState } from 'react';
import { BUTTON_CLASS, PRIMARY_BUTTON_CLASS } from './operator-controls.tsx';
import { fieldReader } from './runs.tsx';

export function RegisterProjectPanel({
	catalog,
	pending,
	onRegisterProject,
}: Pick<AppProps, 'pending' | 'onRegisterProject'> & {
	catalog: ProjectsCatalog;
}): React.ReactElement {
	return (
		<Card>
			<CardHeader>
				<CardTitle>{catalog.register.title}</CardTitle>
				<CardDescription>{catalog.register.description}</CardDescription>
			</CardHeader>
			<CardPanel>
				<FormStack
					onSubmit={(event) => {
						event.preventDefault();
						const root = fieldReader(event.currentTarget)('project-root');
						if (root !== '') onRegisterProject(root);
					}}
				>
					<FormField className="text-sm" htmlFor="project-root">
						<span className="font-medium">{catalog.register.rootLabel}</span>
						<Input
							id="project-root"
							name="project-root"
							placeholder={catalog.register.rootPlaceholder}
						/>
						<span className="text-muted-foreground text-xs">{catalog.register.rootGuidance}</span>
						<span className="text-muted-foreground text-xs">{catalog.register.containerGuidance}</span>
					</FormField>
					<button className={cn(PRIMARY_BUTTON_CLASS, 'self-end')} disabled={pending} type="submit">
						{catalog.register.submit}
					</button>
				</FormStack>
			</CardPanel>
		</Card>
	);
}

/**
 * The other onboarding write project management offers: a GitHub repository, not a
 * path. Gateship owns the destination, the clone and the credential -- the
 * operator only ever names the repository, using their existing GitHub login.
 */
export function ImportProjectPanel({
	catalog,
	pending,
	projectOnboardingPending,
	onImportProject,
}: Pick<AppProps, 'pending' | 'projectOnboardingPending' | 'onImportProject'> & {
	catalog: ProjectsCatalog;
}): React.ReactElement {
	return (
		<Card>
			<CardHeader>
				<CardTitle>{catalog.import.title}</CardTitle>
				<CardDescription>{catalog.import.description}</CardDescription>
			</CardHeader>
			<CardPanel>
				<FormStack
					onSubmit={(event) => {
						event.preventDefault();
						const repository = fieldReader(event.currentTarget)('project-import-repository');
						if (repository !== '') onImportProject(repository);
					}}
				>
					<FormField className="text-sm" htmlFor="project-import-repository">
						<span className="font-medium">{catalog.import.repositoryLabel}</span>
						<Input
							id="project-import-repository"
							name="project-import-repository"
							placeholder={catalog.import.repositoryPlaceholder}
						/>
						<span className="text-muted-foreground text-xs">{catalog.import.destinationGuidance}</span>
						<span className="text-muted-foreground text-xs">{catalog.import.credentialGuidance}</span>
					</FormField>
					<button className={cn(PRIMARY_BUTTON_CLASS, 'self-end')} disabled={pending} type="submit">
						{catalog.import.submit}
					</button>
					{projectOnboardingPending === 'import'
						? <p className="text-muted-foreground text-xs" role="status">{catalog.import.pending}</p>
						: null}
				</FormStack>
			</CardPanel>
		</Card>
	);
}

/** New-repository onboarding is intentionally separate from importing or registering. */
export function CreateProjectPanel({
	catalog,
	pending,
	projectOnboardingPending,
	onCreateProject,
}: Pick<AppProps, 'pending' | 'projectOnboardingPending' | 'onCreateProject'> & {
	catalog: ProjectsCatalog;
}): React.ReactElement {
	const [repository, setRepository] = useState('');
	const [description, setDescription] = useState('');
	const [visibility, setVisibility] = useState<'private' | 'public'>('private');
	const [confirmed, setConfirmed] = useState(false);
	const namedRepository = repository.trim();
	const visibilityLabel = visibility === 'private'
		? catalog.create.privateLabel.toLocaleLowerCase()
		: catalog.create.publicLabel.toLocaleLowerCase();
	const authorization = catalog.create.confirm(namedRepository, visibilityLabel);
	return (
		<Card>
			<CardHeader>
				<CardTitle>{catalog.create.title}</CardTitle>
				<CardDescription>{catalog.create.description}</CardDescription>
			</CardHeader>
			<CardPanel>
				<FormStack
					onSubmit={(event) => {
						event.preventDefault();
						if (namedRepository === '' || !confirmed) return;
						onCreateProject({
							repository: namedRepository,
							visibility,
							...(description.trim() === '' ? {} : { description: description.trim() }),
							authorization,
						});
					}}
				>
					<FormField className="text-sm" htmlFor="project-create-repository">
						<span className="font-medium">{catalog.create.repositoryLabel}</span>
						<Input
							id="project-create-repository"
							name="project-create-repository"
							onChange={(event) => {
								setRepository((event.currentTarget as unknown as { value: string }).value);
								setConfirmed(false);
							}}
							placeholder={catalog.create.repositoryPlaceholder}
							value={repository}
						/>
					</FormField>
					<FormField className="text-sm" htmlFor="project-create-description">
						<span className="font-medium">{catalog.create.descriptionLabel}</span>
						<Input
							id="project-create-description"
							maxLength={350}
							name="project-create-description"
							onChange={(event) =>
								setDescription((event.currentTarget as unknown as { value: string }).value)}
							placeholder={catalog.create.descriptionPlaceholder}
							value={description}
						/>
					</FormField>
					<FormField className="text-sm" htmlFor="project-create-visibility">
						<span className="font-medium">{catalog.create.visibilityLabel}</span>
						<SelectField
							id="project-create-visibility"
							items={[
								{ value: 'private', label: catalog.create.privateLabel },
								{ value: 'public', label: catalog.create.publicLabel },
							]}
							name="project-create-visibility"
							onValueChange={(value) => {
								setVisibility(value as 'private' | 'public');
								setConfirmed(false);
							}}
							value={visibility}
						/>
					</FormField>
					{visibility === 'public' ? (
						<p className="text-destructive text-sm" role="alert">{catalog.create.publicWarning}</p>
					) : null}
					<p className="text-muted-foreground text-xs">{catalog.create.destinationGuidance}</p>
					<p className="text-muted-foreground text-xs">{catalog.create.credentialGuidance}</p>
					<label className="flex items-start gap-2 text-sm">
						<input
							checked={confirmed}
							disabled={pending || namedRepository === ''}
							name="project-create-confirm"
							onChange={(event) =>
								setConfirmed((event.currentTarget as unknown as { checked: boolean }).checked)}
							type="checkbox"
						/>
						<span>{authorization}</span>
					</label>
					<button className={cn(PRIMARY_BUTTON_CLASS, 'self-end')} disabled={pending || !confirmed || namedRepository === ''} type="submit">
						{catalog.create.submit}
					</button>
					{projectOnboardingPending === 'create'
						? <p className="text-muted-foreground text-xs" role="status">{catalog.create.pending}</p>
						: null}
				</FormStack>
			</CardPanel>
		</Card>
	);
}

/**
 * Removing a project is a registry write and nothing else, so the copy says
 * exactly that and the explicit confirmation is the same checkbox gate the
 * approve and abandon actions already use -- no second dialog, no new
 * confirmation surface.
 */
export function UnregisterProjectPanel({
	catalog,
	pending,
	project,
	onUnregisterProject,
}: Pick<AppProps, 'pending' | 'onUnregisterProject'> & {
	catalog: ProjectsCatalog;
	project: RegisteredProjectView;
}): React.ReactElement {
	const [confirmed, setConfirmed] = useState(false);
	return (
		<Card>
			<CardHeader>
				<CardTitle>{catalog.remove.title}</CardTitle>
				<CardDescription>{catalog.remove.description}</CardDescription>
			</CardHeader>
			<CardPanel>
				<p className="text-muted-foreground text-sm">{catalog.remove.filesRemain}</p>
				<label className="flex items-start gap-2 text-sm">
					<input
						checked={confirmed}
						disabled={pending}
						name="project-unregister-confirm"
						onChange={(event) =>
							setConfirmed((event.currentTarget as unknown as { checked: boolean }).checked)}
						type="checkbox"
					/>
					<span>{catalog.remove.confirm(project.name)}</span>
				</label>
				<button
					className={cn(BUTTON_CLASS, 'self-end')}
					disabled={pending || !confirmed}
					onClick={() => {
						setConfirmed(false);
						onUnregisterProject(project.id);
					}}
					type="button"
				>
					{catalog.remove.submit}
				</button>
			</CardPanel>
		</Card>
	);
}

export type OverviewCardEntry =
	| { project: RegisteredProjectView; snapshot: false }
	| (ProjectOverviewView & { snapshot: true });

/* One fact of a project tile: quiet label left, value right. */

// webui/src/screens/global-settings-screen.tsx

import React from 'react';
import type { AppProps } from '../app-props.ts';
import { LOCALE_CATALOG } from '../locale.ts';
import { SurfaceColumn } from './surface-column.tsx';
import { OperationalReadPanel } from '../operational-unavailable.tsx';
import { AgentDefaultsPanel, NotificationsPanel, OperatorProfilePanel, SelfUpdatePanel } from './settings.tsx';

export function GlobalSettingsSurface(props: AppProps): React.ReactElement {
	const catalog = LOCALE_CATALOG[props.locale].settings;
	const failed = (resource: keyof NonNullable<typeof props.operationalFailures>): string | undefined => props.operationalFailures?.[resource];
	const loaded = (resource: keyof NonNullable<typeof props.operationalLoaded>): boolean => props.operationalLoaded?.[resource] === true;
	const pending = (resource: keyof NonNullable<typeof props.operationalPending>): boolean => props.operationalPending?.[resource] === true;
	return (
		<SurfaceColumn label={catalog.title} status={props.status}>
			<OperationalReadPanel detail={failed('Agent defaults')} loaded={loaded('Agent defaults')} locale={props.locale} pending={pending('Agent defaults')} resource="Agent defaults"><AgentDefaultsPanel
				agentDefaults={props.agentDefaults}
				catalog={catalog}
				onSaveAgentDefaults={props.onSaveAgentDefaults}
				pending={props.pending}
			/></OperationalReadPanel>
			<OperationalReadPanel detail={failed('Operator profile')} loaded={loaded('Operator profile')} locale={props.locale} pending={pending('Operator profile')} resource="Operator profile"><OperatorProfilePanel
						catalog={catalog}
						onSaveOperatorProfile={props.onSaveOperatorProfile}
						operatorProfile={props.operatorProfile}
						pending={props.pending}
						suggestedTimezone={props.suggestedTimezone}
					/></OperationalReadPanel>
					<OperationalReadPanel detail={failed('Self update')} loaded={loaded('Self update')} locale={props.locale} pending={pending('Self update')} resource="Self update"><SelfUpdatePanel
						catalog={catalog}
						locale={props.locale}
						onSetSelfUpdate={props.onSetSelfUpdate}
						pending={props.pending}
						selfUpdate={props.selfUpdate}
					/></OperationalReadPanel>
			<OperationalReadPanel detail={failed('Notifications')} loaded={loaded('Notifications')} locale={props.locale} pending={pending('Notifications')} resource="Notifications"><NotificationsPanel
						catalog={catalog}
						notificationChannels={props.notificationChannels}
						notificationPermission={props.notificationPermission}
						onEnableNotifications={props.onEnableNotifications}
						onSendNotificationTest={props.onSendNotificationTest}
						onSaveResendSettings={props.onSaveResendSettings}
						onRemoveResendCredential={props.onRemoveResendCredential}
						pending={props.pending}
			/></OperationalReadPanel>
		</SurfaceColumn>
	);
}

/**
 * GSHIP-707, GSHIP-712, GSHIP-723: every registered ready project has its own
 * conversation, runs and work surfaces. Settings and the remaining extras stay
 * on the boot project, and a project the registry does not report ready keeps
 * the same typed answer it always had.
 */

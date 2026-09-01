// webui/src/screens/global-settings-screen.tsx

import React from 'react';
import type { AppProps } from '../app-props.ts';
import { LOCALE_CATALOG } from '../locale.ts';
import { SurfaceColumn } from './surface-column.tsx';
import { NotificationsPanel, OperatorProfilePanel, SelfUpdatePanel } from './settings.tsx';

export function GlobalSettingsSurface(props: AppProps): React.ReactElement {
	const catalog = LOCALE_CATALOG[props.locale].settings;
	return (
		<SurfaceColumn label={catalog.title} status={props.status}>
			<OperatorProfilePanel
						catalog={catalog}
						onSaveOperatorProfile={props.onSaveOperatorProfile}
						operatorProfile={props.operatorProfile}
						pending={props.pending}
						suggestedTimezone={props.suggestedTimezone}
					/>
					<SelfUpdatePanel
						catalog={catalog}
						locale={props.locale}
						onSetSelfUpdate={props.onSetSelfUpdate}
						pending={props.pending}
						selfUpdate={props.selfUpdate}
					/>
			<NotificationsPanel
						catalog={catalog}
						notificationChannels={props.notificationChannels}
						notificationPermission={props.notificationPermission}
						onEnableNotifications={props.onEnableNotifications}
						onSendNotificationTest={props.onSendNotificationTest}
						onSaveResendSettings={props.onSaveResendSettings}
						onRemoveResendCredential={props.onRemoveResendCredential}
						pending={props.pending}
			/>
		</SurfaceColumn>
	);
}

/**
 * GSHIP-707, GSHIP-712, GSHIP-723: every registered ready project has its own
 * conversation, runs and work surfaces. Settings and the remaining extras stay
 * on the boot project, and a project the registry does not report ready keeps
 * the same typed answer it always had.
 */

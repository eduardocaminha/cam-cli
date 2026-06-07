// src/commands/menu.ts
//
// `cam menu <orchPane> <dashboardPane>` — renders the interactive workspace
// menu (the bottom-right pane of `cam run`) as an Ink app. Internal command:
// not advertised in the top-level help; only `cam run` spawns it, passing the
// orchestrator + dashboard pane ids so the menu's keys can target them.

import { render } from 'ink';
import { createElement } from 'react';

import { MenuApp } from '../ui/Menu.tsx';

export interface MenuOptions {
	/** tmux pane id of the orchestrator pane (target for send-keys). */
	orchPane: string;
	/** tmux pane id of the dashboard pane (target for select-pane). */
	dashboardPane: string;
}

/**
 * Render the Ink menu and resolve with its exit code when it unmounts (the
 * operator pressed `q` or Ctrl+C, which closes the pane).
 */
export async function runMenuInk(options: MenuOptions): Promise<number> {
	const { waitUntilExit } = render(
		createElement(MenuApp, {
			orchPane: options.orchPane,
			dashboardPane: options.dashboardPane,
		}),
	);
	await waitUntilExit();
	return 0;
}

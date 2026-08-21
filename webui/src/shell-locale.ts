// The shell is the first deliberately small localization boundary. Route body
// content remains English until a complete locale surface is specified.

export type Locale = 'en-US' | 'pt-BR';

export const DEFAULT_LOCALE: Locale = 'en-US';

export interface ShellCatalog {
	operatorNavigationLabel: string;
	skipLinkLabel: string;
	routeLabels: {
		conversation: string;
		runs: string;
		work: string;
		settings: string;
	};
}

export const SHELL_CATALOG = {
	'en-US': {
		operatorNavigationLabel: 'Operator surfaces',
		skipLinkLabel: 'Skip to content',
		routeLabels: {
			conversation: 'Conversation',
			runs: 'Runs',
			work: 'Work',
			settings: 'Settings',
		},
	},
	'pt-BR': {
		operatorNavigationLabel: 'Superfícies do operador',
		skipLinkLabel: 'Pular para o conteúdo',
		routeLabels: {
			conversation: 'Conversa',
			runs: 'Runs',
			work: 'Trabalho',
			settings: 'Ajustes',
		},
	},
} as const satisfies Record<Locale, ShellCatalog>;

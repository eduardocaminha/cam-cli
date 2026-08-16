import { camLoopTmplContents } from './_generated.ts';

export type EmbeddedKey = 'cam-loop.local.md.tmpl';

export const EMBEDDED_CONTENTS: Record<EmbeddedKey, string> = {
	'cam-loop.local.md.tmpl': camLoopTmplContents,
};

export function readEmbedded(key: EmbeddedKey): string {
	return EMBEDDED_CONTENTS[key];
}

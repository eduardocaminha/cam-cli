// src/commands/asset-modules.d.ts
//
// Not named web-assets.d.ts: TypeScript would read that as the emitted
// declaration of web-assets.ts and drop it from the program.
//
// TypeScript does not model the `with { type: "file" }` import attribute: it
// types each specifier from whatever the file resolves to. Non-code assets
// need path declarations here; index.html and app.js resolve to an HTMLBundle
// and a JS module, and their inferred types are corrected at the single import
// boundary in web-assets.ts.

declare module '*.css' {
	/** With `type: "file"`, the default export is the asset's path. */
	const path: string;
	export default path;
}

declare module '*.png' {
	const path: string;
	export default path;
}

declare module '*.svg' {
	const path: string;
	export default path;
}

declare module '*.webmanifest' {
	const path: string;
	export default path;
}

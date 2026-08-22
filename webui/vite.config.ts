import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

/**
 * Stable, unhashed output names. The compiled binary embeds the bundle through
 * static `import ... with { type: 'file' }` specifiers (src/commands/
 * web-assets.ts), and a static specifier cannot name a content hash. Cache
 * busting is not needed for a bundle that ships inside the process serving it.
 */
export default defineConfig({
	plugins: [tailwindcss()],
	build: {
		rollupOptions: {
			output: {
				entryFileNames: 'app.js',
				chunkFileNames: 'app.js',
				assetFileNames: 'app.[ext]',
			},
		},
	},
});

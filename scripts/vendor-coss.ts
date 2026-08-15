import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, relative, resolve, sep } from 'node:path';

const ALLOWED_NPM_PACKAGES = [
	'react',
	'clsx',
	'tailwind-merge',
	'class-variance-authority',
	'@base-ui/react',
] as const;

const SOURCE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);
const transpiler = new Bun.Transpiler({ loader: 'tsx' });
type ScannedImport = ReturnType<typeof transpiler.scanImports>[number];

export interface VendorImportViolation {
	file: string;
	specifier: string;
	reason: string;
}

export interface VendorSourceFile {
	relPath: string;
	content: string | Uint8Array;
}

export interface VendorCossOptions {
	destination: string;
	fetchFiles: () => readonly VendorSourceFile[];
}

export class VendorVerificationError extends Error {
	readonly violations: readonly VendorImportViolation[];

	constructor(root: string, violations: readonly VendorImportViolation[]) {
		super(`COSS vendor verification failed for ${root} (${violations.length} violation(s))`);
		this.name = 'VendorVerificationError';
		this.violations = violations;
	}
}

function isSourceFile(path: string): boolean {
	return SOURCE_EXTENSIONS.has(extname(path).toLowerCase());
}

function listSourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		const path = resolve(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...listSourceFiles(path));
		} else if (entry.isFile() && isSourceFile(path)) {
			files.push(path);
		}
	}
	return files;
}

function isRelativeSpecifier(specifier: string): boolean {
	return (
		specifier === '.' ||
		specifier === '..' ||
		specifier.startsWith('./') ||
		specifier.startsWith('../')
	);
}

function isInsideRoot(root: string, path: string): boolean {
	const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
	return path === root || path.startsWith(rootPrefix);
}

function resolveVendorFilePath(stagingDir: string, relPath: string): string {
	const destination = resolve(stagingDir, relPath);
	if (relPath.length === 0 || destination === stagingDir || !isInsideRoot(stagingDir, destination)) {
		throw new Error(`COSS vendor file path escapes the staging root: ${JSON.stringify(relPath)}`);
	}
	return destination;
}

function isAllowedNpmSpecifier(specifier: string): boolean {
	return ALLOWED_NPM_PACKAGES.some(
		(packageName) => specifier === packageName || specifier.startsWith(`${packageName}/`),
	);
}

function scanAllImports(source: string): ScannedImport[] {
	// Bun 1.3.13 scan() omits require-call entries that scanImports() returns.
	// Merge the fast-path findings without duplicating imports reported by both APIs.
	const imports = [...transpiler.scan(source).imports];
	const unmatchedPreciseImports = new Map<string, number>();
	for (const imported of imports) {
		const key = `${imported.kind}\0${imported.path}`;
		unmatchedPreciseImports.set(key, (unmatchedPreciseImports.get(key) ?? 0) + 1);
	}

	for (const imported of transpiler.scanImports(source)) {
		const key = `${imported.kind}\0${imported.path}`;
		const unmatchedCount = unmatchedPreciseImports.get(key) ?? 0;
		if (unmatchedCount > 0) {
			unmatchedPreciseImports.set(key, unmatchedCount - 1);
		} else {
			imports.push(imported);
		}
	}
	return imports;
}

/**
 * Verifies every literal import in a COSS vendor tree against a fail-closed
 * allowlist. Relative imports must stay within `dir`; bare imports must name
 * one of the explicitly allowed npm packages (or one of its subpaths).
 *
 * Throws one aggregate error after scanning the whole tree so callers cannot
 * accidentally ignore a returned list of violations.
 */
export function verify(dir: string): void {
	const root = resolve(dir);
	if (!statSync(root).isDirectory()) {
		throw new Error(`COSS vendor verification root is not a directory: ${root}`);
	}

	const violations: VendorImportViolation[] = [];
	for (const file of listSourceFiles(root)) {
		const source = readFileSync(file, 'utf8');
		for (const imported of scanAllImports(source)) {
			const specifier = imported.path;
			if (isRelativeSpecifier(specifier)) {
				const resolvedImport = resolve(dirname(file), specifier);
				if (!isInsideRoot(root, resolvedImport)) {
					violations.push({
						file: relative(root, file),
						specifier,
						reason: 'relative import resolves outside the verified root',
					});
				}
				continue;
			}

			if (!isAllowedNpmSpecifier(specifier)) {
				violations.push({
					file: relative(root, file),
					specifier,
					reason: 'specifier is not in the explicit npm allowlist',
				});
			}
		}
	}

	if (violations.length > 0) {
		throw new VendorVerificationError(root, violations);
	}
}

/**
 * Materializes an injected COSS source set into a sibling staging directory,
 * verifies that complete staging tree, and only then promotes it to the final
 * destination with a same-filesystem rename.
 *
 * Any fetch, write, verification, or promotion failure removes the staging
 * tree and leaves a previously absent destination absent.
 */
export function vendorCoss({ destination, fetchFiles }: VendorCossOptions): void {
	const finalDestination = resolve(destination);
	mkdirSync(dirname(finalDestination), { recursive: true });
	const stagingDir = mkdtempSync(`${finalDestination}.staging-`);

	try {
		for (const file of fetchFiles()) {
			const fileDestination = resolveVendorFilePath(stagingDir, file.relPath);
			mkdirSync(dirname(fileDestination), { recursive: true });
			writeFileSync(fileDestination, file.content);
		}

		verify(stagingDir);
		renameSync(stagingDir, finalDestination);
	} finally {
		rmSync(stagingDir, { recursive: true, force: true });
	}
}

type ErrorWriter = (message: string) => void;

function printUsage(writeError: ErrorWriter): void {
	writeError('Usage: bun scripts/vendor-coss.ts --verify <dir>');
}

export function runCli(
	args: readonly string[] = process.argv.slice(2),
	writeError: ErrorWriter = console.error,
): number {
	const dir = args[1];
	if (args[0] !== '--verify' || args.length !== 2 || dir === undefined || dir.length === 0) {
		printUsage(writeError);
		return 2;
	}

	try {
		verify(dir);
		return 0;
	} catch (error) {
		if (error instanceof VendorVerificationError) {
			for (const violation of error.violations) {
				writeError(
					`${violation.file}: import ${JSON.stringify(violation.specifier)} ${violation.reason}`,
				);
			}
		} else {
			writeError(error instanceof Error ? error.message : String(error));
		}
		return 1;
	}
}

if (import.meta.main) {
	process.exitCode = runCli();
}

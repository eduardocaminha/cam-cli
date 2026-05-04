// src/config/permission-mode.ts
//
// Single source of truth for the `permission_mode` value passed to
// `claude --permission-mode <mode>`. Read from `~/.config/cam/config.toml`
// (which `cam init` writes during US-005). The default — applied when the
// config file is missing OR the key is unset — is `"bypassPermissions"`,
// matching what `cam init` writes by default.
//
// US-007 acceptance criterion: NO subcommand exposes a `--permission-mode`
// flag to the operator. The value is sourced exclusively from this module.
// This is enforced by `test/no-permission-mode-flag.test.ts`, which scans the
// argv parser entry points for any `--permission-mode` literal and fails the
// build if one appears. See that test for the regression contract.
//
// `CAM_CONFIG_PATH` env override mirrors the pattern in `commands/init.ts`
// so tests can target a tmpdir without touching the real `~/.config/`.

import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { loadConfig } from './toml.ts';

/**
 * Default permission mode applied when the config file is missing or the
 * `permission_mode` key is unset / non-string. Matches what `cam init`
 * writes — keeps the "fresh machine" and "configured machine" code paths
 * indistinguishable to the spawn site.
 */
export const DEFAULT_PERMISSION_MODE = 'bypassPermissions';

function defaultConfigPath(): string {
	return process.env.CAM_CONFIG_PATH ?? join(homedir(), '.config', 'cam', 'config.toml');
}

/**
 * Read `permission_mode` from the cam config file. Returns the value when
 * present + a string; otherwise returns `DEFAULT_PERMISSION_MODE`.
 *
 * The function is **defensive on every error path**: a missing file, a
 * malformed TOML file, or a non-string value all fall back to the default.
 * The rationale is that `cam next` is the autonomous-loop entry point —
 * we never want a misconfigured `~/.config/cam/config.toml` to block the
 * operator from launching the loop. If the value matters to a downstream
 * command, it's the command's responsibility to validate.
 */
export function readPermissionMode(configPath?: string): string {
	const path = configPath ?? defaultConfigPath();
	try {
		const config = loadConfig(path);
		const value = config['permission_mode'];
		if (typeof value === 'string' && value.length > 0) {
			return value;
		}
	} catch {
		// Malformed TOML or fs read error — fall back to default. We don't
		// surface a warning here because the default is the safe value;
		// `cam init` is where the user should see config-file diagnostics.
	}
	return DEFAULT_PERMISSION_MODE;
}

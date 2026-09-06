import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathExists } from '../fs.ts';
import { logger } from '../../logger.ts';

/**
 * Fetching `@types/titanium` onto the machine.
 *
 * TypeScript ships automatic type acquisition, and it cannot be reused here for four separate
 * reasons: `ts.JsTyping.discoverTypings` and `ts.server.typingsInstaller` are absent from the
 * public `typescript.d.ts`; the installer is a separate process speaking a request/response
 * protocol to tsserver, which we do not run; its discovery works from `package.json` dependencies,
 * unresolved imports and a filename safe list, none of which name Titanium, so it would never pick
 * this package up; and it versions against the TypeScript release rather than against the tiapp's
 * `sdk-version`, which is the whole substance of the resolution rule.
 *
 * What it does mechanically is worth copying, and this does: spawn npm with `--ignore-scripts`
 * into a version-keyed cache directory. Spawning npm rather than talking to the registry directly
 * is what avoids hand-rolling a tar reader, and it inherits the user's own registry and proxy
 * configuration, which is usually the difference between working and not behind a corporate proxy.
 *
 * Nothing here throws. A machine with no network, or no npm, is a normal condition for a language
 * server rather than an error — the resolver falls through to reporting that nothing resolved.
 */

/** The npm package the types come from */
const packageName = '@types/titanium';

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Runs a command, which is the seam a test replaces so nothing spawns and nothing is fetched */
export type CommandRunner = (command: string, args: string[], options: { cwd?: string }) => Promise<CommandResult>;

export interface TypesAcquirer {
	/** Every version published, or nothing when the registry cannot be reached */
	versions (): Promise<string[]>;
	/** Fetches one version and answers where it landed, or nothing when it could not be had */
	install (version: string): Promise<string|undefined>;
}

export interface NpmAcquirerOptions {
	run?: CommandRunner;
	cacheDirectory?: (version: string) => string;
}

/**
 * Where a fetched copy of the types lives.
 *
 * Keyed on the version, so a workspace holding a 9.x project beside a 13.x one keeps both rather
 * than reinstalling on every switch, and so a cache warmed once keeps working offline. The shape
 * follows TypeScript's own global typings cache: the platform's cache directory, our name, the
 * version.
 *
 * @param version - The `@types/titanium` version
 * @returns {string} An absolute path to the directory npm installs into
 */
export function typesCacheDirectory (version: string): string {
	return path.join(cacheRoot(), 'titanium-language-server', 'types', version);
}

/**
 * An acquirer that fetches through npm
 *
 * @param options - The command runner and cache location, both replaceable for tests
 * @returns {TypesAcquirer} The acquirer
 */
export function createNpmAcquirer (options: NpmAcquirerOptions = {}): TypesAcquirer {
	const run = options.run ?? runCommand;
	const cacheDirectory = options.cacheDirectory ?? typesCacheDirectory;

	return {
		async versions (): Promise<string[]> {
			let result;
			try {
				result = await run('npm', [ 'view', packageName, 'versions', '--json' ], {});
			} catch (error) {
				// npm not being on the PATH is a machine we cannot acquire on, not a crash
				logger.log(`Could not ask npm for ${packageName} versions: ${message(error)}`);
				return [];
			}

			if (result.code !== 0) {
				logger.log(`npm could not list ${packageName} versions: ${result.stderr.trim() || `exit ${result.code}`}`);
				return [];
			}

			try {
				const parsed: unknown = JSON.parse(result.stdout);
				// npm unwraps a single-element list into a bare string
				return typeof parsed === 'string' ? [ parsed ] : (parsed as string[]);
			} catch {
				logger.log(`npm answered with something that is not JSON when listing ${packageName} versions`);
				return [];
			}
		},

		async install (version: string): Promise<string|undefined> {
			const prefix = cacheDirectory(version);
			const installed = path.join(prefix, 'node_modules', '@types', 'titanium');

			// a version already fetched costs nothing and works with no network at all
			if (await pathExists(installed)) {
				return installed;
			}

			const args = [
				'install',
				// a postinstall from a fetched package running inside a language server is the one
				// real risk this step carries; TypeScript's own installer passes this too
				'--ignore-scripts',
				'--no-save',
				'--no-audit',
				'--no-fund',
				'--prefix', prefix,
				`${packageName}@${version}`
			];

			let result;
			try {
				result = await run('npm', args, {});
			} catch (error) {
				logger.log(`Could not run npm to fetch ${packageName}@${version}: ${message(error)}`);
				return;
			}

			if (result.code !== 0) {
				logger.log(`npm could not fetch ${packageName}@${version}: ${result.stderr.trim() || `exit ${result.code}`}`);
				return;
			}

			// a zero exit is not proof the package is there, and a path that does not exist would
			// fail later and much further from the cause
			if (!await pathExists(installed)) {
				logger.log(`npm reported success but ${packageName}@${version} is not at ${installed}`);
				return;
			}

			return installed;
		}
	};
}

/**
 * The platform's cache directory.
 *
 * The same three cases TypeScript's typings installer uses, so a Titanium cache sits beside the
 * caches everything else on the machine already writes rather than somewhere novel.
 *
 * @returns {string} An absolute path
 */
function cacheRoot (): string {
	if (process.platform === 'win32') {
		return process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
	}
	if (process.platform === 'darwin') {
		return path.join(os.homedir(), 'Library', 'Caches');
	}
	return process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache');
}

/**
 * Runs a command without a shell.
 *
 * `execFile` rather than `exec`: a path with a space in it — which is most of them on Windows and
 * macOS — is an argument here and a word break through a shell.
 *
 * A command that runs and exits non-zero resolves, because that is an answer. One that could not
 * be started at all rejects, because it says nothing about the registry — the callers above tell
 * the two apart so the log can.
 *
 * Exported so it can be tested directly. Every other caller takes it as the default runner.
 *
 * @param command - The executable
 * @param args - Its arguments
 * @param options - Where to run it
 * @returns {Promise<CommandResult>} What it printed and how it exited
 */
export function runCommand (command: string, args: string[], options: { cwd?: string }): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		// npm is a shell shim on Windows rather than an executable, so it is invoked through the
		// command processor there and directly everywhere else
		const executable = process.platform === 'win32' ? `${command}.cmd` : command;

		execFile(executable, args, { cwd: options.cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error && typeof error.code !== 'number') {
				// failed to start at all, as opposed to running and exiting non-zero
				reject(error);
				return;
			}
			resolve({ code: error?.code as number ?? 0, stdout, stderr });
		});
	});
}

/**
 * An error's message, whatever was thrown
 *
 * @param error - The thrown value
 * @returns {string} Something printable
 */
function message (error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

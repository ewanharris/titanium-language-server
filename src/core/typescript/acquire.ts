import fs from 'node:fs/promises';
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

/** The environment variable that moves the cache */
const CACHE_VARIABLE = 'TITANIUM_LANGUAGE_SERVER_TYPES_CACHE';

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
	/** Every version already fetched, which is what there is to choose from offline */
	cached (): Promise<string[]>;
	/** Fetches one version and answers where it landed, or nothing when it could not be had */
	install (version: string): Promise<string|undefined>;
}

export interface NpmAcquirerOptions {
	run?: CommandRunner;
	/** The directory holding one directory per fetched version */
	cacheRoot?: string;
}

/**
 * Where fetched copies of the types live, one directory per version.
 *
 * Under `~/.titanium`, beside the SDKs, modules and completions the rest of the Titanium tooling
 * keeps there. A platform cache directory would be the more orthodox home for something
 * re-downloadable, but a user looking for what Titanium has put on their machine looks in one
 * place, and this is that place. Named for what it holds rather than for which tool wrote it,
 * which is the convention the neighbouring directories already follow.
 *
 * Keyed on the version below this, so a workspace holding a 9.x project beside a 13.x one keeps
 * both rather than reinstalling on every switch, and so a cache warmed once keeps working offline
 * — `NpmAcquirer.cached` is what reads it back when the registry cannot be reached.
 *
 * `TITANIUM_LANGUAGE_SERVER_TYPES_CACHE` moves the whole cache. A spawned server takes no
 * constructor arguments, so the environment is the only way to point one somewhere else — which is
 * what keeps a test from installing into the home directory of whoever runs it, and what a user
 * with a read-only home directory would reach for.
 *
 * @param env - Where the override is read from
 * @returns {string} An absolute path
 */
export function typesCacheRoot (env: NodeJS.ProcessEnv = process.env): string {
	// an empty value is how a shell unsets a variable for one command, and must not mean the
	// current directory
	return env[CACHE_VARIABLE]
		? path.resolve(env[CACHE_VARIABLE])
		: path.join(os.homedir(), '.titanium', 'types');
}

/**
 * An acquirer that fetches through npm.
 *
 * Both collaborators are constructor arguments with real defaults rather than hardcoded calls:
 * the runner is the seam that keeps the suite off the network, and the cache location is what lets
 * a test install into a temporary directory.
 */
export class NpmAcquirer implements TypesAcquirer {

	private run: CommandRunner;
	private cacheRoot: string;

	constructor (options: NpmAcquirerOptions = {}) {
		this.run = options.run ?? runCommand;
		this.cacheRoot = options.cacheRoot ?? typesCacheRoot();
	}

	/**
	 * Every version of the package the registry has
	 *
	 * @returns {Promise<string[]>} The versions, or nothing when the registry could not be reached
	 * @memberof NpmAcquirer
	 */
	public async versions (): Promise<string[]> {
		let result;
		try {
			result = await this.run('npm', [ 'view', packageName, 'versions', '--json' ], {});
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
	}

	/**
	 * Every version already in the cache.
	 *
	 * Read from the disk and never from npm, because this is what there is to choose from when
	 * npm cannot reach the registry. Only a version whose package is complete counts: npm creates
	 * the prefix before it has fetched anything and the package directory before it has finished
	 * extracting, so an install that stopped part way leaves a directory named for a version it
	 * does not hold. Choosing one of those would fail later, with nothing else tried.
	 *
	 * @returns {Promise<string[]>} The versions, or nothing when there is no cache yet
	 * @memberof NpmAcquirer
	 */
	public async cached (): Promise<string[]> {
		let entries;
		try {
			entries = await fs.readdir(this.cacheRoot, { withFileTypes: true });
		} catch {
			// nothing has been fetched on this machine yet
			return [];
		}

		const versions: string[] = [];
		for (const entry of entries) {
			if (entry.isDirectory() && await isComplete(path.join(this.cacheRoot, entry.name))) {
				versions.push(entry.name);
			}
		}

		return versions;
	}

	/**
	 * Fetches one version into the cache, or answers what is already there
	 *
	 * @param version - The version to fetch
	 * @returns {Promise<string|undefined>} Where the package landed, or nothing when it could not be had
	 * @memberof NpmAcquirer
	 */
	public async install (version: string): Promise<string|undefined> {
		const prefix = path.join(this.cacheRoot, version);
		const installed = packageIn(prefix);

		// a version already fetched costs nothing and works with no network at all. A package
		// directory without its declarations is not one: that is an install that stopped part
		// way, and running npm again is what repairs it
		if (await isComplete(prefix)) {
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
			result = await this.run('npm', args, {});
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
		if (!await isComplete(prefix)) {
			logger.log(`npm reported success but ${packageName}@${version} is not at ${installed}`);
			return;
		}

		return installed;
	}
}

/**
 * Where npm puts the package under an install prefix
 *
 * @param prefix - The directory npm installed into
 * @returns {string} The package's directory
 */
function packageIn (prefix: string): string {
	return path.join(prefix, 'node_modules', '@types', 'titanium');
}

/**
 * Whether an install prefix holds a usable copy of the package.
 *
 * The declarations are the test rather than the directory, because npm makes the directory before
 * it has extracted anything into it. `index.d.ts` is the entry every published version names.
 *
 * @param prefix - The directory npm installed into
 * @returns {Promise<boolean>} Whether the package is there in full
 */
async function isComplete (prefix: string): Promise<boolean> {
	return pathExists(path.join(packageIn(prefix), 'index.d.ts'));
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
		// npm is a shell shim on Windows rather than an executable, so `npm` there means `npm.cmd`.
		// Only a bare name is treated that way: a command given as a path is already the executable,
		// and appending .cmd to it produces something that does not exist.
		const bareName = !command.includes(path.sep) && !command.includes('/') && !path.extname(command);
		const executable = process.platform === 'win32' && bareName ? `${command}.cmd` : command;

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

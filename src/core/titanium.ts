import os from 'node:os';
import path from 'node:path';
import { runCommand } from './command.ts';
import type { CommandRunner } from './command.ts';
import { logger } from '../logger.ts';

/**
 * What the Titanium CLI says is installed on this machine.
 *
 * Asked of `ti` itself rather than of the client: a custom request is one every editor would have
 * to implement before a tiapp completion worked in it at all, and `ti sdk list -o json` answers
 * the same question with nothing asked of the editor.
 *
 * The CLI is not assumed. A machine without `ti` on its PATH answers nothing, which is the same
 * posture as a project without types: a smaller answer, not an error.
 *
 * `-o json` rather than `--json`: both work on the current CLI, and only the first on the older
 * ones still installed alongside older SDKs.
 */

export interface TitaniumSdk {
	/** As a tiapp.xml writes it, `12.4.0.GA` */
	version: string;
	path: string;
}

export interface TitaniumInstall {
	/** Newest first, as the CLI orders them */
	sdks: TitaniumSdk[];
	/**
	 * The modules directories outside any project: one under each place SDKs are installed, which
	 * is where the CLI's global modules live, and the ones `paths.modules` configures
	 */
	moduleDirectories: string[];
}

export interface TitaniumCliOptions {
	run?: CommandRunner;
}

/** Long enough for a cold start of the CLI on a slow disk, short enough that a hung one is noticed */
const TIMEOUT = 15000;

const NOTHING: TitaniumInstall = { sdks: [], moduleDirectories: [] };

/**
 * The Titanium CLI, asked what is installed and remembered.
 *
 * What is installed changes on install rather than on keystroke, so the answer is cached — and
 * refreshed in the background each time it is asked for, rather than waited on. The first request
 * waits for the CLI; every one after answers at once from what the last run said, and an SDK
 * installed while the editor is open shows up one request later. A tiapp's sdk-version is edited
 * rarely enough that the spawn this costs per completion is nothing.
 */
export class TitaniumCli {

	private run: CommandRunner;
	private known: TitaniumInstall|undefined;
	private refreshing: Promise<TitaniumInstall>|undefined;
	/** What the last run had to say about itself, so a CLI that is missing is reported once */
	private lastProblem: string|undefined;

	constructor (options: TitaniumCliOptions = {}) {
		this.run = options.run ?? runCommand;
	}

	/**
	 * What is installed, from the cache when there is one
	 *
	 * @returns {Promise<TitaniumInstall>} The SDKs and the global modules directories
	 * @memberof TitaniumCli
	 */
	public async installed (): Promise<TitaniumInstall> {
		if (!this.known) {
			return this.refresh();
		}

		void this.refresh();
		return this.known;
	}

	/**
	 * Runs the CLI again, unless a run is already under way
	 *
	 * @returns {Promise<TitaniumInstall>} What it said
	 * @memberof TitaniumCli
	 */
	private refresh (): Promise<TitaniumInstall> {
		this.refreshing ??= this.query()
			.then(found => {
				this.known = found;
				return found;
			})
			.finally(() => {
				this.refreshing = undefined;
			});

		return this.refreshing;
	}

	/**
	 * Asks the CLI for the SDKs and the configured module paths, both at once.
	 *
	 * Neither answer depends on the other, and one failing does not lose the other.
	 *
	 * @returns {Promise<TitaniumInstall>} What it said, or nothing it could not say
	 * @memberof TitaniumCli
	 */
	private async query (): Promise<TitaniumInstall> {
		const [ sdkList, configured ] = await Promise.all([
			this.json([ 'sdk', 'list', '-o', 'json' ]),
			this.json([ 'config', 'paths.modules', '-o', 'json' ])
		]);

		// one line whichever failed: a missing ti fails both the same way, and the SDK list's is the
		// one that says so. The module paths failing alone loses the global modules they name
		this.report(sdkList.problem ?? configured.problem);

		const answer = isRecord(sdkList.value) ? sdkList.value : {};
		const installed = isRecord(answer.installed) ? answer.installed : {};
		const locations = Array.isArray(answer.installLocations) ? answer.installLocations : [];

		const sdks = Object.entries(installed)
			.filter((entry): entry is [ string, string ] => typeof entry[1] === 'string')
			.map(([ version, sdkPath ]) => ({ version, path: sdkPath }));

		// the CLI's own `paths.modules` reading takes a single string as a list of one
		const paths = typeof configured.value === 'string' ? [ configured.value ] : Array.isArray(configured.value) ? configured.value : [];

		const moduleDirectories = [
			...strings(locations).map(location => path.join(location, 'modules')),
			...strings(paths).map(expand)
		];

		return sdks.length || moduleDirectories.length ? { sdks, moduleDirectories: [ ...new Set(moduleDirectories) ] } : NOTHING;
	}

	/**
	 * Runs one `ti` subcommand and reads what it printed as JSON
	 *
	 * @param args - The subcommand and its arguments
	 * @returns What it printed, read, or what went wrong
	 * @memberof TitaniumCli
	 */
	private async json (args: string[]): Promise<{ value?: unknown; problem?: string }> {
		let result;
		try {
			result = await this.run('ti', args, { timeout: TIMEOUT });
		} catch {
			return { problem: 'The Titanium CLI (ti) is not on the PATH, or did not answer, so tiapp.xml cannot complete SDK versions or global modules' };
		}

		if (result.code !== 0) {
			return { problem: `ti ${args.join(' ')} exited with ${result.code}: ${result.stderr.trim()}` };
		}

		try {
			return { value: JSON.parse(result.stdout) };
		} catch {
			return { problem: `ti ${args.join(' ')} did not print JSON` };
		}
	}

	/**
	 * Logs what went wrong, once for as long as it keeps going wrong the same way — the CLI is asked
	 * on every tiapp completion, and a log saying it is missing each time says nothing new
	 *
	 * @param problem - What went wrong this time, if anything
	 * @memberof TitaniumCli
	 */
	private report (problem: string|undefined): void {
		if (problem && problem !== this.lastProblem) {
			logger.log(problem);
		}
		this.lastProblem = problem;
	}
}

/**
 * A configured path as the CLI reads it, with a leading `~` meaning the home directory
 *
 * @param configured - The path as configured
 * @returns {string} An absolute path
 */
function expand (configured: string): string {
	const home = configured === '~' || configured.startsWith('~/') || configured.startsWith('~\\');
	return path.resolve(home ? path.join(os.homedir(), configured.slice(1)) : configured);
}

function strings (values: unknown[]): string[] {
	return values.filter((value): value is string => typeof value === 'string');
}

function isRecord (value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

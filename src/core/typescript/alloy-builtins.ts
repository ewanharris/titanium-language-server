import path from 'node:path';
import { runCommand } from '../command.ts';
import type { CommandRunner } from '../command.ts';
import { pathExists } from '../fs.ts';
import type { Project } from '../project.ts';

/**
 * Where Alloy's builtins are: `require('alloy/animation')` and its siblings.
 *
 * Alloy copies them into the app when it compiles, so they are nowhere in the project, and their
 * types are read from Alloy's own source instead — the JavaScript and the JSDoc beside it. That is
 * the Alloy the project compiles with: one installed in the project, or above it as Node would
 * find it, and otherwise the one installed globally, which is what Alloy's own documentation tells
 * people to do. Where npm keeps global packages is asked of npm once and remembered: it does not
 * move while the server runs, though what is installed there may, so that is looked at each time.
 */

export interface AlloyBuiltinsOptions {
	/** Runs npm, which a test replaces so nothing spawns */
	run?: CommandRunner;
}

/** How long npm may take to say where its global packages are */
const TIMEOUT = 15000;

export class AlloyBuiltins {

	private run: CommandRunner;
	private globalModules: Promise<string|undefined>|undefined;

	constructor (options: AlloyBuiltinsOptions = {}) {
		this.run = options.run ?? runCommand;
	}

	/**
	 * The builtins directory of the Alloy a project compiles with
	 *
	 * @param project - The project
	 * @returns {Promise<string|undefined>} The directory, or nothing for a classic project or when
	 *   no Alloy is installed
	 * @memberof AlloyBuiltins
	 */
	public async locate (project: Project): Promise<string|undefined> {
		if (await project.type() !== 'alloy') {
			return;
		}

		for (let directory = project.filePath; ; directory = path.dirname(directory)) {
			const local = builtinsIn(path.join(directory, 'node_modules'));
			if (await pathExists(local)) {
				return local;
			}
			if (path.dirname(directory) === directory) {
				break;
			}
		}

		this.globalModules ??= this.npmRoot();
		const global = await this.globalModules;
		if (global && await pathExists(builtinsIn(global))) {
			return builtinsIn(global);
		}
	}

	/**
	 * Where npm keeps global packages, or nothing when npm cannot say
	 *
	 * @returns {Promise<string|undefined>} The directory
	 * @memberof AlloyBuiltins
	 */
	private async npmRoot (): Promise<string|undefined> {
		try {
			const result = await this.run('npm', [ 'root', '-g' ], { timeout: TIMEOUT });
			return result.code === 0 ? result.stdout.trim() || undefined : undefined;
		} catch {
			return undefined;
		}
	}
}

/**
 * Where Alloy's builtins sit in a node_modules directory
 *
 * @param nodeModules - The directory
 * @returns {string} The builtins directory, whether or not it exists
 */
function builtinsIn (nodeModules: string): string {
	return path.join(nodeModules, 'alloy', 'Alloy', 'builtins');
}

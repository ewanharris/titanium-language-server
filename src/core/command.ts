import path from 'node:path';
import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

/**
 * Running another program: npm to fetch the types, and the Titanium CLI to say what is installed.
 */

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface CommandOptions {
	/** Where to run it */
	cwd?: string;
	/** How long it may take, in milliseconds, before it is killed and treated as not having started */
	timeout?: number;
}

/** Runs a command, which is the seam a test replaces so nothing spawns and nothing is fetched */
export type CommandRunner = (command: string, args: string[], options: CommandOptions) => Promise<CommandResult>;

/**
 * Runs a command without a shell, save the cmd.exe a Windows batch file cannot run without.
 *
 * `execFile` rather than `exec`: a path with a space in it — which is most of them on Windows and
 * macOS — is an argument here and a word break through a shell. Where cmd.exe is needed, the
 * arguments are escaped for it rather than left for it to split.
 *
 * A command that runs and exits non-zero resolves, because that is an answer. One that could not
 * be started at all rejects, because it says nothing about the question asked, only that the
 * program is not there — the callers tell the two apart so the log can. One stopped for taking too
 * long rejects too: it never gave an answer.
 *
 * @param command - The executable
 * @param args - Its arguments
 * @param options - Where to run it, and for how long
 * @returns {Promise<CommandResult>} What it printed and how it exited
 */
export function runCommand (command: string, args: string[], options: CommandOptions): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		// npm and ti are shell shims on Windows rather than executables, so `npm` there means `npm.cmd`.
		// Only a bare name is treated that way: a command given as a path is already the executable,
		// and appending .cmd to it produces something that does not exist.
		const bareName = !command.includes(path.sep) && !command.includes('/') && !path.extname(command);
		const executable = process.platform === 'win32' && bareName ? `${command}.cmd` : command;
		const shim = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable);

		let timer: NodeJS.Timeout|undefined;
		let settled = false;

		const [ file, argv ] = shim ? throughCmd(executable, args) : [ executable, args ];
		const child = execFile(file, argv, {
			cwd: options.cwd,
			windowsHide: true,
			windowsVerbatimArguments: shim,
			maxBuffer: 16 * 1024 * 1024
		}, (error, stdout, stderr) => {
			clearTimeout(timer);
			if (settled) {
				return;
			}
			settled = true;

			if (error && typeof error.code !== 'number') {
				// failed to start at all, as opposed to running and exiting non-zero
				reject(error);
				return;
			}
			if (shim && error?.code === CMD_NOT_FOUND) {
				// cmd.exe started, and found nothing to run
				reject(new Error(`${executable} could not be started: ${stderr.trim()}`));
				return;
			}
			resolve({ code: error?.code as number ?? 0, stdout, stderr });
		});

		if (options.timeout !== undefined) {
			timer = setTimeout(() => {
				settled = true;
				stop(child, shim);
				reject(new Error(`${command} did not finish within ${options.timeout}ms`));
			}, options.timeout);
		}
	});
}

/** How cmd.exe exits when the command it was given, or one a batch file runs, is not there */
const CMD_NOT_FOUND = 9009;

/** What cmd.exe reads as something other than a literal, and so escapes with `^` */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * The cmd.exe invocation that runs a batch file with the arguments given, each arriving as written.
 *
 * Node will not run a `.cmd` or `.bat` without a shell, and refuses with EINVAL rather than guess at
 * the quoting — so the quoting is done here, as cross-spawn does it. Each argument is quoted for the
 * program at the end, then every character cmd.exe would read is escaped. Twice, because a shim reads
 * its arguments again: npm and ti both end in `node <script> %*`, and cmd.exe parses `%*` as it
 * expands it.
 *
 * @param executable - The batch file
 * @param args - Its arguments
 * @returns {[string, string[]]} The program to run, and its arguments, to be passed verbatim
 */
function throughCmd (executable: string, args: string[]): [ string, string[] ] {
	const quoted = (arg: string): string => {
		// backslashes before a quote, or before the closing quote added below, are doubled so they
		// stay backslashes; the rest are literal
		const escaped = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, '$1$1');
		return `"${escaped}"`.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
	};

	const line = [ path.normalize(executable).replace(CMD_META, '^$1'), ...args.map(quoted) ].join(' ');

	return [ process.env.ComSpec ?? 'cmd.exe', [ '/d', '/s', '/c', `"${line}"` ] ];
}

/**
 * Stops a command that has run too long, and what it started.
 *
 * A batch file runs under cmd.exe, and killing cmd.exe leaves node running beneath it — still
 * holding the output open, so nothing reading it would hear that it stopped. taskkill takes the tree.
 *
 * @param child - The process
 * @param shim - Whether it is cmd.exe running a batch file
 */
function stop (child: ChildProcess, shim: boolean): void {
	if (shim && child.pid !== undefined) {
		execFile('taskkill', [ '/pid', String(child.pid), '/t', '/f' ], { windowsHide: true }, () => {});
		return;
	}
	child.kill();
}

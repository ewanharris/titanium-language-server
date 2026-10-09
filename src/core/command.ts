import path from 'node:path';
import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { pathExists } from './fs.ts';

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
 * macOS — is an argument here and a word break through a shell.
 *
 * Node will not run a Windows `.cmd` or `.bat` without a shell, and npm and ti are both one there.
 * Those go through cmd.exe with every part in double quotes, and nothing more: the arguments are
 * this server's own — subcommands, flags, a package and a directory — and inside quotes cmd.exe
 * takes a space, `&`, `^` and parentheses as written. What it would still read is a pair of `%`
 * around the name of a variable, which no argument here carries.
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
export async function runCommand (command: string, args: string[], options: CommandOptions): Promise<CommandResult> {
	// npm and ti are shell shims on Windows rather than executables, so `npm` there means `npm.cmd`.
	// Only a bare name is treated that way: a command given as a path is already the executable,
	// and appending .cmd to it produces something that does not exist.
	const bareName = !command.includes(path.sep) && !command.includes('/') && !path.extname(command);
	const shim = process.platform === 'win32' && (bareName || /\.(?:cmd|bat)$/i.test(command));
	const executable = shim ? await batchFile(bareName ? `${command}.cmd` : command) : command;

	return new Promise((resolve, reject) => {
		let timer: NodeJS.Timeout|undefined;
		let settled = false;

		// a batch file goes to cmd.exe as one line, each part quoted: Node joins an argument list for a
		// shell without quoting any of it, so a path with a space would split there
		const [ file, argv ] = shim ? [ [ executable, ...args ].map(part => `"${part}"`).join(' '), [] ] : [ executable, args ];
		const child = execFile(file, argv, {
			cwd: options.cwd,
			shell: shim,
			windowsHide: true,
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

/**
 * The batch file to run, found on the PATH when it is named bare, or a rejection when there is none.
 *
 * Looked for before cmd.exe is started rather than left to it: cmd.exe is always there, and answers
 * a command that is not by exiting 1 — which reads the same as a CLI that ran and failed.
 *
 * @param name - The batch file, by name or by path
 * @returns {Promise<string>} Its path
 */
async function batchFile (name: string): Promise<string> {
	const candidates = name.includes(path.sep) || name.includes('/')
		? [ name ]
		: (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, name));

	for (const candidate of candidates) {
		if (await pathExists(candidate)) {
			return candidate;
		}
	}

	throw Object.assign(new Error(`${name} is not on the PATH`), { code: 'ENOENT' });
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

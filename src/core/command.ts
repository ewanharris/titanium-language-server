import path from 'node:path';
import { execFile } from 'node:child_process';

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
 * Runs a command without a shell.
 *
 * `execFile` rather than `exec`: a path with a space in it — which is most of them on Windows and
 * macOS — is an argument here and a word break through a shell.
 *
 * A command that runs and exits non-zero resolves, because that is an answer. One that could not
 * be started at all rejects, because it says nothing about the question asked, only that the
 * program is not there — the callers tell the two apart so the log can. One killed for taking too
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

		execFile(executable, args, { cwd: options.cwd, timeout: options.timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error && typeof error.code !== 'number') {
				// failed to start at all, or killed for running too long, as opposed to running and
				// exiting non-zero
				reject(error);
				return;
			}
			resolve({ code: error?.code as number ?? 0, stdout, stderr });
		});
	});
}

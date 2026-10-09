import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../../core/command.ts';

describe('The default command runner', () => {
	// every caller takes a runner as a seam, so nothing else in the suite spawns anything and the
	// real runner needs covering directly

	it('should resolve with what a command printed', async () => {
		// node is the one executable guaranteed present: the suite is running under it
		const result = await runCommand(process.execPath, [ '-e', 'process.stdout.write("hello")' ], {});

		assert.equal(result.code, 0);
		assert.equal(result.stdout, 'hello');
	});

	it('should resolve rather than reject when a command exits non-zero', async () => {
		// a command that ran and failed is an answer; the callers log its stderr
		const result = await runCommand(process.execPath, [ '-e', 'process.stderr.write("nope"); process.exit(3)' ], {});

		assert.equal(result.code, 3);
		assert.equal(result.stderr, 'nope');
	});

	it('should reject when the command cannot be started at all', async () => {
		// distinct from exiting non-zero: this says nothing about the question asked, only about
		// the machine, and the callers word the log differently for it
		await assert.rejects(() => runCommand(path.join(os.tmpdir(), 'definitely-not-an-executable-xyz'), [], {}));
	});

	it('should reject a command that outlives its timeout', async () => {
		// killed rather than waited on: a CLI stuck on a prompt nobody can see would otherwise hold
		// whatever is waiting for its answer for ever
		await assert.rejects(() => runCommand(process.execPath, [ '-e', 'setTimeout(() => {}, 10000)' ], { timeout: 200 }));
	});

	describe('a batch file on Windows', { skip: process.platform !== 'win32' && 'batch files are a Windows shim' }, () => {
		// npm and ti are both .cmd shims there, which Node will not run without a shell, and which
		// hand their arguments on through cmd.exe a second time

		/**
		 * A shim shaped like the ones npm writes, handing its arguments to a node script, in a
		 * directory with a space in its name as most of them are
		 *
		 * @param script - What the node script does
		 * @returns {Promise<string>} The shim's path
		 */
		async function shim (script: string): Promise<string> {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ti ls shim-'));
			await fs.writeFile(path.join(root, 'script.js'), script);
			await fs.writeFile(path.join(root, 'shim.cmd'), `@"${process.execPath}" "%~dp0script.js" %*\r\n`);
			return path.join(root, 'shim.cmd');
		}

		it('should run it, and hand it every argument as it was written', async () => {
			// what npm is handed, in a home directory with a space and characters cmd.exe would otherwise read
			const args = [ 'install', '--no-save', '--prefix', 'C:\\Users\\R&D (Work) ^1 50%\\.titanium\\types', '@types/titanium@13.3.0' ];

			const result = await runCommand(await shim('process.stdout.write(JSON.stringify(process.argv.slice(2)))'), args, {});

			assert.equal(result.code, 0, result.stderr);
			assert.deepEqual(JSON.parse(result.stdout), args);
		});

		it('should reject a shim that is not there, as for any command that cannot start', async () => {
			// cmd.exe is always there, and answers a missing command by exiting 1 rather than by
			// failing to start — which would read as a CLI that ran and failed
			await assert.rejects(() => runCommand('definitely-not-a-command-xyz', [], {}));
		});

		it('should stop it, and what it started, when it outlives its timeout', async () => {
			// killing cmd.exe alone leaves node holding the output open, and the answer waits for it
			const file = await shim('setTimeout(() => {}, 20000)');
			const started = Date.now();

			await assert.rejects(() => runCommand(file, [], { timeout: 500 }));

			assert.ok(Date.now() - started < 10000, `took ${Date.now() - started}ms`);
		});
	});

	it('should run in the directory it is given', async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ti-ls-cwd-')));

		const result = await runCommand(process.execPath, [ '-e', 'process.stdout.write(process.cwd())' ], { cwd: root });

		assert.equal(result.stdout, root);
	});
});

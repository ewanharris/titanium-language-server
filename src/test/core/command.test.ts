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

	it('should run in the directory it is given', async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ti-ls-cwd-')));

		const result = await runCommand(process.execPath, [ '-e', 'process.stdout.write(process.cwd())' ], { cwd: root });

		assert.equal(result.stdout, root);
	});
});

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CustomRequests, serverPath } from '../../index.js';

const run = promisify(execFile);
const packageRoot = path.join(import.meta.dirname, '..', '..', '..');

describe('package entry points', () => {

	it('should expose a resolvable server path for extensions that bundle the server', () => {
		assert.equal(typeof serverPath, 'string');
		assert.equal(fs.existsSync(serverPath), true);
	});

	it('should be the file the command runs, ready to execute', async () => {
		// bin points straight at the built server rather than at a wrapper script, so the command,
		// serverPath and require.resolve are all one artifact. That only works if tsc carried the
		// shebang through, which is what npm's generated shims need.
		const manifest = JSON.parse(await fsp.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
		const bin = path.resolve(packageRoot, manifest.bin['titanium-language-server']);

		assert.equal(bin, path.resolve(serverPath));
		assert.match(await fsp.readFile(bin, 'utf8'), /^#!\/usr\/bin\/env node\n/);
	});

	it('should declare no custom protocol', () => {
		// Every custom request is something each editor has to implement before the server works
		// there. This asserts the target of zero, so adding one is a deliberate decision with a
		// failing test attached rather than something that quietly creeps in.
		assert.deepEqual(Object.keys(CustomRequests), []);
	});

	describe('resolved from a CommonJS host, as a VS Code extension would', () => {
		let root: string;

		before(async () => {
			// A consumer that has this package installed, so the exports map is what gets resolved
			root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ti-ls-cjs-'));
			await fsp.mkdir(path.join(root, 'node_modules'), { recursive: true });
			await fsp.symlink(packageRoot, path.join(root, 'node_modules', 'titanium-language-server'), 'junction');
			await fsp.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'consumer', version: '0.0.0' }));
		});

		after(async () => fsp.rm(root, { recursive: true, force: true }));

		it('should expose the server through require.resolve', async () => {
			// This package is ESM and a CommonJS extension host cannot always import it —
			// require(esm) needs Node 20.19 or 22.12, and VS Code has shipped older. Resolution
			// does not run the module, so it works regardless, and is the documented route.
			const script = 'process.stdout.write(require.resolve("titanium-language-server/server"));';
			const { stdout } = await run(process.execPath, [ '-e', script ], { cwd: root });

			assert.equal(fs.realpathSync(stdout), fs.realpathSync(serverPath));
		});
	});
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../../core/command.ts';
import { packageRoot } from './built.ts';

/** What a checkout from git does not carry: the build, and what installing would put there */
const UNTRACKED = new Set([ 'node_modules', 'out', '.git', 'coverage' ]);

/**
 * Installing the package from a git ref, which is how the editor extensions take it while it is
 * unpublished.
 *
 * A git checkout has no `out/`, and npm builds one only by running the package's `prepare` script
 * before it packs. Every other check here builds first, so nothing else would notice that script
 * going missing: `serverPath` would name a file that does not exist, and the package would fail to
 * import. Packing a copy of the checkout runs the same lifecycle without reaching the registry; the
 * copy borrows this checkout's `node_modules` for the compiler.
 */
describe('installing from git', () => {

	it('should build what it exports when packed from a checkout that has no out/', async () => {
		const checkout = await fsp.mkdtemp(path.join(os.tmpdir(), 'ti-ls-checkout-'));
		const packed = await fsp.mkdtemp(path.join(os.tmpdir(), 'ti-ls-packed-'));

		try {
			await fsp.cp(packageRoot, checkout, {
				recursive: true,
				filter: source => !UNTRACKED.has(path.relative(packageRoot, source).split(path.sep)[0])
			});
			await fsp.symlink(path.join(packageRoot, 'node_modules'), path.join(checkout, 'node_modules'), 'junction');

			const result = await runCommand('npm', [ 'pack', '--json', '--pack-destination', packed ], { cwd: checkout });

			assert.equal(result.code, 0, result.stderr);
			const [ tarball ] = JSON.parse(result.stdout) as { files: { path: string }[] }[];
			const files = tarball.files.map(file => file.path);
			for (const expected of [ 'out/server.js', 'out/index.js', 'out/index.d.ts' ]) {
				assert.ok(files.includes(expected), `expected ${expected} to be built and packed`);
			}
		} finally {
			await fsp.rm(checkout, { recursive: true, force: true });
			await fsp.rm(packed, { recursive: true, force: true });
		}
	});
});

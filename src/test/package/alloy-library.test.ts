import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { outDir, packageRoot } from './built.ts';

const run = promisify(execFile);

/**
 * The shipped Alloy declarations.
 *
 * This belongs in the package tier because everything that can go wrong with it is only true of
 * the artifact. The file is resolved relative to the module that loads it, which works in the
 * sources and in `out/` only because both sit three levels below the package root; and it is a
 * non-TypeScript asset, so nothing in `npm run build` would notice if it stopped being published.
 * An `npm pack` that quietly dropped it would leave every Alloy project with a `$` typed against a
 * namespace that does not exist, and no test running from source would see it.
 */
describe('the shipped Alloy declarations', () => {

	it('should be resolved to the same place from the sources and from the build', async () => {
		// the resolver walks up from import.meta.dirname, so the two layouts have to agree. They do
		// because tsc mirrors src/ into out/ at the same depth — assert it rather than trust it
		const fromSource = await import('../../core/typescript/alloy-library.ts');
		const fromBuild = await import(path.join(outDir, 'core', 'typescript', 'alloy-library.js')) as typeof fromSource;

		assert.equal(fromBuild.alloyLibraryPath(), fromSource.alloyLibraryPath());
	});

	it('should be a real file where the built module says it is', async () => {
		const { alloyLibraryPath } = await import(path.join(outDir, 'core', 'typescript', 'alloy-library.js')) as {
			alloyLibraryPath: () => string;
		};

		const contents = await fsp.readFile(alloyLibraryPath(), 'utf8');

		assert.match(contents, /declare namespace Alloy/, 'expected the declarations, not an empty file');
	});

	it('should be included in what npm publishes', async () => {
		// `files` lists out/ and nothing else by default, so the asset has to be named explicitly.
		// Asking npm rather than reading package.json: what ships is npm's answer, not ours
		const { stdout } = await run('npm', [ 'pack', '--dry-run', '--json' ], { cwd: packageRoot });
		const [ packed ] = JSON.parse(stdout) as { files: { path: string }[] }[];

		assert.ok(
			packed.files.some(file => file.path === 'assets/alloy.d.ts'),
			`expected assets/alloy.d.ts to be packed, got ${packed.files.length} files without it`
		);
	});
});

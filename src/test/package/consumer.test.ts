import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { packageRoot } from './built.ts';

const run = promisify(execFile);

/**
 * A TypeScript consumer, type checked against the declarations that ship.
 *
 * What this covers is the exports map and the types behind it: both entry points resolve, and what
 * comes back is the real type rather than `any`. That is what an editor extension depending on this
 * package needs, and it is the half of packaging the other tests here do not touch.
 *
 * It does not check inside the declarations. Relative imports in this package end in `.ts` so Node
 * can run the sources; tsc rewrites them to `.js` when it emits, but not in the declaration files,
 * which keep `.ts` and resolve because a `.ts` specifier inside a `.d.ts` means the sibling
 * `.d.ts`. `skipLibCheck` skips that, and it is left on deliberately: every stock tsconfig sets it,
 * so this is what a consumer actually does, and turning it off would type check
 * `vscode-languageserver`'s declarations rather than ours.
 */
describe('a TypeScript consumer of the built package', () => {

	let root: string;

	const typeCheck = async (source: string): Promise<string> => {
		await fsp.writeFile(path.join(root, 'use.ts'), source);
		try {
			await run(path.join(packageRoot, 'node_modules', '.bin', 'tsc'), [ '-p', 'tsconfig.json' ], { cwd: root });
			return '';
		} catch (error) {
			return (error as { stdout: string }).stdout;
		}
	};

	before(async () => {
		root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ti-ls-consumer-'));
		await fsp.mkdir(path.join(root, 'node_modules'), { recursive: true });
		await fsp.symlink(packageRoot, path.join(root, 'node_modules', 'titanium-language-server'), 'junction');
		await fsp.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'consumer', version: '0.0.0', type: 'module' }));
		await fsp.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({
			compilerOptions: {
				module: 'nodenext',
				moduleResolution: 'nodenext',
				target: 'es2023',
				strict: true,
				noEmit: true,
				// third party declarations are not this package's to answer for, and without it the
				// consumer needs @types/node installed to say anything at all
				skipLibCheck: true,
				types: []
			},
			include: [ 'use.ts' ]
		}));
	});

	after(async () => fsp.rm(root, { recursive: true, force: true }));

	it('should resolve both entry points and type check', async () => {
		const errors = await typeCheck([
			"import { serverPath } from 'titanium-language-server';",
			"import { TiLanguageService } from 'titanium-language-server/server';",
			'const path: string = serverPath;',
			'const service: TiLanguageService | undefined = undefined;',
			'export { path, service };'
		].join('\n'));

		assert.equal(errors, '');
	});

	it('should give the consumer the real types rather than any', async () => {
		// resolving to `any` would let everything through, so the check above would pass while
		// telling a consumer nothing. This is what proves the declarations were read.
		const errors = await typeCheck([
			"import { serverPath } from 'titanium-language-server';",
			'export const wrong: number = serverPath;'
		].join('\n'));

		assert.match(errors, /Type 'string' is not assignable to type 'number'/);
	});
});

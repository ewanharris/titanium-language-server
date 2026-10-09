import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Project } from '../../../core/project.ts';
import { AlloyBuiltins } from '../../../core/typescript/alloy-builtins.ts';
import type { CommandRunner } from '../../../core/command.ts';
import { fixturePath } from '../../fixtures.ts';

/**
 * Loads a project
 *
 * @param root - Its directory
 * @returns {Promise<Project>} The project
 */
async function project (root: string): Promise<Project> {
	const loaded = new Project(root);
	await loaded.load();
	return loaded;
}

/** A runner that fails the test if anything is run at all */
const nothingRun: CommandRunner = async (command, args) => {
	throw new Error(`expected nothing to run, ran ${command} ${args.join(' ')}`);
};

/**
 * A runner that answers `npm root -g` with a directory, counting how often it is asked
 *
 * @param root - The global node_modules it answers with
 * @returns The runner and the count
 */
function npmRoot (root: string): { run: CommandRunner; asked: () => number } {
	let asked = 0;
	return {
		run: async (command, args) => {
			asked++;
			assert.deepEqual([ command, ...args ], [ 'npm', 'root', '-g' ]);
			return { code: 0, stdout: `${root}\n`, stderr: '' };
		},
		asked: () => asked
	};
}

/**
 * A global node_modules directory with Alloy installed in it
 *
 * @returns {Promise<string>} The directory
 */
async function globalModules (): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ti-ls-global-'));
	await fs.mkdir(path.join(root, 'alloy', 'Alloy', 'builtins'), { recursive: true });
	return root;
}

describe('Finding Alloy\'s builtins', () => {

	it('should find the Alloy the project installs, without asking npm', async () => {
		const root = await fixturePath('alloy-typed-project');

		const found = await new AlloyBuiltins({ run: nothingRun }).locate(await project(root));

		assert.equal(found, path.join(root, 'node_modules', 'alloy', 'Alloy', 'builtins'));
	});

	it('should find one installed further up, as Node would', async () => {
		// a repository that installs its dependencies at the top, with the app in a folder below
		const top = await fs.mkdtemp(path.join(os.tmpdir(), 'ti-ls-hoisted-'));
		const app = path.join(top, 'app-one');
		await fs.cp(await fixturePath('alloy-project'), app, { recursive: true });
		await fs.mkdir(path.join(top, 'node_modules', 'alloy', 'Alloy', 'builtins'), { recursive: true });

		try {
			const found = await new AlloyBuiltins({ run: nothingRun }).locate(await project(app));

			assert.equal(found, path.join(top, 'node_modules', 'alloy', 'Alloy', 'builtins'));
		} finally {
			await fs.rm(top, { recursive: true, force: true });
		}
	});

	it('should fall back to the Alloy installed globally, asking npm where that is only once', async () => {
		// installing Alloy globally is what its own documentation tells people to do
		const global = await globalModules();
		const npm = npmRoot(global);
		const builtins = new AlloyBuiltins({ run: npm.run });

		try {
			const first = await builtins.locate(await project(await fixturePath('alloy-project')));
			const second = await builtins.locate(await project(await fixturePath('alloy-themed-project')));

			assert.equal(first, path.join(global, 'alloy', 'Alloy', 'builtins'));
			assert.equal(second, first);
			assert.equal(npm.asked(), 1);
		} finally {
			await fs.rm(global, { recursive: true, force: true });
		}
	});

	it('should find nothing when no Alloy is installed anywhere', async () => {
		const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'ti-ls-global-'));

		try {
			assert.equal(await new AlloyBuiltins({ run: npmRoot(empty).run }).locate(await project(await fixturePath('alloy-project'))), undefined);
		} finally {
			await fs.rm(empty, { recursive: true, force: true });
		}
	});

	it('should find nothing, rather than fail, when npm cannot answer', async () => {
		const missing: CommandRunner = async () => {
			throw new Error('npm is not on the PATH');
		};
		const failing: CommandRunner = async () => ({ code: 1, stdout: '', stderr: 'nope' });

		for (const run of [ missing, failing ]) {
			assert.equal(await new AlloyBuiltins({ run }).locate(await project(await fixturePath('alloy-project'))), undefined);
		}
	});

	it('should not look at all for a classic project, which has no Alloy', async () => {
		assert.equal(await new AlloyBuiltins({ run: nothingRun }).locate(await project(await fixturePath('classic-project'))), undefined);
	});
});

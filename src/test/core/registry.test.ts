import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { ProjectRegistry } from '../../core/registry.ts';
import { fixturePath } from '../fixtures.ts';

const tiapp = '<ti:app xmlns:ti="http://ti.appcelerator.org"><sdk-version>12.0.0.GA</sdk-version></ti:app>';

describe('Project registry', () => {

	describe('discovery', () => {
		it('should register a workspace folder that is itself a project', async () => {
			const registry = new ProjectRegistry();
			const root = await fixturePath('alloy-project');

			await registry.add([ root ]);

			assert.deepEqual(registry.projects.map(project => project.filePath), [ root ]);
		});

		it('should register projects one level below a workspace folder', async () => {
			// the folder opened is often a parent of the app rather than the app itself
			const registry = new ProjectRegistry();
			const fixtures = path.dirname(await fixturePath('alloy-project'));

			await registry.add([ fixtures ]);

			const registered = registry.projects.map(project => path.basename(project.filePath));
			// the malformed one registers too: a tiapp.xml saved half way through an edit still
			// yields its SDK version rather than taking the project down
			assert.deepEqual(registered.sort(), [ 'alloy-project', 'classic-project', 'malformed-tiapp-project' ]);
		});

		it('should not descend a second level', async () => {
			const registry = new ProjectRegistry();

			await registry.add([ path.dirname(path.dirname(await fixturePath('alloy-project'))) ]);

			assert.deepEqual(registry.projects, []);
		});

		it('should ignore a directory that is not a Titanium project', async () => {
			const registry = new ProjectRegistry();

			await registry.add([ await fixturePath('not-a-project') ]);

			assert.deepEqual(registry.projects, []);
		});

		it('should ignore a project whose tiapp.xml declares no SDK', async () => {
			// every completion is keyed off the SDK version, so there is nothing to offer without one
			const registry = new ProjectRegistry();

			await registry.add([ await fixturePath('no-sdk-project') ]);

			assert.deepEqual(registry.projects, []);
		});

		it('should ignore a root that does not exist rather than throwing', async () => {
			const registry = new ProjectRegistry();

			await registry.add([ path.join(await fixturePath('alloy-project'), 'nope') ]);

			assert.deepEqual(registry.projects, []);
		});

		it('should register a root only once', async () => {
			const registry = new ProjectRegistry();
			const root = await fixturePath('alloy-project');

			await registry.add([ root ]);
			await registry.add([ root ]);

			assert.equal(registry.projects.length, 1);
		});

		it('should report the projects it registered', async () => {
			const registry = new ProjectRegistry();
			const root = await fixturePath('alloy-project');

			assert.deepEqual((await registry.add([ root ])).map(project => project.filePath), [ root ]);
			assert.deepEqual(await registry.add([ root ]), []);
		});
	});

	describe('removal', () => {
		it('should drop the projects a workspace folder brought in', async () => {
			const registry = new ProjectRegistry();
			const fixtures = path.dirname(await fixturePath('alloy-project'));

			await registry.add([ fixtures ]);
			registry.remove([ fixtures ]);

			assert.deepEqual(registry.projects, []);
		});

		it('should report the projects it dropped, so their services can be disposed', async () => {
			const registry = new ProjectRegistry();
			const alloy = await fixturePath('alloy-project');
			const classic = await fixturePath('classic-project');
			await registry.add([ alloy, classic ]);

			const dropped = registry.remove([ classic ]);

			assert.deepEqual(dropped.map(project => project.filePath), [ classic ]);
			// a folder that held nothing drops nothing
			assert.deepEqual(registry.remove([ '/nowhere' ]), []);
		});

		it('should leave the projects other folders brought in', async () => {
			const registry = new ProjectRegistry();
			const alloy = await fixturePath('alloy-project');
			const classic = await fixturePath('classic-project');

			await registry.add([ alloy, classic ]);
			registry.remove([ classic ]);

			assert.deepEqual(registry.projects.map(project => project.filePath), [ alloy ]);
		});

		it('should keep a project two folders both found', async () => {
			const registry = new ProjectRegistry();
			const alloy = await fixturePath('alloy-project');
			const fixtures = path.dirname(alloy);

			await registry.add([ alloy, fixtures ]);
			registry.remove([ fixtures ]);

			assert.deepEqual(registry.projects.map(project => project.filePath), [ alloy ]);
		});
	});

	describe('lookup', () => {
		it('should find the project a file belongs to', async () => {
			const registry = new ProjectRegistry();
			const root = await fixturePath('alloy-project');
			await registry.add([ root ]);

			const project = registry.projectFor(path.join(root, 'app', 'views', 'index.xml'));

			assert.equal(project?.filePath, root);
		});

		it('should answer nothing for a file outside every project', async () => {
			const registry = new ProjectRegistry();
			await registry.add([ await fixturePath('alloy-project') ]);

			assert.equal(registry.projectFor(path.join(await fixturePath('classic-project'), 'tiapp.xml')), undefined);
		});

		it('should not match a sibling whose name merely starts the same', async () => {
			// path prefixes are not directory prefixes: /a/project-two is not inside /a/project
			const registry = new ProjectRegistry();
			const root = await fixturePath('alloy-project');
			await registry.add([ root ]);

			assert.equal(registry.projectFor(`${root}-two/app/views/index.xml`), undefined);
		});

		it('should prefer the innermost project when one contains another', async () => {
			// a project holding an example app inside it, which the one level scan registers as both
			const registry = new ProjectRegistry();
			const outer = await fsp.mkdtemp(path.join(os.tmpdir(), 'ti-ls-nested-'));
			const inner = path.join(outer, 'example');
			await fsp.mkdir(inner);
			await fsp.writeFile(path.join(outer, 'tiapp.xml'), tiapp);
			await fsp.writeFile(path.join(inner, 'tiapp.xml'), tiapp);

			try {
				await registry.add([ outer ]);

				assert.equal(registry.projects.length, 2);
				assert.equal(registry.projectFor(path.join(inner, 'app', 'views', 'index.xml'))?.filePath, inner);
				assert.equal(registry.projectFor(path.join(outer, 'app', 'views', 'index.xml'))?.filePath, outer);
			} finally {
				await fsp.rm(outer, { recursive: true, force: true });
			}
		});

	});
});

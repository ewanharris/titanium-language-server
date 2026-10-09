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
			assert.deepEqual(registered.sort(), [ 'alloy-no-widgets', 'alloy-project', 'alloy-themed-project', 'alloy-typed-project', 'classic-project', 'classic-untyped-project', 'malformed-tiapp-project' ]);
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

	describe('refresh', () => {
		// a project is read once when it is found, and the registry checks again on each request
		// rather than watching: what changed on disk since then is what these cover

		/** Distinct modification times, so a rewrite is seen whatever the file system's resolution */
		let tick = Date.now() / 1000;

		/**
		 * Writes a tiapp.xml, with a modification time later than any written before
		 *
		 * @param directory - The project directory, created if it is not there
		 * @param sdk - The SDK version it declares, or nothing for a tiapp.xml without one
		 */
		async function writeTiapp (directory: string, sdk?: string): Promise<void> {
			await fsp.mkdir(directory, { recursive: true });
			const file = path.join(directory, 'tiapp.xml');
			await fsp.writeFile(file, `<ti:app xmlns:ti="http://ti.appcelerator.org">${sdk ? `<sdk-version>${sdk}</sdk-version>` : ''}</ti:app>`);
			tick += 10;
			await fsp.utimes(file, tick, tick);
		}

		/**
		 * A workspace folder holding one project, registered
		 *
		 * @returns The registry, the folder and the project's directory
		 */
		async function registered (): Promise<{ registry: ProjectRegistry; root: string; app: string }> {
			const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ti-ls-refresh-'));
			const app = path.join(root, 'app-one');
			await writeTiapp(app, '12.0.0.GA');

			const registry = new ProjectRegistry();
			await registry.add([ root ]);
			assert.equal(registry.projects.length, 1);

			return { registry, root, app };
		}

		it('should change nothing when nothing on disk did', async () => {
			const { registry, root } = await registered();
			const before = registry.projects[0];

			try {
				assert.deepEqual(await registry.refresh(), { added: [], dropped: [] });
				assert.equal(registry.projects[0], before);
			} finally {
				await fsp.rm(root, { recursive: true, force: true });
			}
		});

		it('should register a project created in a folder already open', async () => {
			// ti create inside an open workspace
			const { registry, root } = await registered();
			const created = path.join(root, 'app-two');
			await writeTiapp(created, '13.0.0.GA');

			try {
				const { added, dropped } = await registry.refresh();

				assert.deepEqual(added.map(project => project.filePath), [ created ]);
				assert.deepEqual(dropped, []);
				assert.equal(registry.projectFor(path.join(created, 'app', 'alloy.js'))?.sdkVersion(), '13.0.0.GA');
			} finally {
				await fsp.rm(root, { recursive: true, force: true });
			}
		});

		it('should register a project whose tiapp.xml has since gained an sdk-version', async () => {
			// a half saved edit, or a merge conflict resolved, turned away at first
			const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ti-ls-refresh-'));
			const app = path.join(root, 'app-one');
			await writeTiapp(app);
			const registry = new ProjectRegistry();
			await registry.add([ root ]);
			assert.deepEqual(registry.projects, []);

			try {
				assert.deepEqual(await registry.refresh(), { added: [], dropped: [] });

				await writeTiapp(app, '12.0.0.GA');
				const { added } = await registry.refresh();

				assert.deepEqual(added.map(project => project.filePath), [ app ]);
			} finally {
				await fsp.rm(root, { recursive: true, force: true });
			}
		});

		it('should replace a project whose sdk-version changed', async () => {
			// every lookup is keyed off it, so the project is dropped and found again rather than
			// patched, and whatever was built for the old version goes with it
			const { registry, root, app } = await registered();
			const before = registry.projects[0];
			await writeTiapp(app, '13.0.0.GA');

			try {
				const { added, dropped } = await registry.refresh();

				assert.deepEqual(dropped, [ before ]);
				assert.equal(added.length, 1);
				assert.equal(added[0].sdkVersion(), '13.0.0.GA');
				assert.deepEqual(registry.projects, added);
			} finally {
				await fsp.rm(root, { recursive: true, force: true });
			}
		});

		it('should drop a project whose tiapp.xml no longer declares an SDK, or is gone', async () => {
			const { registry, root, app } = await registered();
			const other = path.join(root, 'app-two');
			await writeTiapp(other, '12.0.0.GA');
			await registry.refresh();
			assert.equal(registry.projects.length, 2);

			try {
				await writeTiapp(app);
				await fsp.rm(path.join(other, 'tiapp.xml'));

				const { added, dropped } = await registry.refresh();

				assert.deepEqual(added, []);
				assert.deepEqual(dropped.map(project => project.filePath).sort(), [ app, other ].sort());
				assert.deepEqual(registry.projects, []);
			} finally {
				await fsp.rm(root, { recursive: true, force: true });
			}
		});

		it('should drop a project whose directory is gone', async () => {
			const { registry, root, app } = await registered();
			await fsp.rm(app, { recursive: true, force: true });

			try {
				const { dropped } = await registry.refresh();

				assert.deepEqual(dropped.map(project => project.filePath), [ app ]);
			} finally {
				await fsp.rm(root, { recursive: true, force: true });
			}
		});

		it('should not look in a folder that has been removed', async () => {
			const { registry, root } = await registered();
			registry.remove([ root ]);
			await writeTiapp(path.join(root, 'app-two'), '12.0.0.GA');

			try {
				assert.deepEqual(await registry.refresh(), { added: [], dropped: [] });
				assert.deepEqual(registry.projects, []);
			} finally {
				await fsp.rm(root, { recursive: true, force: true });
			}
		});
	});
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Project } from '../../core/project.js';
import { fixturePath } from '../fixtures.js';

/**
 * A loaded Project for a fixture, since every test needs one and load() is always the first call.
 */
async function load (name: string): Promise<Project> {
	const project = new Project(await fixturePath(name));
	await project.load();
	return project;
}

describe('core/Project', () => {

	describe('validity', () => {

		it('should load an Alloy project', async () => {
			const project = await load('alloy-project');
			assert.equal(project.isValid, true);
			assert.equal(project.sdkVersion(), '10.1.0.GA');
			assert.equal(await project.type(), 'alloy');
		});

		it('should load a classic project', async () => {
			const project = await load('classic-project');
			assert.equal(project.isValid, true);
			assert.equal(project.sdkVersion(), '12.4.0.GA');
			assert.equal(await project.type(), 'classic');
		});

		it('should reject a directory that is not a Titanium project', async () => {
			const project = new Project(await fixturePath('not-a-project'));
			assert.equal(await project.load(), false);
			assert.equal(project.isValid, false);
		});

		it('should reject a directory that does not exist', async () => {
			const project = new Project(path.join(await fixturePath('not-a-project'), 'nope'));
			assert.equal(await project.load(), false);
			assert.equal(project.isValid, false);
		});

		it('should reject a tiapp.xml with no sdk-version', async () => {
			// every completion lookup is keyed off the SDK version, so there is nothing to offer
			const project = new Project(await fixturePath('no-sdk-project'));
			assert.equal(await project.load(), false);
			assert.equal(project.isValid, false);
		});

		it('should throw a helpful error when asked for a missing sdk version', async () => {
			const project = await load('no-sdk-project');
			assert.throws(() => project.sdkVersion(), /No sdk-version is set/);
		});

		it('should still read a malformed tiapp.xml rather than giving up on the project', async () => {
			// this is what @xmldom/xmldom is pinned to ~0.8 for: 0.9 throws a fatal ParseError where
			// 0.8 recovers and warns. A half-saved tiapp.xml should not take the project down
			const project = await load('malformed-tiapp-project');
			assert.equal(project.isValid, true);
			assert.equal(project.sdkVersion(), '12.4.0.GA');
		});

		it('should reject the project when the tiapp.xml cannot be read at all', async () => {
			// a directory where the file should be: it passes the existence check and then fails to
			// read, which is the path that turns an unreadable project into an ignored one
			const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ti-ls-tiapp-'));
			try {
				await fs.mkdir(path.join(root, 'tiapp.xml'));
				const project = new Project(root);
				assert.equal(await project.load(), false);
				assert.equal(project.isValid, false);
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		});
	});

	describe('paths that differ by project type', () => {

		it('should put i18n under app/ for Alloy and at the root for classic', async () => {
			const alloy = await load('alloy-project');
			const classic = await load('classic-project');

			assert.equal(await alloy.i18nPath(), path.join(alloy.filePath, 'app', 'i18n'));
			assert.equal(await classic.i18nPath(), path.join(classic.filePath, 'i18n'));
		});

		it('should resolve assets to app/assets for Alloy and Resources for classic', async () => {
			// Alloy compiles app/assets/* into Resources/*, so Resources is what app/assets becomes.
			// A classic project has no <project>/assets directory at all, which is what both the
			// previous implementation and vscode-titanium looked in.
			const alloy = await load('alloy-project');
			const classic = await load('classic-project');

			assert.equal(await alloy.assetPath(), path.join(alloy.filePath, 'app', 'assets'));
			assert.equal(await classic.assetPath(), path.join(classic.filePath, 'Resources'));
		});

		it('should resolve module requires against app/lib for Alloy and Resources for classic', async () => {
			const alloy = await load('alloy-project');
			const classic = await load('classic-project');

			assert.equal(await alloy.sourcePath(), path.join(alloy.filePath, 'app', 'lib'));
			assert.equal(await classic.sourcePath(), path.join(classic.filePath, 'Resources'));
		});

		it('should find requirable files in the right root for each type', async () => {
			const alloy = await load('alloy-project');
			const classic = await load('classic-project');

			const alloyLib = (await alloy.libFiles()).map(file => path.basename(file)).sort();
			const classicLib = (await classic.libFiles()).map(file => path.basename(file)).sort();

			assert.deepEqual(alloyLib, [ 'custom-view.js', 'http.js' ]);
			// a classic project requires modules out of Resources, not app/lib
			assert.deepEqual(classicLib, [ 'app.js', 'http.js', 'ui.js' ]);
		});
	});

	describe('Alloy-only collections', () => {

		it('should enumerate controllers, styles and views for an Alloy project', async () => {
			const project = await load('alloy-project');

			assert.ok((await project.controllers()).some(file => file.endsWith('index.js')));
			assert.ok((await project.styles()).some(file => file.endsWith('index.tss')));
			assert.ok((await project.views()).some(file => file.endsWith('index.xml')));
		});

		it('should return nothing rather than erroring for a classic project', async () => {
			// classic has no views, styles or controllers — the Alloy features must no-op, not throw
			const project = await load('classic-project');

			assert.deepEqual(await project.controllers(), []);
			assert.deepEqual(await project.styles(), []);
			assert.deepEqual(await project.views(), []);
		});
	});

	describe('locally installed modules', () => {

		it('should report only directories, grouped by platform', async () => {
			// the fixture has a stray README.md directly under modules/ and a stray.txt inside a
			// platform directory; neither is a module
			const project = await load('alloy-project');
			assert.deepEqual(await project.locallyInstalledModules(), [
				{ name: 'test.awesome', platforms: [ 'android' ] },
				{ name: 'ti.map', platforms: [ 'iphone' ] }
			]);
		});

		it('should work the same for a classic project', async () => {
			const project = await load('classic-project');
			assert.deepEqual(await project.locallyInstalledModules(), [
				{ name: 'ti.classic', platforms: [ 'android' ] }
			]);
		});

		it('should return an empty list when there is no modules directory', async () => {
			const project = new Project(await fixturePath('not-a-project'));
			assert.deepEqual(await project.locallyInstalledModules(), []);
		});
	});
});

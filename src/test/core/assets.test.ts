import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Project } from '../../core/project.ts';
import { imagePathsFor, isImageProperty } from '../../core/assets.ts';
import { fixturePath } from '../fixtures.ts';

/**
 * Loads a fixture project
 *
 * @param name - The fixture directory name
 * @returns {Promise<Project>} The loaded project
 */
async function project (name: string): Promise<Project> {
	const loaded = new Project(await fixturePath(name));
	await loaded.load();
	return loaded;
}

describe('The image assets a project has', () => {

	describe('which properties take one', () => {

		it('should know the obvious ones', () => {
			assert.equal(isImageProperty('image'), true);
			assert.equal(isImageProperty('backgroundImage'), true);
			assert.equal(isImageProperty('icon'), true);
		});

		it('should know the ones nobody remembers', () => {
			// the list is derived from @types/titanium rather than from memory: every property
			// whose name mentions an image or an icon and whose type admits a string
			assert.equal(isImageProperty('backgroundSelectedImage'), true);
			assert.equal(isImageProperty('selectedThumbImage'), true);
			assert.equal(isImageProperty('alertLaunchImage'), true);
		});

		it('should not treat a property that merely sounds like one as an image', () => {
			// these carry a boolean and a number, so a path completion in them is noise
			assert.equal(isImageProperty('preventDefaultImage'), false);
			assert.equal(isImageProperty('maxImages'), false);
			assert.equal(isImageProperty('toImage'), false);
			assert.equal(isImageProperty('title'), false);
		});
	});

	describe('for an Alloy project', () => {

		it('should answer the images under app/assets, rooted at the assets directory', async () => {
			const paths = await imagePathsFor(await project('alloy-project'), 'image');

			assert.ok(paths.includes('/images/logo.png'), 'expected a path from app/assets');
			assert.ok(paths.includes('/test.png'), 'expected one at the top level');
		});

		it('should offer a density variant once, under the name the code writes', async () => {
			// Titanium picks @2x and @3x at run time from the base name, so offering them is
			// offering three paths for one image and two that the code should never name
			const paths = await imagePathsFor(await project('alloy-project'), 'image');

			assert.ok(paths.includes('/images/logo.png'));
			assert.ok(!paths.some(found => found.includes('@2x')), '@2x should not be offered');
			assert.ok(!paths.some(found => found.includes('@3x')), '@3x should not be offered');
		});

		it('should strip the platform directory an asset sits under', async () => {
			// app/assets/iphone/images/x.png is built to Resources/iphone/images/x.png and named
			// /images/x.png in code — the platform directory is how it is selected, not part of it
			const paths = await imagePathsFor(await project('alloy-project'), 'image');

			assert.ok(paths.includes('/images/ios-only.png'), 'expected the platform asset under its own name');
			assert.ok(!paths.some(found => found.startsWith('/iphone/')), 'the platform directory is not part of the path');
		});

		it('should strip an Android density directory', async () => {
			const paths = await imagePathsFor(await project('alloy-project'), 'image');

			assert.ok(paths.includes('/images/droid.png'));
			assert.ok(!paths.some(found => found.includes('res-hdpi')), 'a density directory is not part of the path');
		});

		it('should answer each image once however many variants of it there are', async () => {
			const paths = await imagePathsFor(await project('alloy-project'), 'image');

			assert.equal(paths.filter(found => found === '/images/droid.png').length, 1);
			assert.equal(paths.filter(found => found === '/images/logo.png').length, 1);
		});

		it('should leave out a file that is not an image', async () => {
			const paths = await imagePathsFor(await project('alloy-project'), 'image');

			assert.ok(!paths.some(found => found.endsWith('.json')));
		});

		it('should answer them sorted', async () => {
			const paths = await imagePathsFor(await project('alloy-project'), 'image');

			assert.deepEqual(paths, [ ...paths ].sort());
		});
	});

	describe('for a classic project', () => {

		it('should answer the images under Resources', async () => {
			// classic has no app/assets at all, and looking for one is the bug the previous
			// implementation had — it went unnoticed because nothing registered on classic paths
			const paths = await imagePathsFor(await project('classic-project'), 'backgroundImage');

			assert.ok(paths.includes('/images/logo.png'));
			assert.ok(paths.includes('/images/icon.png'));
		});

		it('should collapse its density variants too', async () => {
			const paths = await imagePathsFor(await project('classic-project'), 'image');

			assert.ok(!paths.some(found => found.includes('@2x')));
		});

		it('should not offer the JavaScript that sits in the same directory', async () => {
			const paths = await imagePathsFor(await project('classic-project'), 'image');

			assert.ok(!paths.some(found => found.endsWith('.js')), 'Resources holds the source too');
		});
	});

	it('should answer nothing for a property that does not take an image', async () => {
		assert.deepEqual(await imagePathsFor(await project('alloy-project'), 'title'), []);
	});

	it('should answer nothing where there is no property at all', async () => {
		// a bare string literal in an argument, which is most string literals
		assert.deepEqual(await imagePathsFor(await project('alloy-project'), undefined), []);
	});

	it('should answer nothing for a project with no assets directory', async () => {
		assert.deepEqual(await imagePathsFor(await project('no-sdk-project'), 'image'), []);
	});
});

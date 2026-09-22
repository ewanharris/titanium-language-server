import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Project } from '../../core/project.ts';
import path from 'node:path';
import { imageFilesFor, imagePathsFor, isImageProperty } from '../../core/assets.ts';
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

		// the rule is a suffix and a type, not a list. A name ending in Image or Icon says the
		// property is probably a path; the type of what is being written into says whether it
		// could be a string at all. Neither alone is enough — @types/titanium puts
		// `preventDefaultImage: boolean` on ImageView, right beside `image`.

		it('should take a property named for an image or an icon', () => {
			assert.equal(isImageProperty('image', false), true);
			assert.equal(isImageProperty('icon', false), true);
			assert.equal(isImageProperty('backgroundImage', false), true);
			assert.equal(isImageProperty('activeIcon', false), true);
		});

		it('should take one the list it replaced would have had to name', () => {
			// the point of the suffix: these need no enumerating, and a property Titanium adds
			// tomorrow is picked up without this file changing
			assert.equal(isImageProperty('backgroundSelectedImage', false), true);
			assert.equal(isImageProperty('selectedThumbImage', false), true);
			assert.equal(isImageProperty('alertLaunchImage', false), true);
			assert.equal(isImageProperty('navigationIcon', false), true);
		});

		it('should take one the project\'s own types know and this file has never heard of', () => {
			// the whole point of a suffix over a list: a property Titanium adds tomorrow, or one a
			// module brings, is picked up without this file changing
			assert.equal(isImageProperty('heroImage', false), true);
			assert.equal(isImageProperty('splashIcon', false), true);
		});

		it('should reject a property whose type cannot be a string, whatever it is called', () => {
			// @types/titanium puts preventDefaultImage: boolean on ImageView, beside image. The
			// suffix alone offers paths in it; the type is what rules it out
			assert.equal(isImageProperty('preventDefaultImage', true), false);
			// and the same holds for the most obvious name there is
			assert.equal(isImageProperty('image', true), false);
		});

		it('should not read a plural or a prefix as the suffix', () => {
			// maxImages is a boolean and imageUrl is not a path this project knows; neither ends
			// in the singular, so neither needs the type to rule it out
			assert.equal(isImageProperty('maxImages', false), false);
			assert.equal(isImageProperty('imageUrl', false), false);
			assert.equal(isImageProperty('imageCount', false), false);
		});

		it('should reject a name that has nothing to do with an image', () => {
			assert.equal(isImageProperty('title', false), false);
			assert.equal(isImageProperty('text', false), false);
			assert.equal(isImageProperty(undefined, false), false);
		});

		it('should give an untyped property the benefit of the doubt', () => {
			// a plain object literal has no contextual type at all — `const o = { image: \'\' }`
			// then handed to createImageView. Knowing nothing is not knowing it is wrong
			assert.equal(isImageProperty('image', false), true);
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

	describe('the files a written path loads', () => {
		const assets = async (...segments: string[]): Promise<string> => path.join(await fixturePath('alloy-project'), 'app', 'assets', ...segments);

		it('should put the file named exactly first, before its density variants', async () => {
			const files = await imageFilesFor(await project('alloy-project'), '/images/logo.png');

			assert.deepEqual(files, [
				await assets('images', 'logo.png'),
				await assets('images', 'logo@2x.png'),
				await assets('images', 'logo@3x.png')
			]);
		});

		it('should find one that only exists under a platform and a density', async () => {
			const files = await imageFilesFor(await project('alloy-project'), '/images/droid.png');

			assert.equal(files.length, 2);
			assert.ok(files.every(file => file.includes(`${path.sep}android${path.sep}`)));
		});

		it('should read a path written without its leading slash the same way', async () => {
			// Titanium resolves both against the resource root
			assert.deepEqual(await imageFilesFor(await project('alloy-project'), 'test.png'), [ await assets('test.png') ]);
		});

		it('should resolve against Resources in a classic project', async () => {
			const classic = await project('classic-project');

			assert.deepEqual(await imageFilesFor(classic, '/images/icon.png'), [ path.join(classic.filePath, 'Resources', 'images', 'icon.png') ]);
		});

		it('should answer nothing for a path with no file behind it', async () => {
			assert.deepEqual(await imageFilesFor(await project('alloy-project'), '/images/missing.png'), []);
		});
	});
});

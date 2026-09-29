import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Project } from '../../core/project.ts';
import { applicableStyles, relatedFile, stylesheetsFor, viewsStyledBy } from '../../core/related.ts';
import { SourceCache } from '../../core/references.ts';
import { fixturePath } from '../fixtures.ts';

describe('core/relatedFile', () => {
	let alloy: Project;
	let classic: Project;
	let app: string;

	/**
	 * A path under the Alloy fixture's app/ directory
	 */
	function inApp (...segments: string[]): string {
		return path.join(app, ...segments);
	}

	before(async () => {
		alloy = new Project(await fixturePath('alloy-project'));
		await alloy.load();
		app = path.join(alloy.filePath, 'app');

		classic = new Project(await fixturePath('classic-project'));
		await classic.load();
	});

	describe('the MVC triad', () => {

		it('should find the style and controller for a view', async () => {
			const view = inApp('views', 'index.xml');
			assert.equal(await relatedFile(alloy, 'style', view), inApp('styles', 'index.tss'));
			assert.equal(await relatedFile(alloy, 'controller', view), inApp('controllers', 'index.js'));
		});

		it('should find the view and controller for a style', async () => {
			const style = inApp('styles', 'index.tss');
			assert.equal(await relatedFile(alloy, 'view', style), inApp('views', 'index.xml'));
			assert.equal(await relatedFile(alloy, 'controller', style), inApp('controllers', 'index.js'));
		});

		it('should find the view and style for a controller', async () => {
			const controller = inApp('controllers', 'index.js');
			assert.equal(await relatedFile(alloy, 'view', controller), inApp('views', 'index.xml'));
			assert.equal(await relatedFile(alloy, 'style', controller), inApp('styles', 'index.tss'));
		});

		it('should return the file itself when asked for its own type', async () => {
			const view = inApp('views', 'index.xml');
			assert.equal(await relatedFile(alloy, 'view', view), view);
		});
	});

	describe('nesting and widgets', () => {

		it('should keep subdirectories when pairing', async () => {
			// app/controllers/folder/test.js pairs with app/views/folder/test.xml, not views/test.xml
			const controller = inApp('controllers', 'folder', 'test.js');
			assert.equal(await relatedFile(alloy, 'view', controller), undefined);
			assert.equal(await relatedFile(alloy, 'controller', controller), controller);
		});

		it('should pair within a widget rather than escaping to the app', async () => {
			const view = inApp('widgets', 'widget-test', 'views', 'widget.xml');
			assert.equal(
				await relatedFile(alloy, 'controller', view),
				inApp('widgets', 'widget-test', 'controllers', 'widget.js')
			);
			assert.equal(
				await relatedFile(alloy, 'style', view),
				inApp('widgets', 'widget-test', 'styles', 'widget.tss')
			);
		});
	});

	describe('TypeScript controllers', () => {

		it('should prefer a .ts controller over a .js one', async () => {
			// the fixture has both ts-lookup.ts and ts-lookup.js; the source file wins
			const view = inApp('views', 'ts-lookup.xml');
			assert.equal(await relatedFile(alloy, 'controller', view), inApp('controllers', 'ts-lookup.ts'));
		});
	});

	describe('files with no related file', () => {

		it('should return nothing when the counterpart does not exist', async () => {
			// app.tss is Alloy's global stylesheet — a real style file with no view or controller
			const style = inApp('styles', 'app.tss');
			assert.equal(await relatedFile(alloy, 'style', style), style);
			assert.equal(await relatedFile(alloy, 'view', style), undefined);
			assert.equal(await relatedFile(alloy, 'controller', style), undefined);
		});

		it('should return nothing for a file that is not part of the triad', async () => {
			assert.equal(await relatedFile(alloy, 'view', inApp('lib', 'http.js')), undefined);
			assert.equal(await relatedFile(alloy, 'view', inApp('alloy.js')), undefined);
			assert.equal(await relatedFile(alloy, 'view', inApp('models', 'test.js')), undefined);
		});

		it('should not walk out of the project for a file outside app/', async () => {
			// path.relative happily produces '..' segments, which the directory swap would then
			// turn into a plausible-looking path somewhere else entirely
			const outside = path.join(alloy.filePath, 'tiapp.xml');
			assert.equal(await relatedFile(alloy, 'view', outside), undefined);
			assert.equal(await relatedFile(alloy, 'controller', path.join(alloy.filePath, '..', 'elsewhere', 'views', 'x.xml')), undefined);
		});

		it('should return nothing for every type in a classic project', async () => {
			// classic has no views, styles or controllers, so there is nothing to pair with
			const file = path.join(classic.filePath, 'Resources', 'app.js');
			assert.equal(await relatedFile(classic, 'view', file), undefined);
			assert.equal(await relatedFile(classic, 'style', file), undefined);
			assert.equal(await relatedFile(classic, 'controller', file), undefined);
		});
	});

	describe('the views a stylesheet applies to', () => {

		const styled = async (...segments: string[]): Promise<string[]> =>
			(await viewsStyledBy(alloy, inApp(...segments), new SourceCache())).map(view => path.relative(app, view.path)).sort();

		it('should answer the paired view for a view\'s own stylesheet', async () => {
			assert.deepEqual(await styled('styles', 'index.tss'), [ path.join('views', 'index.xml') ]);
		});

		it('should answer every view in the app for app.tss', async () => {
			assert.deepEqual(await styled('styles', 'app.tss'), [
				path.join('views', 'existing-file.xml'),
				path.join('views', 'index.xml'),
				path.join('views', 'sample.xml'),
				path.join('views', 'ts-lookup.xml')
			]);
		});

		it('should keep app.tss out of a widget, the same rule the other direction follows', async () => {
			assert.ok(!(await styled('styles', 'app.tss')).some(view => view.startsWith('widgets')));
		});

		it('should answer the paired widget view for a widget\'s stylesheet', async () => {
			assert.deepEqual(await styled('widgets', 'widget-test', 'styles', 'widget.tss'), [ path.join('widgets', 'widget-test', 'views', 'widget.xml') ]);
		});

		it('should answer nothing for a stylesheet with no view', async () => {
			assert.deepEqual(await styled('styles', 'unpaired.tss'), []);
		});

		it('should read the views through the cache, so an open buffer answers', async () => {
			const cache = new SourceCache();
			cache.override(inApp('views', 'index.xml'), '<Alloy><Label class="edited"/></Alloy>');

			const [ view ] = await viewsStyledBy(alloy, inApp('styles', 'index.tss'), cache);

			assert.equal(view.text, '<Alloy><Label class="edited"/></Alloy>');
		});

		it('should answer nothing in a classic project', async () => {
			assert.deepEqual(await viewsStyledBy(classic, path.join(classic.filePath, 'Resources', 'app.tss'), new SourceCache()), []);
		});
	});
});

describe('Platform and theme stylesheets', () => {
	let project: Project;
	let app: string;

	/** A path under the themed fixture's app/ directory */
	const inApp = (...segments: string[]): string => path.join(app, ...segments);

	/** A path relative to app/, with forward slashes, which is how an assertion reads best */
	const relative = (file: string): string => path.relative(app, file).split(path.sep).join('/');

	before(async () => {
		project = new Project(await fixturePath('alloy-themed-project'));
		await project.load();
		app = path.join(project.filePath, 'app');
	});

	describe('the stylesheets Alloy loads for a view', () => {

		it('should load the global, the view\'s own and the theme\'s, each followed by its platform folders', async () => {
			const found = await stylesheetsFor(project, inApp('views', 'index.xml'), new SourceCache());

			assert.deepEqual(found.map(sheet => relative(sheet.path)), [
				'styles/app.tss',
				'themes/dark/styles/app.tss',
				'styles/ios/app.tss',
				'styles/index.tss',
				'styles/android/index.tss',
				'themes/dark/styles/index.tss',
				'themes/dark/styles/ios/index.tss'
			]);
		});

		it('should say which platform a stylesheet is for, and that it applies only there', async () => {
			const found = await stylesheetsFor(project, inApp('views', 'index.xml'), new SourceCache());
			const byPath = new Map(found.map(sheet => [ relative(sheet.path), sheet ]));

			assert.deepEqual(pick(byPath.get('styles/ios/app.tss')), { platform: 'ios', theme: undefined, conditional: true });
			assert.deepEqual(pick(byPath.get('styles/index.tss')), { platform: undefined, theme: undefined, conditional: false });
			assert.deepEqual(pick(byPath.get('themes/dark/styles/index.tss')), { platform: undefined, theme: 'dark', conditional: false });
			assert.deepEqual(pick(byPath.get('themes/dark/styles/ios/index.tss')), { platform: 'ios', theme: 'dark', conditional: true });
		});

		it('should make a theme conditional when config.json names it for one platform alone', async () => {
			const cache = new SourceCache();
			cache.override(inApp('config.json'), '{ "os:ios": { "theme": "dark" } }');

			const found = await stylesheetsFor(project, inApp('views', 'index.xml'), cache);
			const theme = found.find(sheet => relative(sheet.path) === 'themes/dark/styles/index.tss');

			assert.equal(theme?.conditional, true);
		});

		it('should load no theme when config.json names none', async () => {
			const cache = new SourceCache();
			cache.override(inApp('config.json'), '{ "global": {} }');

			const found = await stylesheetsFor(project, inApp('views', 'index.xml'), cache);

			assert.ok(!found.some(sheet => sheet.theme), 'no theme');
		});

		it('should read a top level theme, as Alloy does', async () => {
			const cache = new SourceCache();
			cache.override(inApp('config.json'), '{ "theme": "dark" }');

			const found = await stylesheetsFor(project, inApp('views', 'index.xml'), cache);

			assert.equal(found.find(sheet => sheet.theme)?.conditional, false);
		});

		it('should pair a view under a platform folder with the stylesheets of the view it stands in for', async () => {
			// Alloy strips the platform folder from a view's path before looking for its stylesheet
			const found = await stylesheetsFor(project, inApp('views', 'ios', 'about.xml'), new SourceCache());

			assert.ok(found.some(sheet => relative(sheet.path) === 'styles/about.tss'));
		});

		it('should load a widget\'s own, its platform folders and the theme\'s copy for it', async () => {
			const found = await stylesheetsFor(project, inApp('widgets', 'badge', 'views', 'widget.xml'), new SourceCache());

			assert.deepEqual(found.map(sheet => relative(sheet.path)), [
				'widgets/badge/styles/widget.tss',
				'widgets/badge/styles/ios/widget.tss',
				'themes/dark/widgets/badge/styles/widget.tss'
			]);
		});

		it('should list them most specific first through applicableStyles', async () => {
			const found = await applicableStyles(project, inApp('views', 'index.xml'), new SourceCache());

			assert.equal(relative(found[0].path), 'themes/dark/styles/ios/index.tss');
			assert.equal(relative(found[found.length - 1].path), 'styles/app.tss');
		});
	});

	describe('the views a platform or theme stylesheet applies to', () => {

		const viewsOf = async (...style: string[]): Promise<string[]> =>
			(await viewsStyledBy(project, inApp(...style), new SourceCache())).map(view => relative(view.path)).sort();

		it('should give a platform or theme app.tss every view in the app', async () => {
			assert.deepEqual(await viewsOf('styles', 'ios', 'app.tss'), [ 'views/index.xml', 'views/ios/about.xml' ]);
			assert.deepEqual(await viewsOf('themes', 'dark', 'styles', 'app.tss'), [ 'views/index.xml', 'views/ios/about.xml' ]);
		});

		it('should give a platform or theme stylesheet the view it is paired with', async () => {
			assert.deepEqual(await viewsOf('styles', 'android', 'index.tss'), [ 'views/index.xml' ]);
			assert.deepEqual(await viewsOf('themes', 'dark', 'styles', 'ios', 'index.tss'), [ 'views/index.xml' ]);
		});

		it('should give a stylesheet the view under a platform folder it styles', async () => {
			assert.deepEqual(await viewsOf('styles', 'about.tss'), [ 'views/ios/about.xml' ]);
		});

		it('should give a widget\'s platform or theme stylesheet the widget\'s view', async () => {
			assert.deepEqual(await viewsOf('widgets', 'badge', 'styles', 'ios', 'widget.tss'), [ 'widgets/badge/views/widget.xml' ]);
			assert.deepEqual(await viewsOf('themes', 'dark', 'widgets', 'badge', 'styles', 'widget.tss'), [ 'widgets/badge/views/widget.xml' ]);
		});
	});
});

/**
 * What a stylesheet is to the cascade, without its path and text
 *
 * @param sheet - The stylesheet
 * @returns The platform, theme and whether it is conditional
 */
function pick (sheet: { platform?: string; theme?: string; conditional: boolean }|undefined): { platform?: string; theme?: string; conditional: boolean }|undefined {
	return sheet && { platform: sheet.platform, theme: sheet.theme, conditional: sheet.conditional };
}

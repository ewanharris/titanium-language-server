import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Project } from '../../core/project.ts';
import { relatedFile, viewsStyledBy } from '../../core/related.ts';
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

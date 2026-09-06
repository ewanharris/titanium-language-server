import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { styleDefinitionAt, CoreLocation } from '../../core/definition.js';
import { createSourceCache, SourceCache } from '../../core/references.js';
import { Project } from '../../core/project.js';
import { fixturePath } from '../fixtures.js';

describe('Go to definition, from a view to the rule that styles it', () => {

	let project: Project;
	let cache: SourceCache;
	let root: string;

	before(async () => {
		root = await fixturePath('alloy-project');
		project = new Project(root);
		await project.load();
		cache = createSourceCache();
	});

	const inApp = (...segments: string[]): string => path.join(root, 'app', ...segments);

	/**
	 * Asks for the definitions at the first occurrence of a piece of the view's text, which keeps
	 * the tests readable and stops them asserting offsets I worked out by hand
	 */
	const at = async (view: string, needle: string, within = needle): Promise<CoreLocation[]> => {
		const source = await cache.read(view);
		const offset = source.text.indexOf(needle) + needle.indexOf(within);
		assert.ok(source.text.indexOf(needle) >= 0, `${needle} is not in ${view}`);
		return styleDefinitionAt(project, source, offset, cache);
	};

	/**
	 * The text a location points at, so an assertion reads as the rule rather than as two numbers.
	 * A selector's range is the token as written, quotes included, which is what an editor should
	 * highlight when it lands on it.
	 */
	const textOf = async (location: CoreLocation): Promise<string> =>
		(await cache.read(location.path)).text.slice(location.range.start, location.range.end);

	it('should find the rule for a class in the view\'s own stylesheet', async () => {
		const found = await at(inApp('views', 'index.xml'), 'container');

		assert.equal(found.length, 1);
		assert.equal(found[0].path, inApp('styles', 'index.tss'));
		assert.equal(await textOf(found[0]), '".container"');
	});

	it('should find the rule for an id', async () => {
		const found = await at(inApp('views', 'index.xml'), 'id="label"', 'label"');

		assert.equal(found.length, 1);
		assert.equal(await textOf(found[0]), '"#label"');
	});

	it('should find a class the global stylesheet defines', async () => {
		// app.tss applies throughout the app, so it is searched alongside the paired stylesheet
		const found = await at(inApp('views', 'index.xml'), 'thirdClass');

		assert.equal(found.length, 1);
		assert.equal(found[0].path, inApp('styles', 'app.tss'));
		assert.equal(await textOf(found[0]), '".thirdClass"');
	});

	it('should pick the class under the cursor out of a list', async () => {
		const view = inApp('views', 'index.xml');

		assert.equal((await at(view, 'container thirdClass', 'container'))[0].path, inApp('styles', 'index.tss'));
		assert.equal((await at(view, 'container thirdClass', 'thirdClass'))[0].path, inApp('styles', 'app.tss'));
	});

	it('should answer nothing for a class nothing styles', async () => {
		assert.deepEqual(await at(inApp('views', 'sample.xml'), 'noexistclass'), []);
	});

	it('should answer nothing on an attribute that is not a class or an id', async () => {
		assert.deepEqual(await at(inApp('views', 'index.xml'), 'doClick'), []);
	});

	it('should answer nothing on a tag name', async () => {
		// index.tss has a Label rule, but a tag is not what this answers for
		assert.deepEqual(await at(inApp('views', 'index.xml'), '<Label', 'Label'), []);
	});

	it('should answer nothing outside the document', async () => {
		const source = await cache.read(inApp('views', 'index.xml'));

		assert.deepEqual(await styleDefinitionAt(project, source, source.text.length + 10, cache), []);
	});

	it('should still search the global stylesheet for a view that has none of its own', async () => {
		// a view is allowed to have no paired stylesheet, and app.tss still applies to it
		const view = inApp('views', 'unpaired.xml');
		const edited = createSourceCache();
		edited.override(view, '<Alloy><Window class="thirdClass"/></Alloy>');

		const source = await edited.read(view);
		const found = await styleDefinitionAt(project, source, source.text.indexOf('thirdClass'), edited);

		assert.equal(found.length, 1);
		assert.equal(found[0].path, inApp('styles', 'app.tss'));
	});

	describe('inside a widget', () => {
		const widget = (...segments: string[]): string => path.join(root, 'app', 'widgets', 'widget-test', ...segments);

		it('should find the rule in the widget\'s own stylesheet', async () => {
			const found = await at(widget('views', 'widget.xml'), 'widgetLabel');

			assert.equal(found.length, 1);
			assert.equal(found[0].path, widget('styles', 'widget.tss'));
			assert.equal(await textOf(found[0]), '".widgetLabel"');
		});

		it('should not reach the app\'s global stylesheet', async () => {
			// Alloy does not apply app.tss to a widget, so neither does this
			assert.deepEqual(await at(widget('views', 'widget.xml'), 'thirdClass'), []);
		});
	});

	describe('in a classic project', () => {
		it('should answer nothing, since there are no views to be in', async () => {
			const classic = new Project(await fixturePath('classic-project'));
			await classic.load();

			const source = { path: path.join(classic.filePath, 'Resources', 'app.js'), text: '<Label class="container"/>' };
			assert.deepEqual(await styleDefinitionAt(classic, source, 15, cache), []);
		});
	});

	describe('with the file being edited', () => {
		it('should answer from the buffer rather than from disk', async () => {
			const view = inApp('views', 'index.xml');
			const edited = createSourceCache();
			edited.override(view, '<Alloy><Window class="thirdClass"/></Alloy>');

			const source = await edited.read(view);
			const found = await styleDefinitionAt(project, source, source.text.indexOf('thirdClass'), edited);

			assert.equal(found.length, 1);
			assert.equal(found[0].path, inApp('styles', 'app.tss'));
		});
	});
});

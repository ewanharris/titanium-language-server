import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { styleDefinitionAt, viewDefinitionAt } from '../../core/definition.ts';
import type { CoreLocation } from '../../core/definition.ts';
import {} from '../../core/references.ts';
import { SourceCache } from '../../core/references.ts';
import { Project } from '../../core/project.ts';
import { fixturePath } from '../fixtures.ts';

describe('Go to definition, from a view to the rule that styles it', () => {

	let project: Project;
	let cache: SourceCache;
	let root: string;

	before(async () => {
		root = await fixturePath('alloy-project');
		project = new Project(root);
		await project.load();
		cache = new SourceCache();
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
		const edited = new SourceCache();
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
			const edited = new SourceCache();
			edited.override(view, '<Alloy><Window class="thirdClass"/></Alloy>');

			const source = await edited.read(view);
			const found = await styleDefinitionAt(project, source, source.text.indexOf('thirdClass'), edited);

			assert.equal(found.length, 1);
			assert.equal(found[0].path, inApp('styles', 'app.tss'));
		});
	});
});

describe('Go to definition, from anything in a view', () => {

	let project: Project;
	let root: string;

	before(async () => {
		root = await fixturePath('alloy-project');
		project = new Project(root);
		await project.load();
	});

	const inApp = (...segments: string[]): string => path.join(root, 'app', ...segments);

	/**
	 * The definitions where `|` marks the cursor in a view written out in the test
	 *
	 * @param text - The view source, with `|` marking the cursor
	 * @param cache - Where everything else is read from, for a test that edits a buffer
	 * @param view - The view's path, which decides its controller and stylesheets
	 * @returns {Promise<CoreLocation[]>} Where the definition is
	 */
	const at = (text: string, cache = new SourceCache(), view = inApp('views', 'sample.xml')): Promise<CoreLocation[]> =>
		viewDefinitionAt(project, { path: view, text: text.replace('|', '') }, text.indexOf('|'), cache);

	/** What a location points at, read from the same cache the definition was found through */
	const textOf = async (location: CoreLocation, cache = new SourceCache()): Promise<string> =>
		(await cache.read(location.path)).text.slice(location.range.start, location.range.end);

	/** The start of a file, which is where a definition that names a whole file lands */
	const whole = (file: string): CoreLocation => ({ path: file, range: { start: 0, end: 0 } });

	describe('a class or an id', () => {
		it('should still find the rule that styles it', async () => {
			const found = await at('<Alloy><Window class="cont|ainer"/></Alloy>', undefined, inApp('views', 'index.xml'));

			assert.equal(await textOf(found[0]), '".container"');
		});
	});

	describe('a tag', () => {
		it('should find the rule that styles the tag', async () => {
			const found = await at('<Alloy><La|bel/></Alloy>', undefined, inApp('views', 'index.xml'));

			assert.equal(found.length, 1);
			assert.equal(found[0].path, inApp('styles', 'index.tss'));
			assert.equal(await textOf(found[0]), '"Label"');
		});

		it('should answer only on the name, not wherever in the element the cursor is', async () => {
			// the index records a tag's usage over the whole element, and an attribute that is not
			// a class or an id is not asking about the tag
			assert.deepEqual(await at('<Alloy><Label color="re|d"/></Alloy>', undefined, inApp('views', 'index.xml')), []);
		});
	});

	describe('an event handler', () => {
		it('should find the function in the view\'s controller', async () => {
			const found = await at('<Alloy><Label onClick="doCl|ick"/></Alloy>');

			assert.equal(found.length, 1);
			assert.equal(found[0].path, inApp('controllers', 'sample.js'));
			assert.equal(await textOf(found[0]), 'doClick');
		});

		it('should find a handler declared as a variable', async () => {
			const found = await at('<Alloy><Button onClick="btn|Click"/></Alloy>');

			assert.equal(await textOf(found[0]), 'btnClick');
			assert.match((await new SourceCache().read(found[0].path)).text.slice(found[0].range.start - 6), /^const btnClick/);
		});

		it('should find one under a platform prefix', async () => {
			const found = await at('<Alloy><Label ios:onClick="doCl|ick"/></Alloy>');

			assert.equal(await textOf(found[0]), 'doClick');
		});

		it('should find one assigned to $, from the buffer', async () => {
			const cache = new SourceCache();
			cache.override(inApp('controllers', 'sample.js'), 'function doClick () {}\n$.onTap = function () {};\n');

			const found = await at('<Alloy><Label onClick="$.on|Tap"/></Alloy>', cache);

			assert.equal(found.length, 1);
			assert.equal(await textOf(found[0], cache), 'onTap');
		});

		it('should answer nothing for a handler the controller does not declare', async () => {
			assert.deepEqual(await at('<Alloy><View onClick="noExist|Func"/></Alloy>'), []);
		});

		it('should answer nothing on an attribute that is not an event', async () => {
			// a value that happens to name a function is not a handler unless the attribute is one
			assert.deepEqual(await at('<Alloy><Label text="doCl|ick"/></Alloy>'), []);
		});

		it('should answer nothing for a view with no controller', async () => {
			assert.deepEqual(await at('<Alloy><Label onClick="doCl|ick"/></Alloy>', undefined, inApp('views', 'unpaired.xml')), []);
		});

		it('should look in a widget\'s own controller', async () => {
			const cache = new SourceCache();
			cache.override(inApp('widgets', 'widget-test', 'controllers', 'widget.js'), 'function onTap () {}');

			const found = await at('<Alloy><Label onClick="on|Tap"/></Alloy>', cache, inApp('widgets', 'widget-test', 'views', 'widget.xml'));

			assert.equal(found[0].path, inApp('widgets', 'widget-test', 'controllers', 'widget.js'));
		});
	});

	describe('a translation key', () => {
		it('should find the key in every locale that declares it, from L()', async () => {
			const found = await at('<Alloy><Label text="L(\'te|st\')"/></Alloy>');

			assert.deepEqual(found.map(location => path.relative(inApp('i18n'), location.path)).sort(), [
				path.join('en', 'strings.xml'),
				path.join('fr', 'strings.xml')
			]);
			assert.equal(await textOf(found[0]), 'test');
		});

		it('should find it from L() in an element\'s text', async () => {
			const found = await at('<Alloy><Label>L("welcome.ti|tle")</Label></Alloy>');

			assert.equal(found.length, 2);
		});

		it('should find it from an attribute that takes a key, such as titleid', async () => {
			const found = await at('<Alloy><Window titleid="untrans|lated"/></Alloy>');

			assert.equal(found.length, 1);
			assert.equal(await textOf(found[0]), 'untranslated');
		});

		it('should answer nothing for a key no locale declares', async () => {
			assert.deepEqual(await at('<Alloy><Label text="L(\'noex|ist\')"/></Alloy>'), []);
		});
	});

	describe('a file an element names', () => {
		it('should find the controller and the view a Require names', async () => {
			const found = await at('<Alloy><Require src="existing-f|ile"/></Alloy>');

			assert.deepEqual(found, [ whole(inApp('controllers', 'existing-file.js')), whole(inApp('views', 'existing-file.xml')) ]);
		});

		it('should find what exists of a Require in a folder', async () => {
			assert.deepEqual(await at('<Alloy><Require src="folder/te|st"/></Alloy>'), [ whole(inApp('controllers', 'folder', 'test.js')) ]);
		});

		it('should find a widget\'s default controller and view', async () => {
			const widget = (...segments: string[]): string => inApp('widgets', 'widget-test', ...segments);

			assert.deepEqual(await at('<Alloy><Widget src="widget-t|est"/></Alloy>'), [ whole(widget('controllers', 'widget.js')), whole(widget('views', 'widget.xml')) ]);
		});

		it('should find the controller a widget\'s name picks', async () => {
			assert.deepEqual(
				await at('<Alloy><Widget src="widget-t|est" name="test"/></Alloy>'),
				[ whole(inApp('widgets', 'widget-test', 'controllers', 'test.js')) ]
			);
		});

		it('should treat a Require of type widget as a widget', async () => {
			const found = await at('<Alloy><Require type="widget" src="widget-t|est"/></Alloy>');

			assert.equal(found[0]?.path, inApp('widgets', 'widget-test', 'controllers', 'widget.js'));
		});

		it('should find the model a Model or a Collection names', async () => {
			assert.deepEqual(await at('<Alloy><Model src="te|st"/></Alloy>'), [ whole(inApp('models', 'test.js')) ]);
			assert.deepEqual(await at('<Alloy><Collection src="te|st"/></Alloy>'), [ whole(inApp('models', 'test.js')) ]);
		});

		it('should resolve a Require and a Model inside a widget against the widget\'s own', async () => {
			// Alloy compiles a widget's view against the widget, so its Require names the widget's
			// controllers — the app has a controllers/folder/test.js and no controllers/test.js
			const widget = (...segments: string[]): string => inApp('widgets', 'widget-test', ...segments);
			const view = widget('views', 'widget.xml');

			assert.deepEqual(await at('<Alloy><Require src="te|st"/></Alloy>', undefined, view), [ whole(widget('controllers', 'test.js')) ]);
			assert.deepEqual(await at('<Alloy><Model src="te|st"/></Alloy>', undefined, view), [ whole(widget('models', 'test.js')) ]);
		});

		it('should find the library module a custom tag names', async () => {
			assert.deepEqual(
				await at('<Alloy><CustomView module="folder/custom-v|iew"/></Alloy>'),
				[ whole(inApp('lib', 'folder', 'custom-view.js')) ]
			);
		});

		it('should answer nothing for a native module, which has no source to go to', async () => {
			assert.deepEqual(await at('<Alloy><Annotation module="ti.m|ap"/></Alloy>'), []);
		});

		it('should answer nothing for a src on any other tag, which names no source file', async () => {
			assert.deepEqual(await at('<Alloy><VideoPlayer src="te|st"/></Alloy>'), []);
		});

		it('should answer nothing for a name with no file behind it', async () => {
			assert.deepEqual(await at('<Alloy><Require src="noex|ist"/></Alloy>'), []);
		});

		it('should not leave the project for a name that climbs out of it', async () => {
			assert.deepEqual(await at('<Alloy><Require src="../../tiapp|"/></Alloy>'), []);
		});
	});

	describe('in a classic project', () => {
		it('should answer nothing, since there are no views to be in', async () => {
			const classic = new Project(await fixturePath('classic-project'));
			await classic.load();

			const text = '<Alloy><Label onClick="doClick"/></Alloy>';
			const view = { path: path.join(classic.filePath, 'Resources', 'app.xml'), text };
			assert.deepEqual(await viewDefinitionAt(classic, view, text.indexOf('doClick') + 1, new SourceCache()), []);
		});
	});
});

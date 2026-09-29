import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Project } from '../../core/project.ts';
import { SourceCache } from '../../core/references.ts';
import { styleCompletionsAt } from '../../core/style.ts';
import type { ViewCompletion } from '../../core/view.ts';
import { fixturePath } from '../fixtures.ts';
import { api } from './fake-api.ts';

interface Options {
	/** The stylesheet, relative to the project's app directory */
	style?: string;
	/** The view that stylesheet is paired with, as a buffer, when the test needs particular elements */
	view?: string;
	fixture?: string;
}

/**
 * The completions offered where `|` marks the cursor in a stylesheet
 *
 * @param text - The stylesheet source, with `|` marking the cursor
 * @param options - Which stylesheet it is, and the view it styles
 * @returns {Promise<ViewCompletion[]>} What is offered there
 */
async function completionsAt (text: string, options: Options = {}): Promise<ViewCompletion[]> {
	const root = await fixturePath(options.fixture ?? 'alloy-project');
	const project = new Project(root);
	await project.load();

	const cache = new SourceCache();
	if (options.view !== undefined) {
		cache.override(path.join(root, 'app', 'views', 'index.xml'), options.view);
	}

	return styleCompletionsAt({
		project,
		style: { path: path.join(root, 'app', options.style ?? path.join('styles', 'index.tss')), text: text.replace('|', '') },
		offset: text.indexOf('|'),
		api,
		cache
	});
}

/**
 * The labels offered where `|` marks the cursor
 *
 * @param text - The stylesheet source, with `|` marking the cursor
 * @param options - Which stylesheet it is, and the view it styles
 * @returns {Promise<string[]>} The labels
 */
async function labelsAt (text: string, options: Options = {}): Promise<string[]> {
	return (await completionsAt(text, options)).map(completion => completion.label);
}

describe('What can be written in a stylesheet', () => {

	describe('selectors', () => {

		it('should offer the tags, and the classes and ids of the view it styles', async () => {
			// index.tss styles index.xml: a Window with container and thirdClass, a Label with id label
			const labels = await labelsAt('"|"');

			assert.ok(labels.includes('Label'), 'a tag');
			assert.ok(labels.includes('.container'), 'a class from the view');
			assert.ok(labels.includes('#label'), 'an id from the view');
		});

		it('should not offer Alloy\'s own markup, which a stylesheet cannot style', async () => {
			const labels = await labelsAt('"|"');

			for (const markup of [ 'Require', 'Widget', 'Model', 'Alloy' ]) {
				assert.ok(!labels.includes(markup), `${markup} is not styleable`);
			}
		});

		it('should replace the whole name typed so far, however long', async () => {
			// the implementation being replaced matched a single character, so "W worked and "Win did not
			const text = '"Win|"';
			const window = (await completionsAt(text)).find(completion => completion.label === 'Window');

			assert.deepEqual(window?.range, { start: 1, end: text.indexOf('|') });
		});

		it('should answer inside a selector whose closing quote is not typed yet', async () => {
			assert.ok((await labelsAt('"Lab|')).includes('Label'));
		});

		it('should replace only the name, not the qualifier after it', async () => {
			const text = '"La|bel[platform=ios]": {}';
			const label = (await completionsAt(text)).find(completion => completion.label === 'Label');

			assert.deepEqual(label?.range, { start: 1, end: 1 + 'Label'.length });
		});

		it('should replace only the part of a comma separated key being typed', async () => {
			const text = '"#label, .con|"';
			const container = (await completionsAt(text)).find(completion => completion.label === '.container');

			assert.deepEqual(container?.range, { start: text.indexOf('.con'), end: text.indexOf('|') });
		});

		it('should replace the part being typed after an escaped one', async () => {
			const text = '"\\u0023label, .con|"';
			const container = (await completionsAt(text)).find(completion => completion.label === '.container');

			assert.deepEqual(container?.range, { start: text.indexOf('.con'), end: text.indexOf('|') });
		});

		it('should offer a fresh part after a comma', async () => {
			const text = '"#label, |"';
			const label = (await completionsAt(text)).find(completion => completion.label === 'Label');

			assert.deepEqual(label?.range, { start: text.indexOf('|'), end: text.indexOf('|') });
		});

		it('should offer the classes of every app view in app.tss', async () => {
			// thirdClass is in index.xml, testClass in sample.xml
			const labels = await labelsAt('"|"', { style: path.join('styles', 'app.tss') });

			assert.ok(labels.includes('.thirdClass'));
			assert.ok(labels.includes('.testClass'));
		});

		it('should offer a theme\'s stylesheet the ids of the view it stands in for', async () => {
			const labels = await labelsAt('"|"', { fixture: 'alloy-themed-project', style: path.join('themes', 'dark', 'styles', 'index.tss') });

			assert.ok(labels.includes('#title'));
			assert.ok(labels.includes('.main'));
		});

		it('should offer a widget stylesheet only the widget\'s own classes', async () => {
			const labels = await labelsAt('"|"', { style: path.join('widgets', 'widget-test', 'styles', 'widget.tss') });

			assert.ok(labels.includes('.widgetLabel'));
			assert.ok(!labels.includes('.container'), 'container belongs to an app view');
		});
	});

	describe('property names', () => {

		it('should offer a tag rule the writable properties of its type', async () => {
			const labels = await labelsAt('"Label": {\n\t|\n}');

			assert.ok(labels.includes('text'));
			assert.ok(labels.includes('font'));
			assert.ok(!labels.includes('add'), 'a method is not a property');
			assert.ok(!labels.includes('lineCount'), 'a readonly property cannot be set');
		});

		it('should offer a class rule the properties of the elements that carry the class', async () => {
			// container is on a Window, which has a title and no text
			const labels = await labelsAt('".container": {\n\t|\n}');

			assert.ok(labels.includes('title'));
			assert.ok(!labels.includes('text'));
		});

		it('should offer an id rule the properties of the element with the id', async () => {
			const labels = await labelsAt('"#label": {\n\t|\n}');

			assert.ok(labels.includes('text'));
			assert.ok(!labels.includes('title'));
		});

		it('should offer a rule for the view\'s own name the properties of the top level element it names', async () => {
			// Alloy gives a top level element with no id the view's name, so "#index" styles the Window
			const labels = await labelsAt('"#index": {\n\t|\n}', { view: '<Alloy><Window><Label/></Window></Alloy>' });

			assert.ok(labels.includes('title'));
			assert.ok(!labels.includes('text'), 'the Label is not the top level element');
		});

		it('should offer a class on several types the properties of each, naming which', async () => {
			const found = await completionsAt('".shared": {\n\t|\n}', {
				view: '<Alloy><Window><Label class="shared"/><ImageView class="shared"/></Window></Alloy>'
			});
			const byLabel = new Map(found.map(completion => [ completion.label, completion ]));

			assert.equal(byLabel.get('text')?.detail, 'string — Label');
			assert.equal(byLabel.get('image')?.detail, 'string — ImageView');
			assert.equal(byLabel.get('width')?.detail, 'string | number — Label, ImageView');
		});

		it('should give a rule that styles one type each property\'s own type, rather than repeating the one type', async () => {
			const found = await completionsAt('"Label": {\n\t|\n}');

			assert.equal(found.find(completion => completion.label === 'font')?.detail, 'Font');
		});

		it('should offer a comma separated key the properties of every part', async () => {
			// container is on a Window and label on a Label
			const labels = await labelsAt('".container, #label": {\n\t|\n}');

			assert.ok(labels.includes('title'), 'from the Window');
			assert.ok(labels.includes('text'), 'from the Label');
		});

		it('should offer nothing for a class nothing carries', async () => {
			// what a class styles is what carries it, and nothing does yet
			assert.deepEqual(await labelsAt('".nothingHasThis": {\n\t|\n}'), []);
		});

		it('should not offer a property the rule already sets, except the one being typed', async () => {
			const labels = await labelsAt('"Label": {\n\tcolor: "red",\n\t|\n}');

			assert.ok(!labels.includes('color'));
			assert.ok((await labelsAt('"Label": {\n\tco|\n}')).includes('color'));
		});

		it('should still offer a name typed in full, which is the one under the cursor rather than a duplicate', async () => {
			assert.ok((await labelsAt('"Label": {\n\tcolor|\n}')).includes('color'));
		});

		it('should replace the name being typed', async () => {
			const text = '"Label": {\n\tco|\n}';
			const color = (await completionsAt(text)).find(completion => completion.label === 'color');

			assert.deepEqual(color?.range, { start: text.indexOf('co'), end: text.indexOf('|') });
		});

		it('should insert the colon, with a snippet form for a client that has an engine', async () => {
			const color = (await completionsAt('"Label": {\n\t|\n}')).find(completion => completion.label === 'color');

			assert.deepEqual(color?.insert, { snippet: 'color: $0', plain: 'color: ' });
		});

		it('should offer the members of a nested property\'s type inside it', async () => {
			const labels = await labelsAt('"Label": {\n\tfont: {\n\t\t|\n\t}\n}');

			assert.deepEqual(labels.sort(), [ 'fontFamily', 'fontSize' ]);
		});

		it('should offer them while one is being typed', async () => {
			assert.ok((await labelsAt('"Label": {\n\tfont: {\n\t\tfo|\n\t}\n}')).includes('fontSize'));
		});

		it('should read the nested object even when an earlier property of the same name is not one', async () => {
			// a duplicate a user is midway through replacing; the object is the one being written
			// in, so what it already sets is what is not offered again
			const labels = await labelsAt('"Label": {\n\tfont: 12,\n\tfont: {\n\t\tfontFamily: "x",\n\t\tfo|\n\t}\n}');

			assert.ok(labels.includes('fontSize'));
			assert.ok(!labels.includes('fontFamily'), 'already set in this object');
		});

		it('should read the object the cursor is in when two of the same name are objects', async () => {
			// the first font sets fontSize; the second, where the cursor is, does not
			const labels = await labelsAt('"Label": {\n\tfont: {\n\t\tfontSize: 12\n\t},\n\tfont: {\n\t\tfo|\n\t}\n}');

			assert.ok(labels.includes('fontSize'));
		});

		it('should offer nothing for a rule whose selector Alloy would reject', async () => {
			// an empty name is not a selector, and Alloy dies on one rather than styling anything
			assert.deepEqual(await labelsAt('"[platform=ios]": {\n\t|\n}'), []);
		});
	});

	describe('values', () => {

		it('should offer the constants the property takes, with their documentation', async () => {
			const found = await completionsAt('"Label": {\n\ttextAlign: |\n}');
			const center = found.find(completion => completion.label === 'Ti.UI.TEXT_ALIGNMENT_CENTER');

			assert.ok(center, `expected the alignment constants, got ${found.map(completion => completion.label).join(', ')}`);
			assert.equal(center.documentation, 'Center align text.');
		});

		it('should replace a constant being typed', async () => {
			const text = '"Label": {\n\twidth: Ti.UI.S|\n}';
			const size = (await completionsAt(text)).find(completion => completion.label === 'Ti.UI.SIZE');

			assert.deepEqual(size?.range, { start: text.indexOf('Ti.UI.S'), end: text.indexOf('|') });
		});

		it('should not offer constants inside a string, where one would be text', async () => {
			assert.deepEqual(await labelsAt('"Label": {\n\ttextAlign: "|"\n}'), []);
		});

		it('should offer image paths in a property that takes one', async () => {
			const labels = await labelsAt('"ImageView": {\n\timage: "/ima|"\n}');

			assert.ok(labels.includes('/images/logo.png'));
		});

		it('should offer the translation keys inside L()', async () => {
			assert.ok((await labelsAt('"Label": {\n\ttext: L(\'|\')\n}')).includes('welcome.title'));
		});

		it('should offer the Alloy.CFG keys', async () => {
			assert.ok((await labelsAt('"Label": {\n\ttext: Alloy.CFG.|\n}')).includes('debug'));
		});

		it('should offer no constants for a nested property, which the table does not cover', async () => {
			assert.deepEqual(await labelsAt('"Label": {\n\tfont: {\n\t\tfontSize: |\n\t}\n}'), []);
		});

		it('should answer nothing for a value with nothing to offer', async () => {
			assert.deepEqual(await labelsAt('"Label": {\n\tcolor: |\n}'), []);
		});
	});

	it('should answer nothing outside any rule', async () => {
		assert.deepEqual(await labelsAt('"Label": {}\n|'), []);
	});

	it('should answer nothing in a classic project, which has no stylesheets', async () => {
		assert.deepEqual(await labelsAt('"|"', { fixture: 'classic-project', style: path.join('..', 'Resources', 'app.tss') }), []);
	});
});

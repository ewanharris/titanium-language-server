import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Project } from '../../core/project.ts';
import { SourceCache } from '../../core/references.ts';
import { viewCompletionsAt } from '../../core/view.ts';
import type { ApiSource, ViewCompletion } from '../../core/view.ts';
import { fixturePath } from '../fixtures.ts';

/**
 * A stand-in for the project's types.
 *
 * The real one is `ProjectService`, which needs a parsed program — so a fake keeps these tests
 * about what is composed rather than about what TypeScript can resolve, which `host.test.ts`
 * covers. It answers for one type and nothing for anything else, which is also what a real project
 * does for a native module's proxies.
 */
const api: ApiSource = {
	titaniumTags: () => [ 'Label', 'View', 'Window' ],
	membersOf: type => {
		if (type === 'Titanium.UI.Label') {
			return [
				{ name: 'text', kind: 'property', readonly: false, documentation: 'The text to display' },
				{ name: 'color', kind: 'property', readonly: false, documentation: '' },
				{ name: 'lineCount', kind: 'property', readonly: true, documentation: '' },
				{ name: 'add', kind: 'method', readonly: false, documentation: '' }
			];
		}
		// a distinct member, so a test can tell the renamed type from the tag as written
		if (type === 'Titanium.UI.PickerRow') {
			return [ { name: 'title', kind: 'property', readonly: false, documentation: '' } ];
		}
		return [];
	},
	eventsOf: type => type === 'Titanium.UI.Label' ? [ 'click', 'longpress' ] : []
};

/**
 * The completions offered where `|` marks the cursor
 *
 * @param text - The view source, with `|` marking the cursor
 * @param fixture - The project to answer against
 * @param view - The view's path within it, which decides which stylesheets apply
 * @returns {Promise<ViewCompletion[]>} What is offered there
 */
async function completionsAt (text: string, fixture = 'alloy-project', view = 'app/views/index.xml'): Promise<ViewCompletion[]> {
	const root = await fixturePath(fixture);
	const project = new Project(root);
	await project.load();

	return viewCompletionsAt({
		project,
		view: { path: path.join(root, view), text: text.replace('|', '') },
		offset: text.indexOf('|'),
		api,
		cache: new SourceCache()
	});
}

/**
 * The labels offered where `|` marks the cursor
 *
 * @param text - The view source, with `|` marking the cursor
 * @returns {Promise<string[]>} The labels
 */
async function labelsAt (text: string): Promise<string[]> {
	return (await completionsAt(text)).map(entry => entry.label);
}

describe('What can be written in a view', () => {

	describe('tag names', () => {

		it('should offer the tags the types can create', async () => {
			const labels = await labelsAt('<Alloy><La|</Alloy>');

			assert.ok(labels.includes('Label'));
			assert.ok(labels.includes('Window'));
		});

		it('should offer the tags Alloy resolves to another namespace', async () => {
			const labels = await labelsAt('<Alloy><An|</Alloy>');

			assert.ok(labels.includes('Annotation'), 'Ti.Map');
			assert.ok(labels.includes('Require'), 'Alloy\'s own markup is a tag too');
		});

		it('should replace the tag name rather than leaving the client to guess', async () => {
			const text = '<Alloy><Lab</Alloy>';
			const found = await completionsAt(text.slice(0, text.indexOf('Lab') + 3) + '|' + text.slice(text.indexOf('Lab') + 3));
			const label = found.find(entry => entry.label === 'Label');

			assert.deepEqual(label?.range, { start: text.indexOf('Lab'), end: text.indexOf('Lab') + 3 });
		});
	});

	describe('attribute names', () => {

		it('should offer the properties of the element\'s type', async () => {
			const labels = await labelsAt('<Alloy><Label |/></Alloy>');

			assert.ok(labels.includes('text'));
			assert.ok(labels.includes('color'));
		});

		it('should not offer a method as an attribute', async () => {
			// an attribute is a property; `add` is something the controller calls
			assert.ok(!(await labelsAt('<Alloy><Label |/></Alloy>')).includes('add'));
		});

		it('should not offer a property the type says is read only', async () => {
			// @types/titanium marks what the platform reports rather than accepts as readonly —
			// `rect`, `size`, `lineCount`, `apiName`. A view can only write, so none is an attribute
			assert.ok(!(await labelsAt('<Alloy><Label |/></Alloy>')).includes('lineCount'));
		});

		it('should offer the events as on plus the capitalised name', async () => {
			const labels = await labelsAt('<Alloy><Label |/></Alloy>');

			assert.ok(labels.includes('onClick'));
			assert.ok(labels.includes('onLongpress'));
		});

		it('should offer Alloy\'s own attributes whatever the element is', async () => {
			const labels = await labelsAt('<Alloy><Label |/></Alloy>');

			for (const attribute of [ 'id', 'class', 'platform', 'formFactor', 'if', 'ns' ]) {
				assert.ok(labels.includes(attribute), `expected ${attribute}`);
			}
		});

		it('should offer src and type on a Require, which only those tags take', async () => {
			const onRequire = await labelsAt('<Alloy><Require |/></Alloy>');
			const onLabel = await labelsAt('<Alloy><Label |/></Alloy>');

			assert.ok(onRequire.includes('src'));
			assert.ok(onRequire.includes('type'));
			assert.ok(!onLabel.includes('src'), 'a Label does not take src');
		});

		it('should not offer an attribute the element already has', async () => {
			// the dedupe that never fired: it compared `id` against raw matches like `" id="`, so
			// everything already written was offered again. The parse gives the names for free
			const labels = await labelsAt('<Alloy><Label text="hi" id="a" |/></Alloy>');

			assert.ok(!labels.includes('text'), 'text is already written');
			assert.ok(!labels.includes('id'), 'id is already written');
			assert.ok(labels.includes('color'), 'color is not');
		});

		it('should not offer an event the element already has under a platform prefix', async () => {
			// Alloy's RESERVED_EVENT_REGEX accepts ios:onClick, so the element has that handler
			// already and offering onClick beside it is offering a duplicate
			const labels = await labelsAt('<Alloy><Label ios:onClick="go" |/></Alloy>');

			assert.ok(!labels.includes('onClick'), 'ios:onClick is already the click handler');
			assert.ok(labels.includes('onLongpress'));
		});

		it('should offer the events under a prefix once one has been typed', async () => {
			const labels = await labelsAt('<Alloy><Label ios:|/></Alloy>');

			assert.ok(labels.includes('ios:onClick'));
			assert.ok(labels.includes('ios:onLongpress'));
		});

		it('should not offer a plain property under a platform prefix', async () => {
			// the prefix is Alloy's event syntax and applies to nothing else
			assert.ok(!(await labelsAt('<Alloy><Label ios:|/></Alloy>')).includes('ios:text'));
		});

		it('should offer both insert forms, so a client without snippets is not sent tab stops', async () => {
			const text = '<Alloy><Label /></Alloy>';
			const found = await completionsAt(text.slice(0, text.indexOf('<Label ') + 7) + '|' + text.slice(text.indexOf('<Label ') + 7));
			const color = found.find(entry => entry.label === 'color');

			assert.equal(color?.insert?.snippet, 'color="$1"$0');
			assert.equal(color?.insert?.plain, 'color="');
		});

		it('should carry the documentation the types have', async () => {
			const text = '<Alloy><Label /></Alloy>';
			const found = await completionsAt(text.slice(0, text.indexOf('<Label ') + 7) + '|' + text.slice(text.indexOf('<Label ') + 7));

			assert.match(found.find(entry => entry.label === 'text')?.documentation ?? '', /The text to display/);
		});

		it('should still offer Alloy\'s attributes for a type the project has never heard of', async () => {
			// a native module's proxies are not in @types/titanium at all, and id and class are
			// still what a view writes on them
			const labels = await labelsAt('<Alloy><Annotation |/></Alloy>');

			assert.ok(labels.includes('id'));
			assert.ok(labels.includes('class'));
		});

		it('should answer in a start tag that was never closed', async () => {
			// the normal case mid-keystroke
			const labels = await labelsAt('<Alloy><Label |');

			assert.ok(labels.includes('text'));
			assert.ok(labels.includes('id'));
		});

		it('should replace the attribute name being edited', async () => {
			const text = '<Alloy><Label col/></Alloy>';
			const found = await completionsAt(text.slice(0, text.indexOf('col') + 3) + '|' + text.slice(text.indexOf('col') + 3));
			const color = found.find(entry => entry.label === 'color');

			assert.deepEqual(color?.range, { start: text.indexOf('col'), end: text.indexOf('col') + 3 });
		});

		it('should resolve the type through a rename the parent imposes', async () => {
			// <Row> inside a <Picker> is a PickerRow and not the table view Row of the same name,
			// so its attributes are a PickerRow's. Asserting the absence of a Label's attributes
			// would prove nothing — an unresolved type has none either
			const labels = await labelsAt('<Alloy><Picker><Row |/></Picker></Alloy>');

			assert.ok(labels.includes('title'), 'expected the renamed type\'s own property');
		});

		it('should offer bindId only inside an ItemTemplate, where it means something', async () => {
			// bindId is ViewTemplate.bindId in the types — "template that represents a view
			// subcomponent of an <ItemTemplate>" — so it is an attribute of what a child of one
			// compiles to and of nothing else
			const inside = await labelsAt('<Alloy><ItemTemplate name="t"><Label |/></ItemTemplate></Alloy>');
			const outside = await labelsAt('<Alloy><Label |/></Alloy>');

			assert.ok(inside.includes('bindId'), 'expected bindId on a template subcomponent');
			assert.ok(!outside.includes('bindId'), 'a label outside a template binds to nothing');
		});

		it('should offer bindId however deep inside the template the element is', async () => {
			const labels = await labelsAt('<Alloy><ItemTemplate name="t"><View><Label |/></View></ItemTemplate></Alloy>');

			assert.ok(labels.includes('bindId'));
		});

		it('should not offer bindId on the ItemTemplate itself', async () => {
			// the template is not a subcomponent of itself, and it binds to nothing
			assert.ok(!(await labelsAt('<Alloy><ItemTemplate |/></Alloy>')).includes('bindId'));
		});

		it('should offer name on an ItemTemplate, which Alloy refuses to compile without', async () => {
			// Alloy.Abstract.ItemTemplate.js: `if (!name) U.dieWithNode(node, NAME_ERROR)`
			const onTemplate = await labelsAt('<Alloy><ItemTemplate |/></Alloy>');
			const onLabel = await labelsAt('<Alloy><Label |/></Alloy>');

			assert.ok(onTemplate.includes('name'), 'a template must be named');
			assert.ok(!onLabel.includes('name'), 'nothing else takes it');
		});

		it('should offer attributes for an element that reaches nothing on $', async () => {
			// everything inside an <ItemTemplate> is local and still has attributes
			const labels = await labelsAt('<Alloy><ItemTemplate><Label |/></ItemTemplate></Alloy>');

			assert.ok(labels.includes('text'));
		});
	});

	it('should answer nothing where nothing belongs', async () => {
		const root = await fixturePath('alloy-project');
		const project = new Project(root);
		await project.load();

		const found = await viewCompletionsAt({
			project,
			view: { path: path.join(root, 'app/views/index.xml'), text: '<Alloy/>' },
			// past the end of the document, which is where a stale position lands
			offset: 500,
			api,
			cache: new SourceCache()
		});

		assert.deepEqual(found, []);
	});

	describe('attribute values', () => {

		it('should offer the classes the stylesheets that apply define', async () => {
			// app.tss and the paired index.tss, which is what Alloy would apply here
			const labels = await labelsAt('<Alloy><Label class="|"/></Alloy>');

			assert.ok(labels.includes('container'), 'expected a class from index.tss');
		});

		it('should offer the ids the stylesheets define', async () => {
			const labels = await labelsAt('<Alloy><Label id="|"/></Alloy>');

			assert.ok(labels.includes('label'));
			assert.ok(!labels.includes('container'), 'a class is not an id');
		});

		it('should not offer a class from a stylesheet Alloy would not apply here', async () => {
			// a widget gets its own styles and not the app's, which styleDefinitionAt already
			// gets right and which anything else reading stylesheets has to get right too
			const found = await completionsAt(
				'<Alloy><Label class="|"/></Alloy>',
				'alloy-project',
				'app/widgets/widget-test/views/widget.xml'
			);
			const labels = found.map(entry => entry.label);

			assert.ok(labels.includes('widgetLabel'), 'expected the widget\'s own class');
			assert.ok(!labels.includes('container'), 'app.tss is not carried into a widget');
		});

		it('should offer the controllers a Require can name', async () => {
			const labels = await labelsAt('<Alloy><Require src="|"/></Alloy>');

			assert.ok(labels.includes('index'));
			assert.ok(labels.includes('folder/test'), 'a nested controller is named with a slash');
		});

		it('should offer the widgets a Widget can name, and not the controllers', async () => {
			const labels = await labelsAt('<Alloy><Widget src="|"/></Alloy>');

			assert.ok(labels.includes('widget-test'));
			assert.ok(!labels.includes('index'), 'src means something different on each tag');
		});

		it('should offer the models a Model or a Collection can name', async () => {
			// a third vocabulary over the same attribute: src on a Model is neither a controller
			// nor a widget
			const onModel = await labelsAt('<Alloy><Model src="|"/></Alloy>');
			const onCollection = await labelsAt('<Alloy><Collection src="|"/></Alloy>');

			assert.ok(onModel.includes('test'), 'expected a model name');
			assert.ok(!onModel.includes('widget-test'), 'a widget is not a model');
			assert.ok(!onModel.includes('index'), 'a controller is not a model');
			assert.deepEqual(onCollection, onModel, 'a Collection names the same models');
		});

		it('should offer the modules a module attribute can name', async () => {
			const labels = await labelsAt('<Alloy><CustomView module="|"/></Alloy>');

			assert.ok(labels.includes('folder/custom-view'), 'a file under app/lib');
		});

		it('should offer image paths in a property that takes an image', async () => {
			const labels = await labelsAt('<Alloy><ImageView image="|"/></Alloy>');

			assert.ok(labels.includes('/images/logo.png'));
			assert.ok(!labels.some(label => label.includes('@2x')), 'a density variant is not a path to write');
		});

		it('should replace the value and not the quotes around it', async () => {
			// without an explicit span a client works out what to replace from its own idea of a
			// word, and accepting /images/lo leaves /images//images/logo.png in the view
			const text = '<Alloy><ImageView image="/images/lo"/></Alloy>';
			const cursor = text.indexOf('/images/lo') + '/images/lo'.length;
			const found = await completionsAt(`${text.slice(0, cursor)}|${text.slice(cursor)}`);
			const logo = found.find(entry => entry.label === '/images/logo.png');

			assert.deepEqual(logo?.range, { start: text.indexOf('"/images/lo') + 1, end: cursor });
		});

		it('should answer nothing for a property whose values the types cannot supply', async () => {
			// @types/titanium carries no literal types at all, so textAlign is string | number and
			// there is nothing honest to offer for it
			assert.deepEqual(await labelsAt('<Alloy><Label textAlign="|"/></Alloy>'), []);
		});

		it('should offer the translation keys inside an L() in a value', async () => {
			const labels = await labelsAt('<Alloy><Label text="L(\'|\')"/></Alloy>');

			assert.ok(labels.includes('test'));
			assert.ok(labels.includes('welcome.title'));
		});

		it('should offer the Alloy.CFG keys inside a value', async () => {
			const labels = await labelsAt('<Alloy><Label text="Alloy.CFG.|"/></Alloy>');

			assert.ok(labels.includes('test'), 'a global key');
			assert.ok(labels.includes('debug'), 'a key only an environment section declares');
		});

		it('should replace only what has been typed of a key, not the whole value', async () => {
			const text = '<Alloy><Label text="Alloy.CFG.re"/></Alloy>';
			const cursor = text.indexOf('re"') + 2;
			const found = await completionsAt(`${text.slice(0, cursor)}|${text.slice(cursor)}`);
			const retries = found.find(entry => entry.label === 'retries');

			assert.deepEqual(retries?.range, { start: cursor - 2, end: cursor });
		});
	});

	describe('element text', () => {

		it('should offer the translation keys inside an L() outside a tag', async () => {
			// the case the previous implementation dropped: it could only see inside an attribute
			const labels = await labelsAt('<Alloy><Label>L(\'|\')</Label></Alloy>');

			assert.ok(labels.includes('test'));
		});

		it('should answer nothing in text that is not a localised string', async () => {
			assert.deepEqual(await labelsAt('<Alloy><Label>Hello |</Label></Alloy>'), []);
		});
	});
});

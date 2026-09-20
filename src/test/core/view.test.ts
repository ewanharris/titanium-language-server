import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { viewCompletionsAt } from '../../core/view.ts';
import type { ApiSource } from '../../core/view.ts';

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
				{ name: 'text', kind: 'property', documentation: 'The text to display' },
				{ name: 'color', kind: 'property', documentation: '' },
				{ name: 'add', kind: 'method', documentation: '' }
			];
		}
		// a distinct member, so a test can tell the renamed type from the tag as written
		if (type === 'Titanium.UI.PickerRow') {
			return [ { name: 'title', kind: 'property', documentation: '' } ];
		}
		return [];
	},
	eventsOf: type => type === 'Titanium.UI.Label' ? [ 'click', 'longpress' ] : []
};

/**
 * The completions offered at the first occurrence of a marker in a view
 *
 * @param text - The view source, with `|` marking the cursor
 * @returns The labels offered there
 */
function labelsAt (text: string): string[] {
	const offset = text.indexOf('|');
	const source = text.replace('|', '');

	return viewCompletionsAt({ path: '/app/views/index.xml', text: source }, offset, api).map(entry => entry.label);
}

describe('What can be written in a view', () => {

	describe('tag names', () => {

		it('should offer the tags the types can create', () => {
			const labels = labelsAt('<Alloy><La|</Alloy>');

			assert.ok(labels.includes('Label'));
			assert.ok(labels.includes('Window'));
		});

		it('should offer the tags Alloy resolves to another namespace', () => {
			const labels = labelsAt('<Alloy><An|</Alloy>');

			assert.ok(labels.includes('Annotation'), 'Ti.Map');
			assert.ok(labels.includes('Require'), 'Alloy\'s own markup is a tag too');
		});

		it('should replace the tag name rather than leaving the client to guess', () => {
			const text = '<Alloy><Lab</Alloy>';
			const found = viewCompletionsAt({ path: '/app/views/index.xml', text }, text.indexOf('Lab') + 3, api);
			const label = found.find(entry => entry.label === 'Label');

			assert.deepEqual(label?.range, { start: text.indexOf('Lab'), end: text.indexOf('Lab') + 3 });
		});
	});

	describe('attribute names', () => {

		it('should offer the properties of the element\'s type', () => {
			const labels = labelsAt('<Alloy><Label |/></Alloy>');

			assert.ok(labels.includes('text'));
			assert.ok(labels.includes('color'));
		});

		it('should not offer a method as an attribute', () => {
			// an attribute is a property; `add` is something the controller calls
			assert.ok(!labelsAt('<Alloy><Label |/></Alloy>').includes('add'));
		});

		it('should offer the events as on plus the capitalised name', () => {
			const labels = labelsAt('<Alloy><Label |/></Alloy>');

			assert.ok(labels.includes('onClick'));
			assert.ok(labels.includes('onLongpress'));
		});

		it('should offer Alloy\'s own attributes whatever the element is', () => {
			const labels = labelsAt('<Alloy><Label |/></Alloy>');

			for (const attribute of [ 'id', 'class', 'platform', 'formFactor', 'if', 'ns' ]) {
				assert.ok(labels.includes(attribute), `expected ${attribute}`);
			}
		});

		it('should offer src and type on a Require, which only those tags take', () => {
			const onRequire = labelsAt('<Alloy><Require |/></Alloy>');
			const onLabel = labelsAt('<Alloy><Label |/></Alloy>');

			assert.ok(onRequire.includes('src'));
			assert.ok(onRequire.includes('type'));
			assert.ok(!onLabel.includes('src'), 'a Label does not take src');
		});

		it('should not offer an attribute the element already has', () => {
			// the dedupe that never fired: it compared `id` against raw matches like `" id="`, so
			// everything already written was offered again. The parse gives the names for free
			const labels = labelsAt('<Alloy><Label text="hi" id="a" |/></Alloy>');

			assert.ok(!labels.includes('text'), 'text is already written');
			assert.ok(!labels.includes('id'), 'id is already written');
			assert.ok(labels.includes('color'), 'color is not');
		});

		it('should not offer an event the element already has under a platform prefix', () => {
			// Alloy's RESERVED_EVENT_REGEX accepts ios:onClick, so the element has that handler
			// already and offering onClick beside it is offering a duplicate
			const labels = labelsAt('<Alloy><Label ios:onClick="go" |/></Alloy>');

			assert.ok(!labels.includes('onClick'), 'ios:onClick is already the click handler');
			assert.ok(labels.includes('onLongpress'));
		});

		it('should offer the events under a prefix once one has been typed', () => {
			const labels = labelsAt('<Alloy><Label ios:|/></Alloy>');

			assert.ok(labels.includes('ios:onClick'));
			assert.ok(labels.includes('ios:onLongpress'));
		});

		it('should not offer a plain property under a platform prefix', () => {
			// the prefix is Alloy's event syntax and applies to nothing else
			assert.ok(!labelsAt('<Alloy><Label ios:|/></Alloy>').includes('ios:text'));
		});

		it('should offer both insert forms, so a client without snippets is not sent tab stops', () => {
			const text = '<Alloy><Label /></Alloy>';
			const found = viewCompletionsAt({ path: '/app/views/index.xml', text }, text.indexOf('<Label ') + 7, api);
			const color = found.find(entry => entry.label === 'color');

			assert.equal(color?.insert?.snippet, 'color="$1"$0');
			assert.equal(color?.insert?.plain, 'color="');
		});

		it('should carry the documentation the types have', () => {
			const text = '<Alloy><Label /></Alloy>';
			const found = viewCompletionsAt({ path: '/app/views/index.xml', text }, text.indexOf('<Label ') + 7, api);

			assert.match(found.find(entry => entry.label === 'text')?.documentation ?? '', /The text to display/);
		});

		it('should still offer Alloy\'s attributes for a type the project has never heard of', () => {
			// a native module's proxies are not in @types/titanium at all, and id and class are
			// still what a view writes on them
			const labels = labelsAt('<Alloy><Annotation |/></Alloy>');

			assert.ok(labels.includes('id'));
			assert.ok(labels.includes('class'));
		});

		it('should answer in a start tag that was never closed', () => {
			// the normal case mid-keystroke
			const labels = labelsAt('<Alloy><Label |');

			assert.ok(labels.includes('text'));
			assert.ok(labels.includes('id'));
		});

		it('should replace the attribute name being edited', () => {
			const text = '<Alloy><Label col/></Alloy>';
			const found = viewCompletionsAt({ path: '/app/views/index.xml', text }, text.indexOf('col') + 3, api);
			const color = found.find(entry => entry.label === 'color');

			assert.deepEqual(color?.range, { start: text.indexOf('col'), end: text.indexOf('col') + 3 });
		});

		it('should resolve the type through a rename the parent imposes', () => {
			// <Row> inside a <Picker> is a PickerRow and not the table view Row of the same name,
			// so its attributes are a PickerRow's. Asserting the absence of a Label's attributes
			// would prove nothing — an unresolved type has none either
			const labels = labelsAt('<Alloy><Picker><Row |/></Picker></Alloy>');

			assert.ok(labels.includes('title'), 'expected the renamed type\'s own property');
		});

		it('should offer attributes for an element that reaches nothing on $', () => {
			// everything inside an <ItemTemplate> is local and still has attributes
			const labels = labelsAt('<Alloy><ItemTemplate><Label |/></ItemTemplate></Alloy>');

			assert.ok(labels.includes('text'));
		});
	});

	it('should answer nothing where nothing belongs', () => {
		assert.deepEqual(viewCompletionsAt({ path: '/app/views/index.xml', text: '<Alloy/>' }, 500, api), []);
	});
});

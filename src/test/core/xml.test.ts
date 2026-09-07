import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseXml, nodeAt } from '../../core/xml.ts';
import { fixturePath } from '../fixtures.ts';

/** The source a range covers, which is how positions are asserted here */
function slice (text: string, range: { start: number, end: number }): string {
	return text.slice(range.start, range.end);
}

describe('core/xml', () => {

	describe('structure', () => {

		it('should parse the element tree', () => {
			const text = '<Alloy>\n\t<Window class="container">\n\t\t<Label id="lab">hi</Label>\n\t</Window>\n</Alloy>';
			const { roots } = parseXml(text);

			assert.deepEqual(roots.map(element => element.tag), [ 'Alloy' ]);
			assert.deepEqual(roots[0].children.map(element => element.tag), [ 'Window' ]);
			assert.deepEqual(roots[0].children[0].children.map(element => element.tag), [ 'Label' ]);
		});

		it('should preserve Alloy tag casing', () => {
			const { elements } = parseXml('<Alloy><TableViewRow/><ListItem/><ImageView/></Alloy>');
			assert.deepEqual(elements.map(element => element.tag), [ 'Alloy', 'TableViewRow', 'ListItem', 'ImageView' ]);
		});

		it('should expose every element as a flat list as well as a tree', () => {
			// $.__views is flat, so the generated declaration wants the list rather than the tree
			const { elements } = parseXml('<Alloy><Window><Label/></Window></Alloy>');
			assert.deepEqual(elements.map(element => element.tag), [ 'Alloy', 'Window', 'Label' ]);
		});

		it('should give each element a range covering the whole element', () => {
			const text = '<Alloy><Label id="lab">hi</Label></Alloy>';
			const { elements } = parseXml(text);
			const label = elements.find(element => element.tag === 'Label');

			assert.equal(slice(text, label!.range), '<Label id="lab">hi</Label>');
		});

		it('should nest children inside a tag that uses an HTML void name', () => {
			// capitalised Alloy tags must not pick up HTML's void element rules
			const { elements } = parseXml('<Alloy><Input><Label/></Input></Alloy>');
			assert.deepEqual(elements.map(element => element.tag), [ 'Alloy', 'Input', 'Label' ]);
		});

		it('should report every element as closed in a well formed document', () => {
			// the generated `$` declaration has to say whether it describes the whole view or only
			// what survived a half-typed one, and this is the signal it reads
			const { elements } = parseXml('<Alloy><Window><Label id="lab"/></Window></Alloy>');
			assert.deepEqual(elements.map(element => element.closed), [ true, true, true ]);
		});

		it('should report an element whose end tag has not been typed as unclosed', () => {
			const { elements } = parseXml('<Alloy><Window><Label id="lab"/></Alloy>');
			const window = elements.find(element => element.tag === 'Window');

			assert.equal(window?.closed, false);
		});

		it('should report an element still being written as unclosed', () => {
			const { elements } = parseXml('<Alloy><Window class="');
			assert.deepEqual(elements.map(element => [ element.tag, element.closed ]), [ [ 'Alloy', false ], [ 'Window', false ] ]);
		});
	});

	describe('attributes', () => {

		it('should read attribute names and unquoted values', () => {
			const { elements } = parseXml('<Alloy><Label id="lab" class=\'big\' onClick="doClick"/></Alloy>');
			const label = elements.find(element => element.tag === 'Label');

			assert.deepEqual(label!.attributes.map(attribute => [ attribute.name, attribute.value ]), [
				[ 'id', 'lab' ], [ 'class', 'big' ], [ 'onClick', 'doClick' ]
			]);
		});

		it('should give the name and the value their own ranges', () => {
			const text = '<Alloy><Label id="lab"/></Alloy>';
			const { elements } = parseXml(text);
			const id = elements.find(element => element.tag === 'Label')!.attributes[0];

			assert.equal(slice(text, id.nameRange), 'id');
			// the value range excludes the quotes, so an edit replaces just the value
			assert.equal(slice(text, id.valueRange!), 'lab');
		});

		it('should leave id in the attributes rather than lifting it out', () => {
			// a lifted copy would lose the range, and anything locating an id needs one
			const { elements } = parseXml('<Alloy><Label id="lab"/><Label/></Alloy>');
			const labels = elements.filter(element => element.tag === 'Label');

			assert.equal(labels[0].attributes.find(attribute => attribute.name === 'id')?.value, 'lab');
			assert.deepEqual(labels[1].attributes, []);
		});

		it('should read a value with no name as a nameless attribute', () => {
			// the scanner reports the bare `"orphan"` as an attribute name with the stray `=` and
			// quotes as unknown tokens, so that is what comes back — a half-written attribute
			const { elements } = parseXml('<Alloy><Label ="orphan" id="lab"/></Alloy>');
			const label = elements.find(element => element.tag === 'Label');

			assert.deepEqual(label!.attributes.map(attribute => [ attribute.name, attribute.value ]), [
				[ 'orphan', undefined ], [ 'id', 'lab' ]
			]);
		});

		it('should strip the opening quote from a value that is still being typed', () => {
			// `id="lab` has no closing quote yet; the value is `lab`, not `"lab`. This is the case
			// the parser exists for, so getting it wrong here is worse than anywhere else
			const text = '<Alloy><Label id="lab';
			const { elements } = parseXml(text);
			const id = elements.find(element => element.tag === 'Label')!.attributes[0];

			assert.equal(id.value, 'lab');
			assert.equal(slice(text, id.valueRange!), 'lab');
		});

		it('should keep an attribute that has no value yet', () => {
			const { elements } = parseXml('<Alloy><Window onOpen ></Window></Alloy>');
			const window = elements.find(element => element.tag === 'Window');

			assert.deepEqual(window!.attributes.map(attribute => attribute.name), [ 'onOpen' ]);
			assert.equal(window!.attributes[0].value, undefined);
			assert.equal(window!.attributes[0].valueRange, undefined);
		});
	});

	describe('documents being typed', () => {

		it('should keep the element under the cursor when a tag is unclosed', () => {
			// this is the case xmldom loses: it returns Alloy and nothing else
			const { elements } = parseXml('<Alloy>\n\t<Window class="container">\n\t\t<Label id="lab');
			assert.deepEqual(elements.map(element => element.tag), [ 'Alloy', 'Window', 'Label' ]);
		});

		it('should keep the element whose attribute is half typed', () => {
			const { elements } = parseXml('<Alloy><Window class="');
			assert.deepEqual(elements.map(element => element.tag), [ 'Alloy', 'Window' ]);
		});

		it('should produce a node for a bare < that has no name yet', () => {
			const { elements } = parseXml('<Alloy>\n\t<');
			assert.equal(elements.length, 2);
			assert.equal(elements[1].tag, undefined);
		});

		it('should recover from a mismatched closing tag', () => {
			const { elements } = parseXml('<Alloy><Window></Alloy>');
			assert.deepEqual(elements.map(element => element.tag), [ 'Alloy', 'Window' ]);
		});

		it('should never throw on any of it', () => {
			for (const text of [ '', '<', '</>', '<<>>', '<Alloy', '<Alloy></Window>', '<?xml' ]) {
				assert.doesNotThrow(() => parseXml(text), `threw on ${JSON.stringify(text)}`);
			}
		});
	});

	describe('tiapp.xml', () => {

		it('should read a namespaced document', () => {
			const text = '<?xml version="1.0"?><ti:app xmlns:ti="http://ti.appcelerator.org"><id>x</id><sdk-version>12.4.0.GA</sdk-version></ti:app>';
			const { elements } = parseXml(text);
			const sdk = elements.find(element => element.tag === 'sdk-version');

			assert.notEqual(sdk, undefined);
			assert.equal(sdk!.text, '12.4.0.GA');
		});

		it('should still find the sdk version in a half saved tiapp.xml', () => {
			// xmldom 0.8 loses everything after the malformation here
			const text = '<?xml version="1.0"?><ti:app xmlns:ti="http://ti.appcelerator.org"><name>oops<sdk-version>12.4.0.GA</sdk-version></ti:app>';
			const { elements } = parseXml(text);
			const sdk = elements.find(element => element.tag === 'sdk-version');

			assert.equal(sdk?.text, '12.4.0.GA');
		});
	});

	describe('the real fixtures', () => {
		let views: string;

		before(async () => {
			views = path.join(await fixturePath('alloy-project'), 'app', 'views');
		});

		it('should parse index.xml', async () => {
			const text = await fs.readFile(path.join(views, 'index.xml'), 'utf-8');
			const { elements } = parseXml(text);

			assert.deepEqual(elements.map(element => element.tag), [ 'Alloy', 'Window', 'Label' ]);
			const label = elements.find(element => element.tag === 'Label');
			assert.equal(label?.attributes.find(attribute => attribute.name === 'id')?.value, 'label');
		});

		it('should recover every element from the half typed sample.xml', async () => {
			// sample.xml has an unclosed <ImageView>, which Alloy itself refuses to compile
			const text = await fs.readFile(path.join(views, 'sample.xml'), 'utf-8');
			const { elements } = parseXml(text);
			const ids = elements
				.map(element => element.attributes.find(attribute => attribute.name === 'id')?.value)
				.filter(Boolean);

			for (const expected of [ 'container', 'scrollView', 'noexistid', 'notificationLabel', 'androidView' ]) {
				assert.ok(ids.includes(expected), `expected id ${expected}, got ${ids.join(', ')}`);
			}
		});
	});

	describe('nodeAt', () => {

		it('should find the tag name under an offset', () => {
			const text = '<Alloy><Label id="lab"/></Alloy>';
			const found = nodeAt(parseXml(text), text.indexOf('Label') + 2);

			assert.equal(found?.kind, 'tag');
			assert.equal(found?.element.tag, 'Label');
		});

		it('should report the tag when the offset is in the name of an element that has text', () => {
			// the element's own text would otherwise win, since the tag name sits inside its range
			const text = '<Alloy><Label>hello</Label></Alloy>';
			const found = nodeAt(parseXml(text), text.indexOf('Label') + 2);

			assert.equal(found?.kind, 'tag');
			assert.equal(found?.element.tag, 'Label');
		});

		it('should distinguish an attribute name from its value', () => {
			const text = '<Alloy><Label onClick="doClick"/></Alloy>';
			const document = parseXml(text);

			const name = nodeAt(document, text.indexOf('onClick') + 2);
			assert.equal(name?.kind, 'attributeName');
			assert.equal(name?.attribute?.name, 'onClick');

			const value = nodeAt(document, text.indexOf('doClick') + 2);
			assert.equal(value?.kind, 'attributeValue');
			assert.equal(value?.attribute?.name, 'onClick');
		});

		it('should report the innermost element for a position in its text', () => {
			const text = '<Alloy><Label>hello</Label></Alloy>';
			const found = nodeAt(parseXml(text), text.indexOf('hello') + 2);

			assert.equal(found?.kind, 'text');
			assert.equal(found?.element.tag, 'Label');
		});

		it('should return nothing outside the document', () => {
			assert.equal(nodeAt(parseXml('<Alloy/>'), 500), undefined);
		});
	});
});

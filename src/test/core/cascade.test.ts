import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStyle, sortRules, styledElements } from '../../core/cascade.ts';
import type { CascadeSource, ResolvedProperty, StyledElement } from '../../core/cascade.ts';

const APP = '/project/app/styles/app.tss';
const INDEX = '/project/app/styles/index.tss';
const VIEW = '/project/app/views/index.xml';

/**
 * The elements of a view, as the cascade sees them
 *
 * @param text - The view
 * @returns {StyledElement[]} Every element that creates a Titanium type
 */
function elementsOf (text: string): StyledElement[] {
	return styledElements({ path: VIEW, text });
}

/**
 * What an element in a view ends up with, from the stylesheets given in the order Alloy loads them
 *
 * @param view - The view
 * @param styles - The stylesheets, `app.tss` first
 * @param which - Which element, by its index among those with a type
 * @returns {Map<string, ResolvedProperty>} Each property, by its dotted path
 */
function resolved (view: string, styles: CascadeSource[], which = 0): Map<string, ResolvedProperty> {
	const element = elementsOf(view)[which];
	return new Map(resolveStyle(sortRules(styles), element).map(property => [ property.name, property ]));
}

/**
 * The selector that sets a property, or `attribute` when the element sets it itself
 *
 * @param property - The resolved property
 * @returns {string|undefined} Where its value comes from
 */
function from (property: ResolvedProperty|undefined): string|undefined {
	return property?.attribute ? 'attribute' : property?.applied?.rule.rule.selector.text;
}

describe('The cascade', () => {

	describe('the elements of a view', () => {

		it('should type each element, with its id and classes', () => {
			const [ window, label ] = elementsOf('<Alloy><Window id="main" class="a  b"><Label/></Window></Alloy>');

			assert.equal(window.type, 'Titanium.UI.Window');
			assert.equal(window.id, 'main');
			assert.deepEqual(window.classes, [ 'a', 'b' ]);
			assert.equal(label.type, 'Titanium.UI.Label');
		});

		it('should give a top level element with no id the view\'s name, as Alloy does', () => {
			const [ window, label ] = elementsOf('<Alloy><Window><Label/></Window></Alloy>');

			assert.equal(window.id, 'index');
			assert.equal(label.id, undefined, 'only a direct child of <Alloy> takes the default');
		});

		it('should leave out Alloy\'s own markup, which nothing styles', () => {
			const tags = elementsOf('<Alloy><Window><Require src="x"/></Window></Alloy>').map(element => element.element.tag);

			assert.deepEqual(tags, [ 'Window' ]);
		});
	});

	describe('which rule wins', () => {

		it('should put an id over a class over a tag, wherever each is written', () => {
			// document order is the reverse of priority, so order alone would get every one wrong
			const properties = resolved('<Alloy><Label id="title" class="big"/></Alloy>', [ {
				path: INDEX,
				text: '"#title": { color: "red" }\n".big": { color: "green", font: { fontSize: 20 } }\n"Label": { color: "blue", text: "x", font: { fontSize: 10 } }'
			} ]);

			assert.equal(from(properties.get('color')), '#title');
			assert.equal(from(properties.get('font.fontSize')), '.big');
			assert.equal(from(properties.get('text')), 'Label');
		});

		it('should say what each winner overrides, in the order it was applied', () => {
			const color = resolved('<Alloy><Label id="title" class="big"/></Alloy>', [ {
				path: INDEX,
				text: '"Label": { color: "blue" }\n".big": { color: "green" }\n"#title": { color: "red" }'
			} ]).get('color');

			assert.deepEqual(color?.overridden.map(source => source.rule.rule.selector.text), [ 'Label', '.big' ]);
		});

		it('should let the view\'s own stylesheet beat app.tss at the same priority', () => {
			const color = resolved('<Alloy><Label/></Alloy>', [
				{ path: APP, text: '"Label": { color: "blue" }' },
				{ path: INDEX, text: '"Label": { color: "red" }' }
			]).get('color');

			assert.equal(color?.applied?.rule.file, INDEX);
		});

		it('should let an id in app.tss beat a class in the view\'s own stylesheet', () => {
			const color = resolved('<Alloy><Label id="title" class="big"/></Alloy>', [
				{ path: APP, text: '"#title": { color: "blue" }' },
				{ path: INDEX, text: '".big": { color: "red" }' }
			]).get('color');

			assert.equal(color?.applied?.rule.file, APP);
		});

		it('should put a rule with a query over the same selector without one', () => {
			const color = resolved('<Alloy><Label/></Alloy>', [ {
				path: INDEX,
				text: '"Label[foo=bar]": { color: "red" }\n"Label": { color: "blue" }'
			} ]).get('color');

			// an unknown query is applied unconditionally, and still counts towards priority
			assert.equal(from(color), 'Label[foo=bar]');
		});

		it('should match a tag rule on the type an element creates rather than the tag it writes', () => {
			// Alloy compares the last segment of the element's API name, and a <Row> in a <Picker>
			// is a PickerRow
			const [ , , row ] = elementsOf('<Alloy><Picker><Column><Row/></Column></Picker></Alloy>');
			const rules = sortRules([ { path: INDEX, text: '"PickerRow": { color: "red" }\n"Row": { color: "blue" }' } ]);

			assert.deepEqual(resolveStyle(rules, row).map(property => from(property)), [ 'PickerRow' ]);
		});

		it('should let an attribute on the element beat every rule', () => {
			const color = resolved('<Alloy><Label id="title" color="green"/></Alloy>', [ { path: INDEX, text: '"#title": { color: "red" }' } ]).get('color');

			assert.equal(from(color), 'attribute');
			assert.equal(color?.overridden[0]?.rule.rule.selector.text, '#title');
		});

		it('should not count Alloy\'s own attributes as properties the element sets', () => {
			const properties = resolved('<Alloy><Label id="title" class="big" platform="ios"/></Alloy>', [ { path: INDEX, text: '"Label": { color: "red" }' } ]);

			assert.deepEqual([ ...properties.keys() ], [ 'color' ]);
		});
		it('should not count binding attributes as properties the element sets', () => {
			// Alloy strips all four binding attributes from a bound element before reading the rest,
			// and bindId names a part of an item template rather than setting anything
			const properties = resolved('<Alloy><Label dataCollection="c" dataFilter="f" dataTransform="t" dataFunction="u" bindId="b" text="Hi"/></Alloy>', []);

			assert.deepEqual([ ...properties.keys() ], [ 'text' ]);
		});
	});

	describe('comma separated selectors', () => {

		it('should give each part of a key its own priority', () => {
			// ".a" beats both Label rules, though the second Label rule comes later: split into two
			// rules, the class part sorts as a class. Read whole, ".a, Label" would match nothing
			const color = resolved('<Alloy><Label class="a"/></Alloy>', [ {
				path: INDEX,
				text: '".a, Label": { color: "x" }\n"Label": { color: "y" }'
			} ]).get('color');

			assert.equal(color?.value, '"x"');
			assert.equal(color?.applied?.rule.part.text, '.a');
		});

		it('should style every element any part names', () => {
			const [ header, footer ] = elementsOf('<Alloy><Window><View id="header"/><View id="footer"/></Window></Alloy>').slice(1);
			const rules = sortRules([ { path: INDEX, text: '"#header, #footer": { height: 44 }' } ]);

			assert.equal(resolveStyle(rules, header)[0]?.value, '44');
			assert.equal(resolveStyle(rules, footer)[0]?.value, '44');
		});

		it('should keep a query on its own part only', () => {
			const [ muted, secondary ] = elementsOf('<Alloy><Window><Label class="muted"/><Label id="secondary"/></Window></Alloy>').slice(1);
			const rules = sortRules([ { path: INDEX, text: '".muted[platform=ios], #secondary": { color: "red" }' } ]);

			assert.equal(resolveStyle(rules, muted)[0]?.conditional.length, 1, 'the query holds on its own part');
			assert.equal(resolveStyle(rules, secondary)[0]?.applied?.rule.part.text, '#secondary', 'and not on the other');
		});

		it('should skip a part Alloy would reject and keep the others', () => {
			const color = resolved('<Alloy><Label/></Alloy>', [ { path: INDEX, text: '"[x], Label": { color: "red" }' } ]).get('color');

			assert.equal(color?.applied?.rule.part.text, 'Label');
		});
	});

	describe('platform and theme stylesheets', () => {

		it('should put a platform folder\'s rule over the same selector outside one, and apply it only there', () => {
			// styles/ios/app.tss loads before index.tss, but a platform folder adds to priority
			const color = resolved('<Alloy><Label/></Alloy>', [
				{ path: APP, text: '"Label": { color: "black" }' },
				{ path: '/project/app/styles/ios/app.tss', text: '"Label": { color: "blue" }', platform: 'ios', conditional: true },
				{ path: INDEX, text: '"Label": { color: "red" }' }
			]).get('color');

			assert.equal(color?.value, '"red"', 'outright, the view\'s own stylesheet');
			assert.deepEqual(color?.conditional.map(source => source.rule.file), [ '/project/app/styles/ios/app.tss' ]);
		});

		it('should put a theme\'s rule over the same selector in the app, wherever it loads', () => {
			// the theme's app.tss loads before index.tss, and wins on the theme's bonus alone
			const color = resolved('<Alloy><Label/></Alloy>', [
				{ path: APP, text: '"Label": { color: "black" }' },
				{ path: '/project/app/themes/dark/styles/app.tss', text: '"Label": { color: "white" }', theme: 'dark', conditional: false },
				{ path: INDEX, text: '"Label": { color: "red" }' }
			]).get('color');

			assert.equal(color?.value, '"white"');
		});

		it('should not let a bonus lift a tag over a class', () => {
			const color = resolved('<Alloy><Label class="big"/></Alloy>', [
				{ path: INDEX, text: '".big": { color: "red" }' },
				{ path: '/project/app/themes/dark/styles/ios/index.tss', text: '"Label": { color: "white" }', platform: 'ios', theme: 'dark', conditional: true }
			]).get('color');

			assert.equal(color?.value, '"red"');
			assert.deepEqual(color?.conditional, []);
		});
	});

	describe('conditions', () => {

		it('should not apply a platform rule outright, but say it overrides when its platform holds', () => {
			const color = resolved('<Alloy><Label/></Alloy>', [ {
				path: INDEX,
				text: '"Label[platform=ios]": { color: "red" }\n"Label": { color: "blue" }'
			} ]).get('color');

			// the platform rule sorts after, and so would win — but only on iOS
			assert.equal(from(color), 'Label');
			assert.deepEqual(color?.conditional.map(source => source.rule.rule.selector.text), [ 'Label[platform=ios]' ]);
		});

		it('should treat formFactor and if as conditions too', () => {
			const color = resolved('<Alloy><Label/></Alloy>', [ {
				path: INDEX,
				text: '"Label": { color: "blue" }\n"Label[formFactor=tablet]": { color: "red" }\n"Label[if=Alloy.Globals.big]": { color: "green" }'
			} ]).get('color');

			assert.equal(from(color), 'Label');
			assert.equal(color?.conditional.length, 2);
		});

		it('should answer a property only a condition sets, with nothing applied outright', () => {
			const color = resolved('<Alloy><Label/></Alloy>', [ { path: INDEX, text: '"Label[platform=android]": { color: "red" }' } ]).get('color');

			assert.equal(color?.applied, undefined);
			assert.equal(color?.conditional.length, 1);
		});

		it('should not let a condition that sorts before the winner claim to override it', () => {
			const color = resolved('<Alloy><Label id="title"/></Alloy>', [ {
				path: INDEX,
				text: '"Label[platform=ios]": { color: "red" }\n"#title": { color: "blue" }'
			} ]).get('color');

			assert.deepEqual(color?.conditional, []);
			assert.equal(color?.overridden[0]?.rule.rule.selector.text, 'Label[platform=ios]');
		});
	});

	describe('merging', () => {

		it('should merge nested objects rather than replacing them', () => {
			// deepExtend: a font from the tag and a font from the id both reach the label
			const properties = resolved('<Alloy><Label id="title"/></Alloy>', [ {
				path: INDEX,
				text: '"Label": { font: { fontSize: 10, fontFamily: "a" } }\n"#title": { font: { fontSize: 20 } }'
			} ]);

			assert.equal(from(properties.get('font.fontSize')), '#title');
			assert.equal(from(properties.get('font.fontFamily')), 'Label');
		});

		it('should replace an earlier rule with the same selector in the same file entirely', () => {
			// the stylesheet is an object literal to Alloy, so a repeated key replaces the first
			const properties = resolved('<Alloy><Label/></Alloy>', [ {
				path: INDEX,
				text: '"Label": { color: "red", text: "x" }\n"Label": { color: "blue" }'
			} ]);

			assert.equal(properties.get('color')?.value, '"blue"');
			assert.equal(properties.has('text'), false, 'the first rule is gone, not merged');
		});

		it('should keep a repeated selector where it was first written, as an object key keeps its place', () => {
			// the third rule replaces the first, but in the first's place: so the second, which
			// has the same priority, is later and wins
			const color = resolved('<Alloy><Label/></Alloy>', [ {
				path: INDEX,
				text: '"Label[a=b]": { color: "red" }\n"Label[c=d]": { color: "green" }\n"Label[a=b]": { color: "blue" }'
			} ]).get('color');

			assert.equal(color?.value, '"green"');
		});

		it('should take the later of a property written twice in one rule', () => {
			const color = resolved('<Alloy><Label/></Alloy>', [ { path: INDEX, text: '"Label": { color: "red", color: "blue" }' } ]).get('color');

			assert.equal(color?.value, '"blue"');
			assert.equal(color?.overridden.length, 1);
		});

		it('should give each value as it is written', () => {
			const properties = resolved('<Alloy><Label/></Alloy>', [ { path: INDEX, text: '"Label": { width: Ti.UI.SIZE, text: L(\'hi\') }' } ]);

			assert.equal(properties.get('width')?.value, 'Ti.UI.SIZE');
			assert.equal(properties.get('text')?.value, 'L(\'hi\')');
		});

		it('should skip a selector Alloy would reject, and a property with no value yet', () => {
			const properties = resolved('<Alloy><Label/></Alloy>', [ { path: INDEX, text: '"[platform=ios]": { color: "red" }\n"Label": { color: , text: "x" }' } ]);

			assert.deepEqual([ ...properties.keys() ], [ 'text' ]);
		});
	});
});

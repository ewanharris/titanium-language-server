import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTag, startsLocal } from '../../core/tags.ts';
import { parseXml } from '../../core/xml.ts';
import type { XmlElement } from '../../core/xml.ts';

/**
 * Resolves the named element of a view, along with its parent, which is what the rules that read
 * one need
 *
 * @param text - The view
 * @param tag - The tag to resolve, the first of that name
 * @returns {string[]|undefined} The types it contributes to `$`, or nothing when it contributes none
 */
function resolve (text: string, tag: string): string[]|undefined {
	const { roots } = parseXml(text);
	const found = locate(roots, tag);
	assert.ok(found, `expected a <${tag}> in the view`);
	return resolveTag(found.element, { parent: found.parent });
}

/**
 * Finds an element and its parent in a parsed tree
 *
 * @param elements - The elements to search, depth first
 * @param tag - The tag wanted
 * @param parent - The parent of the elements being searched
 * @returns The element and its parent, if it is there
 */
function locate (elements: XmlElement[], tag: string, parent?: XmlElement): { element: XmlElement; parent?: XmlElement }|undefined {
	for (const element of elements) {
		if (element.tag === tag) {
			return { element, parent };
		}
		const nested = locate(element.children, tag, element);
		if (nested) {
			return nested;
		}
	}
}

describe('core/tags', () => {

	describe('the namespace rule', () => {

		it('should default a bare tag to Ti.UI', () => {
			assert.deepEqual(resolve('<Alloy><Label id="a"/></Alloy>', 'Label'), [ 'Titanium.UI.Label' ]);
		});

		it('should take the implicit namespace over the default', () => {
			assert.deepEqual(resolve('<Alloy><Annotation id="a"/></Alloy>', 'Annotation'), [ 'Titanium.Map.Annotation' ]);
			assert.deepEqual(resolve('<Alloy><VideoPlayer id="a"/></Alloy>', 'VideoPlayer'), [ 'Titanium.Media.VideoPlayer' ]);
			assert.deepEqual(resolve('<Alloy><CardView id="a"/></Alloy>', 'CardView'), [ 'Titanium.UI.Android.CardView' ]);
			assert.deepEqual(resolve('<Alloy><TabGroup><Menu><MenuItem id="a"/></Menu></TabGroup></Alloy>', 'MenuItem'), [ 'Titanium.Android.MenuItem' ]);
			assert.deepEqual(resolve('<Alloy><SplitWindow id="a"/></Alloy>', 'SplitWindow'), [ 'Titanium.UI.iOS.SplitWindow' ]);
			assert.deepEqual(resolve('<Alloy><Popover id="a"/></Alloy>', 'Popover'), [ 'Titanium.UI.iPad.Popover' ]);
		});

		it('should take an explicit ns attribute over the implicit namespace', () => {
			// this is the first term in Alloy's own rule, and the only way a module's own proxy
			// can be named at all
			assert.deepEqual(resolve('<Alloy><View id="a" ns="Ti.Map"/></Alloy>', 'View'), [ 'Titanium.Map.View' ]);
		});

		it('should write the namespace as Titanium rather than Ti', () => {
			// `Ti` is a value alias — `declare const Ti: typeof Titanium` — so `Ti.UI.Label` is not
			// a type name and a declaration using one would not compile
			assert.deepEqual(resolve('<Alloy><Label id="a" ns="Titanium.UI"/></Alloy>', 'Label'), [ 'Titanium.UI.Label' ]);
		});
	});

	describe('the parser rewrites', () => {

		it('should resolve AndroidView to a plain view', () => {
			// Ti.UI.AndroidView.js: "AndroidView is simply an instance of Ti.UI.View"
			assert.deepEqual(resolve('<Alloy><AndroidView id="a"/></Alloy>', 'AndroidView'), [ 'Titanium.UI.View' ]);
		});

		it('should resolve a Module to a plain view', () => {
			assert.deepEqual(resolve('<Alloy><Module id="a" module="dk.napp.drawer"/></Alloy>', 'Module'), [ 'Titanium.UI.View' ]);
		});

		it('should resolve a Module to a view whatever module it names', () => {
			// Alloy.Module.js sets nodeName to View in both of its branches; ti.map changes which
			// parser reads the children, not what the node is. Verified against the compiler:
			// `<Module module="ti.map">` yields `(require("ti.map").createView || Ti.UI.createView)(…)`
			assert.deepEqual(resolve('<Alloy><Module id="a" module="ti.map"/></Alloy>', 'Module'), [ 'Titanium.UI.View' ]);
		});

		it('should leave a tag with an ns attribute in that namespace, rewrite or not', () => {
			// Alloy.Module.js also tests ns="Alloy.Globals.Map", but an ns attribute means the
			// fullname is never Alloy.Module and that parser is never the one picked — so the check
			// is unreachable there and must not be reproduced here. ALOY-817 is the proof:
			// `<View ns="Alloy.Globals.Map"/>` compiles to `Alloy.Globals.Map.createView(…)`
			assert.deepEqual(resolve('<Alloy><Module id="a" ns="Alloy.Globals.Map"/></Alloy>', 'Module'), [ 'Alloy.Globals.Map.Module' ]);
			assert.deepEqual(resolve('<Alloy><View id="a" ns="Alloy.Globals.Map"/></Alloy>', 'View'), [ 'Alloy.Globals.Map.View' ]);
		});

		it('should resolve a Picker\'s shorthand children to picker rows and columns', () => {
			// Ti.UI.Picker.js reassigns its own children's nodeName, so <Row> under a <Picker> is a
			// PickerRow and not the table view type of the same name
			assert.deepEqual(resolve('<Alloy><Picker><Column id="a"/></Picker></Alloy>', 'Column'), [ 'Titanium.UI.PickerColumn' ]);
			assert.deepEqual(resolve('<Alloy><Picker><Row id="a"/></Picker></Alloy>', 'Row'), [ 'Titanium.UI.PickerRow' ]);
			// the same tags elsewhere are left alone
			assert.deepEqual(resolve('<Alloy><TableView><Row id="a"/></TableView></Alloy>', 'Row'), [ 'Titanium.UI.Row' ]);
		});

		it('should resolve a ListItem to the dictionary a list is given', () => {
			// Ti.UI.ListItem.js emits `$.__views.x = { properties: … }` rather than a proxy, so the
			// type is the data a ListView takes and not the item it hands back
			assert.deepEqual(resolve('<Alloy><ListView><ListSection><ListItem id="a"/></ListSection></ListView></Alloy>', 'ListItem'), [ 'Titanium.UI.ListDataItem' ]);
		});

		it('should resolve a childless nav button to a button', () => {
			// Alloy.Abstract._ProxyProperty.js rewrites the node to a Button when it has no
			// children, and that is the one shape where a proxy property reaches $
			assert.deepEqual(resolve('<Alloy><Window><RightNavButton id="a" title="Right"/></Window></Alloy>', 'RightNavButton'), [ 'Titanium.UI.Button' ]);
			assert.deepEqual(resolve('<Alloy><Window><LeftNavButton id="a"/></Window></Alloy>', 'LeftNavButton'), [ 'Titanium.UI.Button' ]);
		});
	});

	describe('what reaches $ at all', () => {

		it('should skip the Alloy document root', () => {
			assert.equal(resolve('<Alloy id="a"><Label/></Alloy>', 'Alloy'), undefined);
		});

		it('should skip an element that has no tag yet', () => {
			const { roots } = parseXml('<Alloy><');
			assert.equal(resolveTag(roots[0].children[0], { parent: roots[0] }), undefined);
		});

		it('should skip the abstract tags, which have no proxy type', () => {
			for (const tag of [ 'Item', 'Items', 'ItemTemplate', 'Option', 'Options', 'Labels', 'FlexSpace', 'Preview' ]) {
				assert.equal(resolve(`<Alloy><Label><${tag} id="a"/></Label></Alloy>`, tag), undefined, `expected <${tag}> to contribute nothing`);
			}
		});

		it('should skip a proxy property that has children', () => {
			// the proxy property parsers assign the child's symbol to the parent and never emit
			// one of their own, so the id names nothing. Verified against Alloy's own generated
			// controllers: <ContentView> yields `$.__views.popover.contentView = $.__views.popView`
			assert.equal(resolve('<Alloy><Popover><ContentView id="a"><View/></ContentView></Popover></Alloy>', 'ContentView'), undefined);
			assert.equal(resolve('<Alloy><Window><LeftNavButton id="a"><Button/></LeftNavButton></Window></Alloy>', 'LeftNavButton'), undefined);
			assert.equal(resolve('<Alloy><ListView><SearchView id="a"><SearchBar/></SearchView></ListView></Alloy>', 'SearchView'), undefined);
			assert.equal(resolve('<Alloy><TextField><RightButton id="a"><Button/></RightButton></TextField></Alloy>', 'RightButton'), undefined);
			assert.equal(resolve('<Alloy><DrawerLayout><LeftView id="a"><View/></LeftView></DrawerLayout></Alloy>', 'LeftView'), undefined);
		});

		it('should skip a proxy property container that is never itself a proxy', () => {
			// _ItemArray collects its children into an array property and emits no symbol of its own
			assert.equal(resolve('<Alloy><Window><LeftNavButtons id="a"><Button/></LeftNavButtons></Window></Alloy>', 'LeftNavButtons'), undefined);
			assert.equal(resolve('<Alloy><Window><WindowToolbar id="a"><Button/></WindowToolbar></Window></Alloy>', 'WindowToolbar'), undefined);
		});

		it('should skip an Android container that drives its own children', () => {
			// Ti.Android.Menu.js adds each MenuItem to the event's menu and Ti.Android.ActionBar.js
			// writes onto the parent window's activity — neither assigns a symbol of its own
			assert.equal(resolve('<Alloy><TabGroup><Menu id="a"><MenuItem/></Menu></TabGroup></Alloy>', 'Menu'), undefined);
			assert.equal(resolve('<Alloy><Window><ActionBar id="a" title="x"/></Window></Alloy>', 'ActionBar'), undefined);
			// the items themselves do reach $
			assert.deepEqual(resolve('<Alloy><TabGroup><Menu><MenuItem id="a"/></Menu></TabGroup></Alloy>', 'MenuItem'), [ 'Titanium.Android.MenuItem' ]);
		});

		it('should skip everything inside an item template', () => {
			// an ItemTemplate is compiled into a plain object describing a row, and its children
			// become `var __alloyId0 = { type: "Ti.UI.Label" }` rather than proxies
			const view = '<Alloy><ListView><Templates><ItemTemplate name="t"><Label id="a"/></ItemTemplate></Templates></ListView></Alloy>';
			const { roots } = parseXml(view);
			const label = locate(roots, 'Label');

			assert.equal(resolveTag(label!.element, { parent: label!.parent, local: true }), undefined);
		});

		it('should say which elements make their children local', () => {
			assert.equal(startsLocal(parseXml('<Alloy><ItemTemplate name="t"/></Alloy>').elements[1]), true);
			assert.equal(startsLocal(parseXml('<Alloy><View dataCollection="books"/></Alloy>').elements[1]), true);
			assert.equal(startsLocal(parseXml('<Alloy><View dataCollection=""/></Alloy>').elements[1]), false);
			assert.equal(startsLocal(parseXml('<Alloy><View/></Alloy>').elements[1]), false);
		});

		it('should skip a singleton model or collection, whose id Alloy ignores', () => {
			assert.equal(resolve('<Alloy><Model id="a" src="book"/></Alloy>', 'Model'), undefined);
			assert.equal(resolve('<Alloy><Collection id="a" src="book"/></Alloy>', 'Collection'), undefined);
		});
	});

	describe('the Alloy types', () => {

		it('should resolve a model or collection instance to its Alloy type', () => {
			// an instance is assigned straight onto `$`, not into `$.__views`, but it is a member
			// of `$` either way and the declaration describes `$`
			assert.deepEqual(resolve('<Alloy><Model id="a" src="book" instance="true"/></Alloy>', 'Model'), [ 'Alloy.Model' ]);
			assert.deepEqual(resolve('<Alloy><Collection id="a" src="book" instance="true"/></Alloy>', 'Collection'), [ 'Alloy.Collection' ]);
		});

		it('should resolve a Require to a controller', () => {
			assert.deepEqual(resolve('<Alloy><Window><Require id="a" src="row"/></Window></Alloy>', 'Require'), [ 'Alloy.Controller' ]);
		});

		it('should resolve a Widget to a controller', () => {
			assert.deepEqual(resolve('<Alloy><Window><Widget id="a" src="com.x.w"/></Window></Alloy>', 'Widget'), [ 'Alloy.Controller' ]);
		});

		it('should resolve a widget that is the whole view to its top level view', () => {
			// Alloy.Require.js calls getViewEx on a widget that is the only node under <Alloy>,
			// so what lands on `$` is the view rather than the controller
			assert.deepEqual(resolve('<Alloy><Widget id="a" src="com.x.w"/></Alloy>', 'Widget'), [ 'Titanium.UI.View' ]);
		});

		it('should keep a widget beside a sibling as a controller', () => {
			assert.deepEqual(resolve('<Alloy><Widget id="a" src="com.x.w"/><Label/></Alloy>', 'Widget'), [ 'Alloy.Controller' ]);
		});
	});
});

import type { XmlElement } from './xml.ts';

/**
 * What a view element contributes to `$`.
 *
 * Alloy emits `$.__views["myId"] = Ti.UI.createLabel(…)` for every element that reaches `$`, and
 * the controller template then runs `_.extend($, $.__views)`. So the type of `$` is a pure
 * function of the `(id, tag)` pairs in the view. Nothing here reproduces the compiler; it answers
 * the one question the compiler answers on the way past.
 *
 * The rule is Alloy's own, from `getNodeFullname` in `commands/compile/compilerUtils.js`:
 *
 * ```js
 * var name = node.nodeName,
 *     ns = node.getAttribute('ns') || CONST.IMPLICIT_NAMESPACES[name] || CONST.NAMESPACE_DEFAULT,
 *     fullname = ns + '.' + name;
 * ```
 *
 * `alloy.tags[tag].apiName` from titanium-editor-commons is not that rule and is not a substitute
 * for it. That map answers "which tags exist", which is what completion needs; it resolves `View`
 * to `Ti.Map.View`, so it cannot answer "what type is this tag". Two questions over one
 * vocabulary, and neither answer works for the other.
 *
 * Two things are transcribed rather than derived, the way `parseSelector` transcribes Alloy's
 * selector regular expression: the namespace table, and the set of tags whose parser rewrites the
 * node before the name is resolved. Both are checked against Alloy's own generated controllers —
 * it ships 869 of them as test fixtures — rather than against fixtures written by hand.
 *
 * Not every element with an id reaches `$`. The proxy property parsers assign their child's symbol
 * to the parent and never emit one of their own, so `<ContentView id="x">` names nothing;
 * `_ItemArray` does the same for the plural forms. Alloy's own output is the evidence:
 * `$.__views.popover.contentView = $.__views.popView` with no `$.__views.x` anywhere. Emitting a
 * member for those would offer the user something that is `undefined` at run time.
 */

/** `CONST.NAMESPACE_DEFAULT` */
const NAMESPACE_DEFAULT = 'Ti.UI';

/**
 * `CONST.IMPLICIT_NAMESPACES` from `Alloy/common/constants.js`, transcribed.
 *
 * `ContentView` is the one entry that is not a constant there:
 *
 * ```js
 * ContentView: isTitanium && Ti.Platform.osname === 'android' ?
 *     'Ti.UI.Android.CollapseToolbar' : 'Ti.UI.iPad.Popover',
 * ```
 *
 * It is a proxy property either way, so it never reaches `$` and the branch never decides
 * anything here. It is written as the value the expression takes outside a Titanium runtime, which
 * is where this runs, so that the table stays a transcription.
 */
const IMPLICIT_NAMESPACES: Record<string, string> = {
	// Alloy
	Collection: 'Alloy',
	Model: 'Alloy',
	Module: 'Alloy',
	Require: 'Alloy',
	Widget: 'Alloy',

	// Alloy.Abstract
	ButtonNames: 'Alloy.Abstract',
	ButtonName: 'Alloy.Abstract',
	BarItemTypes: 'Alloy.Abstract',
	BarItemType: 'Alloy.Abstract',
	CoverFlowImageTypes: 'Alloy.Abstract',
	CoverFlowImageType: 'Alloy.Abstract',
	FlexSpace: 'Alloy.Abstract',
	FixedSpace: 'Alloy.Abstract',
	Images: 'Alloy.Abstract',
	Item: 'Alloy.Abstract',
	Items: 'Alloy.Abstract',
	ItemTemplate: 'Alloy.Abstract',
	Labels: 'Alloy.Abstract',
	Option: 'Alloy.Abstract',
	Options: 'Alloy.Abstract',
	Templates: 'Alloy.Abstract',
	Preview: 'Alloy.Abstract',
	Actions: 'Alloy.Abstract',

	// Ti.Android
	Menu: 'Ti.Android',
	MenuItem: 'Ti.Android',
	ActionBar: 'Ti.Android',

	// Ti.UI.Android
	CardView: 'Ti.UI.Android',

	// Ti.Map
	Annotation: 'Ti.Map',

	// Ti.Media
	VideoPlayer: 'Ti.Media',
	MusicPlayer: 'Ti.Media',
	AudioPlayer: 'Ti.Media',

	// Ti.UI.iOS
	AdView: 'Ti.UI.iOS',
	BlurView: 'Ti.UI.iOS',
	CoverFlowView: 'Ti.UI.iOS',
	DocumentViewer: 'Ti.UI.iOS',
	LivePhotoView: 'Ti.UI.iOS',
	SplitWindow: 'Ti.UI.iOS',
	PreviewContext: 'Ti.UI.iOS',
	PreviewAction: 'Ti.UI.iOS',
	PreviewActionGroup: 'Ti.UI.iOS',
	MenuPopup: 'Ti.UI.iOS',
	Stepper: 'Ti.UI.iOS',

	// Ti.UI.iPad
	Popover: 'Ti.UI.iPad',

	// Ti.UI.iPhone
	NavigationGroup: 'Ti.UI.iPhone',
	StatusBar: 'Ti.UI.iPhone',

	// Ti.UI.Window
	LeftNavButton: 'Ti.UI.Window',
	RightNavButton: 'Ti.UI.Window',
	LeftNavButtons: 'Ti.UI.Window',
	RightNavButtons: 'Ti.UI.Window',
	TitleControl: 'Ti.UI.Window',
	WindowToolbar: 'Ti.UI.Window',

	ContentView: 'Ti.UI.iPad.Popover',

	CollapseToolbar: 'Ti.UI.Android',

	DrawerLayout: 'Ti.UI.Android',
	LeftView: 'Ti.UI.Android.DrawerLayout',
	CenterView: 'Ti.UI.Android.DrawerLayout',
	RightView: 'Ti.UI.Android.DrawerLayout',

	// Table and List proxy properties
	FooterView: '_ProxyProperty._Lists',
	HeaderView: '_ProxyProperty._Lists',
	HeaderPullView: '_ProxyProperty._Lists',
	PullView: '_ProxyProperty._Lists',
	Search: '_ProxyProperty._Lists',
	SearchView: '_ProxyProperty._Lists',

	// misc proxy properties
	RightButton: '_ProxyProperty',
	LeftButton: '_ProxyProperty',
	KeyboardToolbar: '_ProxyProperty',
	ActionView: '_ProxyProperty'
};

/**
 * The tags whose parser routes into `_ProxyProperty`, which assigns the child's symbol to the
 * parent and emits none of its own. Their ids name nothing on `$`.
 *
 * `LeftNavButton` and `RightNavButton` are here and still reach `$` in one shape — see
 * `rewriteFor`, which is the case `Alloy.Abstract._ProxyProperty.js` handles by rewriting the node
 * to a `Button` when it has no children.
 */
const PROXY_PROPERTIES = new Set([
	'ContentView',
	'LeftNavButton', 'RightNavButton', 'TitleControl',
	'LeftView', 'CenterView', 'RightView',
	'FooterView', 'HeaderView', 'HeaderPullView', 'PullView', 'Search', 'SearchView',
	'RightButton', 'LeftButton', 'KeyboardToolbar', 'ActionView'
]);

/**
 * The tags whose parser routes into `_ItemArray`, which pushes its children into an array property
 * of the parent and, like a proxy property, emits no symbol of its own
 */
const ITEM_ARRAYS = new Set([ 'LeftNavButtons', 'RightNavButtons', 'WindowToolbar' ]);

/**
 * The Android containers whose parser drives its children and emits no symbol of its own.
 *
 * `Ti.Android.Menu.js` adds each `<MenuItem>` to the event's menu inside an `onCreateOptionsMenu`
 * handler, and `Ti.Android.ActionBar.js` writes properties onto the parent window's activity. Both
 * return `parent: {}` and never assign `args.symbol`, so their own id names nothing.
 */
const ANDROID_CONTAINERS = new Set([ 'Menu', 'ActionBar' ]);

/** The namespace whose tags are abstract: markup Alloy reads, with no Titanium proxy behind it */
const ABSTRACT_NAMESPACE = 'Alloy.Abstract';

/** `CONST.BIND_COLLECTION` — the attribute that makes an element repeat over a collection */
const BIND_COLLECTION = 'dataCollection';

/** How many times a name may be rewritten before the chain is treated as cyclic. One is the most any tag needs */
const REWRITE_LIMIT = 4;

/** What `<Model>` and `<Collection>` resolve to, which is not a view and not in `$.__views` */
const MODEL_ELEMENTS: Record<string, string> = {
	'Alloy.Model': 'Alloy.Model',
	'Alloy.Collection': 'Alloy.Collection'
};

/**
 * What Alloy's own parsers rewrite a node to before its name is resolved.
 *
 * Four parsers reassign `node.nodeName`, and the rewrite happens after the fullname has chosen the
 * parser and before the name is resolved again — so the order here is Alloy's order.
 *
 * @param fullname - The name the node resolved to before any rewrite
 * @param element - The element, since two of the rewrites read its attributes and children
 * @returns {string|undefined} The tag to resolve instead, if there is one
 */
function rewriteFor (fullname: string, element: XmlElement): string|undefined {
	// Ti.UI.AndroidView.js — "AndroidView is simply an instance of Ti.UI.View"
	if (fullname === 'Ti.UI.AndroidView') {
		return 'View';
	}

	// Alloy.Module.js — the node becomes a View in both of its branches; what ti.map changes is
	// which parser reads the children, not what the node itself is. Alloy's own output for
	// `<Module module="ti.map">` is `(require("ti.map").createView || Ti.UI.createView)(…)`
	if (fullname === 'Alloy.Module') {
		return 'View';
	}

	// Alloy.Widget.js — a Require with type="widget"
	if (fullname === 'Alloy.Widget') {
		return 'Require';
	}

	// Alloy.Abstract._ProxyProperty.js — a nav button with no children is created as a Button
	// rather than read from one, and is the only proxy property that lands on `$`
	if ((fullname === 'Ti.UI.Window.LeftNavButton' || fullname === 'Ti.UI.Window.RightNavButton') && !element.children.length) {
		return 'Button';
	}
}

/**
 * What an element's surroundings say about it. Three of Alloy's rules read more than the element.
 */
export interface TagContext {
	/** The element's parent, or nothing at the document root */
	parent?: XmlElement;
	/**
	 * Whether an ancestor makes this element a local variable rather than a member of `$`.
	 *
	 * Alloy generates a `var __alloyId0` instead of a `$.__views[…]` for anything inside an
	 * `<ItemTemplate>` — which is data describing a row, not a view — and for anything under an
	 * element bound to a collection, which is generated once per model rather than once. In both
	 * cases the id in the markup names nothing the controller can reach. `startsLocal` says which
	 * elements begin such a region.
	 */
	local?: boolean;
}

/**
 * Whether an element makes its descendants local, so nothing inside it reaches `$`.
 *
 * A walk passes the answer down as `TagContext.local`; it does not stop descending, because the
 * region ends nowhere else and every element inside it has to be asked about.
 *
 * @param element - The element being descended into
 * @returns {boolean} Whether its descendants are local
 */
export function startsLocal (element: XmlElement): boolean {
	// abstract markup is a container Alloy reads rather than an element it creates: an
	// `<ItemTemplate>` becomes a plain object describing a row, and `<Images>`, `<Labels>` and
	// `<Options>` are turned into an array property of the element around them. Either way what is
	// inside is data, and the ids in it name nothing on `$`
	if (element.tag && IMPLICIT_NAMESPACES[element.tag] === ABSTRACT_NAMESPACE) {
		return true;
	}

	// a collection bound element repeats its children once per model, so no single one of them
	// can be a member — Alloy generates each with `local: true`, and that propagates down
	return element.attributes.some(attribute => attribute.name === BIND_COLLECTION && Boolean(attribute.value));
}

/**
 * The types an element contributes to `$`, or nothing when it contributes none.
 *
 * A list rather than one name because Alloy's own answer is not always single valued. Callers join
 * it as a union; today every case resolves to one.
 *
 * @param element - The element, which must come from a parsed view
 * @param context - What its surroundings say about it
 * @returns {string[]|undefined} The type names, or nothing when the element names nothing on `$`
 */
export function resolveTag (element: XmlElement, context: TagContext = {}): string[]|undefined {
	const { parent, local } = context;
	const tag = element.tag;

	if (local) {
		return;
	}

	// a bare `<` the user has not named yet, and the document root, which is markup around the
	// view rather than an element in it
	if (!tag || tag === 'Alloy') {
		return;
	}

	// a rewrite can rewrite into another rewrite — Alloy.Widget becomes a Require, whose own
	// parser then runs — so this settles before anything is classified, the way Alloy's parser
	// chain does
	const { fullname, rewritten } = settle(renameInParent(tag, parent), element);

	// a rewritten node is no longer the tag that was written, so the rules that read the tag —
	// proxy properties, item arrays — no longer apply to it
	if (!rewritten && (PROXY_PROPERTIES.has(tag) || ITEM_ARRAYS.has(tag) || ANDROID_CONTAINERS.has(tag))) {
		return;
	}

	// abstract markup has no proxy behind it, so there is no type to name
	if (namespaceFrom(fullname) === ABSTRACT_NAMESPACE) {
		return;
	}

	const model = MODEL_ELEMENTS[fullname];
	if (model) {
		// a singleton is reached through Alloy.Models rather than through `$`, and Alloy warns that
		// it is ignoring the id
		return attribute(element, 'instance') === 'true' ? [ model ] : undefined;
	}

	if (fullname === 'Alloy.Require') {
		// a widget — and only a widget — that is the only element under <Alloy> is unwrapped with
		// getViewEx, so what reaches `$` is its top level view rather than the controller around
		// it. A <Require> in the same position stays a controller
		return [ isWidget(element) && isWholeView(element, parent) ? 'Titanium.UI.View' : 'Alloy.Controller' ];
	}

	// Ti.UI.ListItem.js emits a style object rather than a proxy — `$.__views.x = { properties: … }`
	// — so the type is the dictionary a list is given, not the item a list hands back
	if (fullname === 'Ti.UI.ListItem') {
		return [ 'Titanium.UI.ListDataItem' ];
	}

	return [ typeNameOf(fullname) ];
}

/**
 * The rename a parent imposes on a child before the child's own name is resolved.
 *
 * `Ti.UI.Picker.js` reassigns `child.nodeName` for its own children, so the shorthand `<Row>` and
 * `<Column>` are picker rows and columns rather than the table view types of the same name.
 *
 * @param tag - The tag as written
 * @param parent - The element it sits in
 * @returns {string} The tag to resolve
 */
function renameInParent (tag: string, parent?: XmlElement): string {
	if (parent?.tag !== 'Picker') {
		return tag;
	}

	return { Column: 'PickerColumn', Row: 'PickerRow' }[tag] ?? tag;
}

/**
 * Whether a Require came from a widget, which is the only kind Alloy unwraps
 *
 * @param element - The element, after any rewrite
 * @returns {boolean} Whether it is a widget
 */
function isWidget (element: XmlElement): boolean {
	return element.tag === 'Widget' || attribute(element, 'type') === 'widget';
}

/**
 * Applies the parser rewrites until none of them fires, and answers the name that came out.
 *
 * A chain, because a rewrite can rewrite again: `Alloy.Widget` becomes a `Require`, whose own
 * parser then runs. Bounded rather than looping on a condition alone — the chain is two steps at
 * its longest and cannot cycle today, and a table edit that made one cyclic should not hang a
 * language server.
 *
 * @param tag - The tag as written
 * @param element - The element, which the rewrites read
 * @returns The name Alloy would resolve, and whether anything rewrote to get there
 */
function settle (tag: string, element: XmlElement): { fullname: string; rewritten: boolean } {
	let fullname = fullnameOf(tag, element);
	let rewritten = false;

	for (let pass = 0; pass < REWRITE_LIMIT; pass++) {
		const rewrite = rewriteFor(fullname, element);
		if (!rewrite) {
			break;
		}
		fullname = fullnameOf(rewrite, element);
		rewritten = true;
	}

	return { fullname, rewritten };
}

/**
 * Whether a widget is the only element in the view, which is when Alloy unwraps it.
 *
 * `isOnlyNodeInView` in `Alloy.Require.js`: the parent must be `<Alloy>` and there must be no
 * sibling elements.
 *
 * @param element - The widget element
 * @param parent - Its parent
 * @returns {boolean} Whether Alloy would unwrap it
 */
function isWholeView (element: XmlElement, parent?: XmlElement): boolean {
	return parent?.tag === 'Alloy' && parent.children.length === 1 && parent.children[0] === element;
}

/**
 * The namespace for a tag, by Alloy's rule
 *
 * @param tag - The tag name
 * @param element - The element, for its `ns` attribute
 * @returns {string} The namespace
 */
function namespaceOf (tag: string, element: XmlElement): string {
	const namespace = attribute(element, 'ns') || IMPLICIT_NAMESPACES[tag] || NAMESPACE_DEFAULT;

	// getParserArgs normalises the namespace this way before using it
	return namespace.replace(/^Titanium\./, 'Ti.');
}

/**
 * The namespace part of a fullname, which is everything before its last segment
 *
 * @param fullname - A resolved fullname
 * @returns {string} Its namespace
 */
function namespaceFrom (fullname: string): string {
	return fullname.slice(0, fullname.lastIndexOf('.'));
}

/**
 * The fullname for a tag, by Alloy's rule
 *
 * @param tag - The tag name
 * @param element - The element, for its `ns` attribute
 * @returns {string} The fullname
 */
function fullnameOf (tag: string, element: XmlElement): string {
	return `${namespaceOf(tag, element)}.${tag}`;
}

/**
 * A fullname as a name that can be written in a type position.
 *
 * `Ti` is declared as a value — `declare const Ti: typeof Titanium` — so it names no type, and a
 * declaration written against it would not compile.
 *
 * @param fullname - The name Alloy resolved
 * @returns {string} The type name
 */
function typeNameOf (fullname: string): string {
	return fullname.replace(/^Ti\./, 'Titanium.');
}

/**
 * An attribute's value
 *
 * @param element - The element
 * @param name - The attribute wanted
 * @returns {string|undefined} Its value, if it has one
 */
function attribute (element: XmlElement, name: string): string|undefined {
	return element.attributes.find(candidate => candidate.name === name)?.value;
}

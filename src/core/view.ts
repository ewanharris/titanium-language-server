import path from 'node:path';
import { imagePathsFor } from './assets.ts';
import { readAlloyConfig } from './config.ts';
import { readTranslations, translationKeys } from './i18n.ts';
import { Project, namesUnder } from './project.ts';
import { applicableStyles } from './related.ts';
import { ReferenceIndex } from './references.ts';
import { alloyTags, effectiveTag, titaniumTypeOf } from './tags.ts';
import type { TagContext } from './tags.ts';
import { parseXml, nodeAt } from './xml.ts';
import type { XmlAttribute, XmlDocument, XmlElement, XmlRange } from './xml.ts';
import type { ApiMember } from './typescript/host.ts';
import type { SourceCache, SourceFile } from './references.ts';

/**
 * What can be written at a position in an Alloy view.
 *
 * Every answer comes from the parsed document rather than from the characters before the cursor.
 * That is the whole point: the position a completion is asked from is nearly always inside a
 * document that does not parse cleanly — a half-typed tag, an unterminated attribute value — and a
 * regular expression walking backwards from the cursor cannot tell `<Label ` from `<Label>` or see
 * which attributes are already written. `nodeAt` answers where the cursor is, and this decides what
 * belongs there.
 *
 * The data behind it comes from two places that answer different questions. The project's own
 * `@types/titanium` says what a type's properties and events are, through `ApiSource`. Alloy's own
 * rules — which tags exist outside the default namespace, which attributes are Alloy's rather than
 * a type's — are transcribed here and in `core/tags.ts`, the way `parseSelector` transcribes
 * Alloy's selector regular expression.
 */

/**
 * What the project's types can be asked.
 *
 * An interface rather than `ProjectService` itself so that composing a completion can be tested
 * without a parsed program. `ProjectService` satisfies it as it stands.
 */
export interface ApiSource {
	titaniumTags (): string[];
	membersOf (type: string): ApiMember[];
	eventsOf (type: string): string[];
}

/**
 * One thing that could be written, in core's own terms.
 *
 * The kind is TypeScript's vocabulary because `server/convert.ts` already maps that to the
 * protocol's icons, degrading to a kind the client declared it understands.
 */
export interface ViewCompletion {
	label: string;
	kind: string;
	detail?: string;
	documentation?: string;
	/**
	 * Both insert forms, or neither.
	 *
	 * Never one: a client with no snippet engine given `color="$1"$0` inserts those characters
	 * literally into the user's view. `server/convert.ts` picks the form the client can use.
	 */
	insert?: { snippet: string; plain: string };
	/** What to replace, when leaving the client to work it out would go wrong */
	range?: XmlRange;
}

/**
 * Alloy's `RESERVED_ATTRIBUTES`, transcribed from `commands/compile/compilerUtils.js`.
 *
 * The constants are written out rather than referenced: `CONST.BIND_COLLECTION` is `dataCollection`,
 * `CONST.BIND_WHERE` is `dataFilter` and `CONST.AUTOSTYLE_PROPERTY` is `autoStyle`.
 */
const RESERVED_ATTRIBUTES = [ 'platform', 'formFactor', 'if', 'dataCollection', 'dataFilter', 'autoStyle', 'ns', 'method', 'module' ];

/**
 * What `RESERVED_ATTRIBUTES_REQ_INC` adds for `CONST.CONTROLLER_NODES` — `<Require>` and `<Widget>`.
 *
 * Alloy swaps the whole list for those two tags, so these are the difference rather than a second
 * list.
 */
const CONTROLLER_ATTRIBUTES = [ 'src', 'type' ];

/** `CONST.CONTROLLER_NODES`, as the tags a view writes rather than as the names they resolve to */
const CONTROLLER_TAGS = new Set([ 'Require', 'Widget' ]);

/**
 * `CONST.BIND_PROPERTIES`.
 *
 * All four, where `RESERVED_ATTRIBUTES` carries only the two Alloy checks by name. They are the
 * attributes of a collection binding and a view writes any of them.
 */
const BIND_PROPERTIES = [ 'dataCollection', 'dataFilter', 'dataTransform', 'dataFunction' ];

/**
 * The two attributes Alloy reads directly rather than through a list.
 *
 * `id` is read by `getParserArgs` and `class` drives styling through `CONST.CLASS_PROPERTY`, so
 * neither is in `RESERVED_ATTRIBUTES` and both are written on nearly every element there is.
 */
const CORE_ATTRIBUTES = [ 'id', 'class' ];

/**
 * What a view subcomponent of an `<ItemTemplate>` takes.
 *
 * `bindId` is not Alloy's — neither the ItemTemplate parser nor the ListItem one mentions it, and
 * Alloy passes it through into the template object for the runtime to read. It is
 * `ViewTemplate.bindId` in the types, whose own documentation says a `ViewTemplate` is the
 * "template that represents a view subcomponent of an `<ItemTemplate>`". So it belongs on what is
 * inside a template and on nothing else.
 *
 * The rest of that interface is not offered with it: `childTemplates`, `events`, `properties` and
 * `type` are all things Alloy synthesises from the markup — the children, the `on` attributes, the
 * other attributes and the tag — rather than things a view writes.
 */
const TEMPLATE_ATTRIBUTES = [ 'bindId' ];

/**
 * The attribute `<ItemTemplate>` cannot be written without.
 *
 * `Alloy.Abstract.ItemTemplate.js` reads `name` and calls `dieWithNode` when it is missing, so a
 * template without one is a view Alloy refuses to compile.
 */
const ITEM_TEMPLATE_ATTRIBUTES = [ 'name' ];

/** The tag whose children are view subcomponents */
const ITEM_TEMPLATE_TAG = 'ItemTemplate';

/**
 * `CONST.PLATFORMS`, which Alloy builds from the directories under `platforms/`.
 *
 * `mobileweb` and `windows` are platforms Titanium no longer ships, and Alloy still carries their
 * directories, so its regular expression still accepts them. Transcribed as Alloy has it rather
 * than as the two platforms anyone writes — this decides what is *recognised*, and an `ios:onClick`
 * already on an element has to be recognised however dead its neighbours are.
 */
const PLATFORMS = [ 'android', 'ios', 'mobileweb', 'windows' ];

/** Alloy's `RESERVED_EVENT_REGEX`, transcribed */
const RESERVED_EVENT_REGEX = new RegExp(`^(?:(${PLATFORMS.join('|')}):)?on([A-Z].+)`);

/** A platform prefix that has been typed but not yet followed by an event name */
const TYPED_PREFIX = new RegExp(`^(${PLATFORMS.join('|')}):`);

/** What an element's surroundings say about it, beyond what resolving its type needs */
interface ElementContext extends TagContext {
	/** Whether an ancestor is an `<ItemTemplate>`, which is where `bindId` means anything */
	inItemTemplate: boolean;
}

/** What a completion in a view is worked out from */
export interface ViewCompletionContext {
	/** The project the view belongs to, for the files a value can name */
	project: Project;
	/** The view, as text rather than as a path, so an unsaved buffer answers */
	view: SourceFile;
	/** Where the cursor is */
	offset: number;
	/** What the project's types can be asked */
	api: ApiSource;
	/** Where the stylesheets, translations and configuration are read from */
	cache: SourceCache;
}

/**
 * What could be written at an offset in a view.
 *
 * Never throws, and answers nothing rather than everything when there is nothing sensible to say.
 *
 * @param context - The view, the position and everything an answer is drawn from
 * @returns {Promise<ViewCompletion[]>} What belongs there
 */
export async function viewCompletionsAt (context: ViewCompletionContext): Promise<ViewCompletion[]> {
	const { view, offset, api } = context;
	const document = parseXml(view.text);
	const at = nodeAt(document, offset);

	if (!at) {
		return [];
	}

	if (at.kind === 'tag') {
		return tagCompletions(at.element, api);
	}

	if (at.kind === 'attributeName') {
		return attributeCompletions(at.element, document, api, at.attribute?.name, at.attribute?.nameRange);
	}

	// the range is what nodeAt matched the offset against to call this an attribute value, so it
	// is established rather than re-checked — and passing it keeps that fact at the one place that
	// knows it
	if (at.kind === 'attributeValue' && at.attribute?.valueRange) {
		return valueCompletions(context, at.element, at.attribute, at.attribute.valueRange);
	}

	// element text, where a localised string is the only thing this can answer for
	return await translationsIn(context) ?? [];
}

/**
 * The tags that could be written where one is being typed
 *
 * @param element - The element whose name is being typed
 * @param api - What the project's types can be asked
 * @returns {ViewCompletion[]} The tags
 */
function tagCompletions (element: XmlElement, api: ApiSource): ViewCompletion[] {
	// the default namespace from the project's own types, and everything else from Alloy's table —
	// neither answers for the other, and `core/tags.ts` explains why at length
	const tags = [ ...new Set([ ...api.titaniumTags(), ...alloyTags() ]) ].sort();

	// the name as written, so accepting a completion replaces what is there rather than appending
	// to it. A `<` with no name yet is an empty span at the right place
	const range = { start: element.range.start + 1, end: element.range.start + 1 + (element.tag?.length ?? 0) };

	return tags.map(tag => ({ label: tag, kind: 'class', range }));
}

/**
 * The attributes that could be written on an element.
 *
 * Three sources, in one list: the properties of whatever type the element is, its events as Alloy
 * spells them, and Alloy's own attributes. What is already written is taken back out.
 *
 * @param element - The element being written
 * @param document - The parsed view, for the element's ancestors
 * @param api - What the project's types can be asked
 * @param typed - The attribute name being edited, when one is
 * @param range - Where that name sits, so accepting replaces it
 * @returns {ViewCompletion[]} The attributes
 */
function attributeCompletions (element: XmlElement, document: XmlDocument, api: ApiSource, typed?: string, range?: XmlRange): ViewCompletion[] {
	const context = contextFor(document, element);
	const type = titaniumTypeOf(element, context);
	const events = type ? api.eventsOf(type) : [];

	// a platform prefix is Alloy's event syntax and applies to nothing else, so once one has been
	// typed the events under it are the whole answer
	const prefix = typed?.match(TYPED_PREFIX)?.[1];
	if (prefix) {
		return offer(events.map(event => eventAttribute(event, prefix)), 'property', taken(element), range);
	}

	const properties = type ? api.membersOf(type).filter(member => member.kind === 'property' && !member.readonly) : [];
	const alloy = alloyAttributes(element, context.inItemTemplate);

	return [
		...offer(properties, 'property', taken(element), range),
		...offer(events.map(event => eventAttribute(event)), 'property', taken(element), range),
		...offer(alloy, 'property', taken(element), range)
	];
}

/**
 * Alloy's own attributes for an element.
 *
 * `<Require>` and `<Widget>` take a different list rather than a longer one — Alloy swaps
 * `RESERVED_ATTRIBUTES` for `RESERVED_ATTRIBUTES_REQ_INC` for exactly those two tags.
 *
 * @param element - The element
 * @returns {string[]} The attribute names
 */
function alloyAttributes (element: XmlElement, inItemTemplate: boolean): string[] {
	const reserved = element.tag && CONTROLLER_TAGS.has(element.tag)
		? [ ...RESERVED_ATTRIBUTES, ...CONTROLLER_ATTRIBUTES ]
		: RESERVED_ATTRIBUTES;

	return [ ...new Set([
		...CORE_ATTRIBUTES,
		...reserved,
		...BIND_PROPERTIES,
		// only what is inside a template is a subcomponent of one; the template itself binds to
		// nothing, and is the one tag that must carry a name
		...inItemTemplate ? TEMPLATE_ATTRIBUTES : [],
		...element.tag === ITEM_TEMPLATE_TAG ? ITEM_TEMPLATE_ATTRIBUTES : []
	]) ];
}

/**
 * An event as Alloy spells it on an element: `on` and the capitalised name, under a platform
 * prefix when there is one
 *
 * @param event - The event name, as the types have it
 * @param prefix - The platform prefix, when one has been typed
 * @returns {string} The attribute name
 */
function eventAttribute (event: string, prefix?: string): string {
	const name = `on${event.charAt(0).toUpperCase()}${event.slice(1)}`;

	return prefix ? `${prefix}:${name}` : name;
}

/**
 * The attribute names already on an element, in the spelling a completion would offer.
 *
 * A platform prefix is taken off, so an element carrying `ios:onClick` counts `onClick` as written
 * — offering it again is offering a second click handler.
 *
 * @param element - The element
 * @returns {Set<string>} What is already there
 */
function taken (element: XmlElement): Set<string> {
	const names = element.attributes.flatMap(attribute => {
		const event = RESERVED_EVENT_REGEX.exec(attribute.name);

		// both spellings, so `ios:onClick` rules out `onClick` and `ios:onClick` alike
		return event ? [ attribute.name, `on${event[2]}` ] : [ attribute.name ];
	});

	return new Set(names);
}

/**
 * Turns names into completions, leaving out what is already written.
 *
 * The attribute being edited is not "already written" — the cursor is in it, and a user half way
 * through `col` is asking for `color` rather than being told they have it.
 *
 * @param names - The attribute names, or the members they came from
 * @param kind - What to call them
 * @param already - What is already on the element
 * @param range - Where the name being edited sits
 * @returns {ViewCompletion[]} The completions
 */
function offer (names: (string|ApiMember)[], kind: string, already: Set<string>, range?: XmlRange): ViewCompletion[] {
	const completions: ViewCompletion[] = [];

	for (const entry of names) {
		const name = typeof entry === 'string' ? entry : entry.name;

		// what is under the cursor is being written rather than written: the span it occupies is
		// what a completion replaces, so it is never a duplicate of itself
		if (already.has(name) && !range) {
			continue;
		}

		const completion: ViewCompletion = {
			label: name,
			kind,
			insert: { snippet: `${name}="$1"$0`, plain: `${name}="` }
		};

		if (typeof entry !== 'string' && entry.documentation) {
			completion.documentation = entry.documentation;
		}
		if (range) {
			completion.range = range;
		}

		completions.push(completion);
	}

	return completions;
}

/**
 * What an element's surroundings say about it.
 *
 * The ancestors decide the type: a `<Row>` inside a `<Picker>` is a `PickerRow`, and a parent that
 * was itself renamed renames by the name it ended up with. So the chain is folded from the root
 * down rather than read off the tag the view writes, which is what `generateViewDeclaration` does
 * for the same reason.
 *
 * @param document - The parsed view
 * @param target - The element to describe
 * @returns {ElementContext} Its context, empty for an element at the root
 */
function contextFor (document: XmlDocument, target: XmlElement): ElementContext {
	let found: ElementContext = { inItemTemplate: false };

	const visit = (element: XmlElement, parent: XmlElement|undefined, parentTag: string|undefined, inItemTemplate: boolean): void => {
		if (element === target) {
			found = { parent, parentTag, inItemTemplate };
			return;
		}

		const tag = effectiveTag(element, { parent, parentTag });
		for (const child of element.children) {
			// any depth, not just a direct child: a <Label> inside a <View> inside a template is
			// still a subcomponent of that template
			visit(child, element, tag, inItemTemplate || element.tag === ITEM_TEMPLATE_TAG);
		}
	};

	for (const root of document.roots) {
		visit(root, undefined, undefined, false);
	}

	return found;
}

/**
 * What could be written inside an attribute's value.
 *
 * Two shapes of answer, and the difference is what gets replaced. Most are the whole value — an
 * `id`, a widget's `src` — and a few are written inside an expression the value holds, where only
 * the part being typed is replaced. `L('logi` wants `login`, not a value of `login`.
 *
 * @param context - The view, the project and the readers
 * @param element - The element the attribute is on
 * @param attribute - The attribute being written
 * @param range - Where its value sits, which nodeAt has already established
 * @returns {Promise<ViewCompletion[]>} What belongs there
 */
async function valueCompletions (context: ViewCompletionContext, element: XmlElement, attribute: XmlAttribute, range: XmlRange): Promise<ViewCompletion[]> {
	// an expression inside the value wins over the value itself: `text="L('` is a translation key
	// being written, not a value for `text`. Nothing rather than an empty list is what says the
	// cursor is not in one — a project with no translations at all still means `L('` here
	const translations = await translationsIn(context);
	if (translations) {
		return translations;
	}

	const config = await configKeysIn(context, attribute, range);
	if (config) {
		return config;
	}

	const { project } = context;

	if (attribute.name === 'id' || attribute.name === 'class') {
		return styleNames(context, attribute.name, range);
	}

	// <Require src=""> names a controller and <Widget src=""> names a widget: the same attribute
	// over two different vocabularies, which is why the tag decides rather than the name
	if (attribute.name === 'src' && element.tag === 'Require') {
		return named(namesUnder(path.join(project.filePath, 'app', 'controllers'), await project.controllers()), 'script', range);
	}
	if (attribute.name === 'src' && element.tag === 'Widget') {
		return named(await project.widgets(), 'script', range);
	}

	// <Model src=""> and <Collection src=""> name a model, which is a third vocabulary over the
	// same attribute — without the tag deciding, they would be offered the widgets
	if (attribute.name === 'src' && (element.tag === 'Model' || element.tag === 'Collection')) {
		return named(namesUnder(path.join(project.filePath, 'app', 'models'), await project.models()), 'script', range);
	}

	if (attribute.name === 'module') {
		return named(await moduleNames(project), 'module', range);
	}

	// an image is decided by the property it is written into, the same rule assets.ts applies to a
	// string literal in a controller. `false` because an XML attribute carries no type that could
	// rule the property out
	return named(await imagePathsFor(project, attribute.name, false), 'script', range);
}

/**
 * The `Alloy.CFG` keys being written inside a value, when that is what is being written.
 *
 * The one place this file reads characters rather than a parse, and it is bounded to the value the
 * parser already handed over. `Alloy.CFG.` is Alloy's own syntax inside an attribute and no XML
 * parser sees inside it — which is a different thing from matching backwards across the document
 * from the cursor, the practice this file exists to replace.
 *
 * @param context - The view, the project and the readers
 * @param attribute - The attribute being written
 * @param range - Where its value sits
 * @returns {Promise<ViewCompletion[]|undefined>} The keys, or nothing when this is not one
 */
async function configKeysIn (context: ViewCompletionContext, attribute: XmlAttribute, range: XmlRange): Promise<ViewCompletion[]|undefined> {
	const typed = context.offset - range.start;
	const written = /Alloy\.CFG\.([A-Za-z0-9_$]*)$/.exec((attribute.value ?? '').slice(0, typed));

	if (!written) {
		return undefined;
	}

	const read = await readAlloyConfig(context.project, context.cache);

	return named(Object.keys(read?.values ?? {}).sort(), 'property', { start: range.start + typed - written[1].length, end: range.start + typed });
}

/**
 * The translation keys being written, when a localised string is what is being written.
 *
 * Answers for both places one appears — inside an attribute value and in an element's text — by
 * asking the same question of the document rather than of either context, which is why the text
 * position needs nothing of its own. The previous implementation could only see the attribute.
 *
 * Every locale, because `L()` falls back to the default language and the file being edited may be
 * the one that does not have the key yet, which is when offering it is most useful.
 *
 * @param context - The view, the project and the readers
 * @returns {Promise<ViewCompletion[]|undefined>} The keys, or nothing when this is not one
 */
async function translationsIn (context: ViewCompletionContext): Promise<ViewCompletion[]|undefined> {
	const written = /L\(\s*['"]([^'"]*)$/.exec(context.view.text.slice(0, context.offset));
	if (!written) {
		return undefined;
	}

	const keys = translationKeys(await readTranslations(context.project, context.cache));

	return named(keys, 'string', { start: context.offset - written[1].length, end: context.offset });
}

/**
 * The ids or classes the stylesheets that apply to this view define.
 *
 * Only the stylesheets Alloy would actually apply: the paired one, and `app.tss` for a view in the
 * app rather than in a widget. Offering a class from an unrelated screen would be offering one
 * that styles nothing here.
 *
 * @param context - The view, the project and the readers
 * @param kind - Whether ids or classes are wanted
 * @param range - What to replace
 * @returns {Promise<ViewCompletion[]>} The names
 */
async function styleNames (context: ViewCompletionContext, kind: 'id'|'class', range: XmlRange): Promise<ViewCompletion[]> {
	const styles = await applicableStyles(context.project, context.view.path, context.cache);
	const index = new ReferenceIndex({ views: [], styles });

	const names = [ ...new Set(index.definitions.filter(definition => definition.kind === kind).map(definition => definition.name)) ].sort();

	return named(names, kind === 'id' ? 'property' : 'class', range);
}

/**
 * The modules an element's `module` attribute can name.
 *
 * Both kinds, because Alloy resolves either: a CommonJS file under `app/lib`, and a native module
 * the project has installed.
 *
 * @param project - The project to read
 * @returns {Promise<string[]>} The names, sorted and distinct
 */
async function moduleNames (project: Project): Promise<string[]> {
	const [ lib, installed ] = await Promise.all([ project.libFiles(), project.locallyInstalledModules() ]);
	const names = [
		...namesUnder(path.join(project.filePath, 'app', 'lib'), lib),
		...installed.map(module => module.name)
	];

	return [ ...new Set(names) ].sort();
}

/**
 * Turns names into completions over an explicit span.
 *
 * The span is never left to the client. A path is full of slashes and dots, and a client working
 * out what to replace from its own idea of a word turns accepting `/images/lo` into
 * `/images//images/logo.png` — which is the bug #42 hit in a controller and the same one waiting
 * in an attribute.
 *
 * @param names - What to offer
 * @param kind - What to call them
 * @param range - What to replace
 * @returns {ViewCompletion[]} The completions
 */
function named (names: string[], kind: string, range: XmlRange): ViewCompletion[] {
	return names.map(name => ({ label: name, kind, range }));
}

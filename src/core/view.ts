import { alloyTags, effectiveTag, titaniumTypeOf } from './tags.ts';
import type { TagContext } from './tags.ts';
import { parseXml, nodeAt } from './xml.ts';
import type { XmlDocument, XmlElement, XmlRange } from './xml.ts';
import type { ApiMember } from './typescript/host.ts';
import type { SourceFile } from './references.ts';

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
 * `bindId`, which the ListItem and ItemTemplate parsers read.
 *
 * Offered on every element rather than only inside an `<ItemTemplate>`, which is where it means
 * anything. Narrowing it needs the same ancestor walk the type resolution does and is worth doing
 * when something asks for it.
 */
const TEMPLATE_ATTRIBUTES = [ 'bindId' ];

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

/**
 * What could be written at an offset in a view.
 *
 * Never throws, and answers nothing rather than everything when there is nothing sensible to say.
 *
 * @param view - The view, as text rather than as a path, so an unsaved buffer answers
 * @param offset - Where the cursor is
 * @param api - What the project's types can be asked
 * @returns {ViewCompletion[]} What belongs there
 */
export function viewCompletionsAt (view: SourceFile, offset: number, api: ApiSource): ViewCompletion[] {
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

	return [];
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
	const type = titaniumTypeOf(element, contextFor(document, element));
	const events = type ? api.eventsOf(type) : [];

	// a platform prefix is Alloy's event syntax and applies to nothing else, so once one has been
	// typed the events under it are the whole answer
	const prefix = typed?.match(TYPED_PREFIX)?.[1];
	if (prefix) {
		return offer(events.map(event => eventAttribute(event, prefix)), 'property', taken(element), range);
	}

	const properties = type ? api.membersOf(type).filter(member => member.kind === 'property') : [];
	const alloy = alloyAttributes(element);

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
function alloyAttributes (element: XmlElement): string[] {
	const reserved = element.tag && CONTROLLER_TAGS.has(element.tag)
		? [ ...RESERVED_ATTRIBUTES, ...CONTROLLER_ATTRIBUTES ]
		: RESERVED_ATTRIBUTES;

	return [ ...new Set([ ...CORE_ATTRIBUTES, ...reserved, ...BIND_PROPERTIES, ...TEMPLATE_ATTRIBUTES ]) ];
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
 * @returns {TagContext} Its context, empty for an element at the root
 */
function contextFor (document: XmlDocument, target: XmlElement): TagContext {
	let found: TagContext = {};

	const visit = (element: XmlElement, parent: XmlElement|undefined, parentTag: string|undefined): void => {
		if (element === target) {
			found = { parent, parentTag };
			return;
		}

		const tag = effectiveTag(element, { parent, parentTag });
		for (const child of element.children) {
			visit(child, element, tag);
		}
	};

	for (const root of document.roots) {
		visit(root, undefined, undefined);
	}

	return found;
}

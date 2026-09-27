import { imagePathsFor, isImageProperty } from './assets.ts';
import { readAlloyConfig } from './config.ts';
import { constantsFor } from './constants.ts';
import { Project } from './project.ts';
import { ReferenceIndex } from './references.ts';
import type { SourceCache, SourceFile } from './references.ts';
import { viewsStyledBy } from './related.ts';
import { alloyTags, titaniumTypeOf } from './tags.ts';
import { nodeAt, parseSelector, parseTss } from './tss.ts';
import type { TssProperty, TssRange, TssRule } from './tss.ts';
import type { ApiMember } from './typescript/host.ts';
import { contextFor, named, translationsIn } from './view.ts';
import type { ApiSource, ViewCompletion } from './view.ts';
import { parseXml } from './xml.ts';

/**
 * What can be written at a position in an Alloy stylesheet.
 *
 * The same shape as `core/view.ts`, the other half of the triad: the parse says where the cursor
 * is, and this decides what belongs there. Nothing is read from the characters before the cursor
 * except inside an expression the parser hands over whole, which is where `L('` and `Alloy.CFG.`
 * are written.
 *
 * What a rule can set depends on what it styles, and that is the question this answers carefully.
 * A tag names its type outright. A class or an id names elements, so what it can set is what the
 * elements carrying it can set — read from the views the stylesheet applies to, and from nowhere
 * else, because a class of the same name in an unrelated screen styles nothing here. A class
 * nothing carries yet can set nothing, and is offered nothing rather than a guess.
 */

/** What a completion in a stylesheet is worked out from */
export interface StyleCompletionContext {
	/** The project the stylesheet belongs to */
	project: Project;
	/** The stylesheet, as text rather than as a path, so an unsaved buffer answers */
	style: SourceFile;
	/** Where the cursor is */
	offset: number;
	/** What the project's types can be asked */
	api: ApiSource;
	/** Where the views, translations and configuration are read from */
	cache: SourceCache;
}

/**
 * What could be written at an offset in a stylesheet.
 *
 * Never throws, and answers nothing rather than everything when there is nothing sensible to say.
 *
 * @param context - The stylesheet, the position and everything an answer is drawn from
 * @returns {Promise<ViewCompletion[]>} What belongs there
 */
export async function styleCompletionsAt (context: StyleCompletionContext): Promise<ViewCompletion[]> {
	if (await context.project.type() !== 'alloy') {
		return [];
	}

	const at = nodeAt(parseTss(context.style.text), context.offset);
	if (!at) {
		return [];
	}

	if (at.kind === 'selector') {
		return selectorCompletions(context, at.rule);
	}

	const types = await typesStyledBy(context, at.rule);

	if (at.kind === 'body') {
		return propertyNames(context.api, types, [], at.rule.properties);
	}

	const property = at.property as TssProperty;

	if (at.kind === 'propertyName') {
		return propertyNames(context.api, types, at.path, propertiesAt(at.rule, at.path), property);
	}

	// the whitespace inside a nested object is where its own properties go
	if (property.value?.kind === 'object') {
		return propertyNames(context.api, types, [ ...at.path, property.name ], property.value.properties);
	}

	return valueCompletions(context, property, at.path, types);
}

/**
 * The selectors that could be written: the tags a stylesheet can style, and the classes and ids
 * of the views it applies to
 *
 * @param context - The stylesheet and its readers
 * @param rule - The rule whose selector is being written
 * @returns {Promise<ViewCompletion[]>} The selectors
 */
async function selectorCompletions (context: StyleCompletionContext, rule: TssRule): Promise<ViewCompletion[]> {
	// only a tag that creates a Titanium type can be styled: Alloy's own markup has no proxy for
	// a style to be applied to
	const tags = [ ...new Set([ ...context.api.titaniumTags(), ...alloyTags() ]) ]
		.filter(tag => typeOfTag(tag) !== undefined)
		.sort();

	const index = new ReferenceIndex({ views: await viewsStyledBy(context.project, context.style.path, context.cache), styles: [] });
	const distinct = (kind: 'class'|'id'): string[] =>
		[ ...new Set(index.usages.filter(usage => usage.kind === kind).map(usage => usage.name)) ].sort();

	const range = selectorNameRange(context.style.text, rule);

	return [
		...named(tags, 'class', range),
		...named(distinct('class').map(name => `.${name}`), 'class', range),
		...named(distinct('id').map(name => `#${name}`), 'property', range)
	];
}

/**
 * Where a selector's name sits: inside its quotes, and before any `[...]` qualifier, which is what
 * accepting a completion replaces
 *
 * @param text - The stylesheet
 * @param rule - The rule
 * @returns {TssRange} The span of the name
 */
function selectorNameRange (text: string, rule: TssRule): TssRange {
	const quoted = text[rule.selector.range.start] === '"' || text[rule.selector.range.start] === '\'';
	const start = rule.selector.range.start + (quoted ? 1 : 0);
	const qualifier = rule.selector.text.indexOf('[');

	return { start, end: start + (qualifier < 0 ? rule.selector.text.length : qualifier) };
}

/**
 * The Titanium types a rule styles.
 *
 * A tag is its own type. A class or an id is every element in the views the stylesheet applies to
 * that carries it, each typed the way `core/view.ts` types an element — with its ancestors, so a
 * `<Row>` inside a `<Picker>` is a PickerRow.
 *
 * @param context - The stylesheet and its readers
 * @param rule - The rule
 * @returns {Promise<string[]>} The type names, in the order the elements were found, each once
 */
async function typesStyledBy (context: StyleCompletionContext, rule: TssRule): Promise<string[]> {
	const selector = parseSelector(rule.selector.text);
	if (!selector) {
		return [];
	}

	if (selector.kind === 'tag') {
		const type = typeOfTag(selector.name);
		return type ? [ type ] : [];
	}

	const types = new Set<string>();

	for (const view of await viewsStyledBy(context.project, context.style.path, context.cache)) {
		const document = parseXml(view.text);

		for (const element of document.elements) {
			const carries = element.attributes.some(attribute => selector.kind === 'id'
				? attribute.name === 'id' && attribute.value === selector.name
				: attribute.name === 'class' && (attribute.value ?? '').split(/\s+/).includes(selector.name));

			const type = carries ? titaniumTypeOf(element, contextFor(document, element)) : undefined;
			if (type) {
				types.add(type);
			}
		}
	}

	return [ ...types ];
}

/**
 * The type a tag creates when written on its own
 *
 * @param tag - The tag
 * @returns {string|undefined} The type, or nothing for markup that creates none
 */
function typeOfTag (tag: string): string|undefined {
	return titaniumTypeOf(parseXml(`<Alloy><${tag}/></Alloy>`).elements[1]);
}

/**
 * The properties a rule can set, across every type it styles.
 *
 * Each carries its own type as its detail, and also names the types that have it when the rule
 * styles more than one, because a class on a Label and an ImageView can set `image`, and only the
 * ImageView will take it.
 *
 * @param api - What the project's types can be asked
 * @param types - The types the rule styles
 * @param path - The properties being written inside, outermost first
 * @param siblings - What is already written beside the one being typed
 * @param typing - The property whose name is being typed, when one is
 * @returns {ViewCompletion[]} The property names
 */
function propertyNames (api: ApiSource, types: string[], path: string[], siblings: TssProperty[], typing?: TssProperty): ViewCompletion[] {
	const already = new Set(siblings.filter(sibling => sibling !== typing).map(sibling => sibling.name));
	const found = new Map<string, { member: ApiMember; types: string[] }>();

	for (const type of types) {
		for (const member of api.membersOf(type, path)) {
			// a method is something a controller calls, and a readonly property is one the
			// platform reports: neither is something a style can set
			if (member.kind !== 'property' || member.readonly || already.has(member.name)) {
				continue;
			}

			const entry = found.get(member.name) ?? { member, types: [] };
			entry.types.push(shortName(type));
			found.set(member.name, entry);
		}
	}

	return [ ...found.values() ].map(({ member, types: having }) => {
		const completion: ViewCompletion = {
			label: member.name,
			kind: 'property',
			// the property's type, as TypeScript's own completions show it — and, only when the rule
			// styles more than one type, which of them take it
			detail: types.length > 1 ? `${member.type} — ${having.join(', ')}` : member.type,
			insert: { snippet: `${member.name}: $0`, plain: `${member.name}: ` }
		};
		if (member.documentation) {
			completion.documentation = member.documentation;
		}
		if (typing) {
			completion.range = typing.nameRange;
		}
		return completion;
	});
}

/**
 * The properties written at a path through a rule — the rule's own for an empty path, and a
 * nested object's otherwise
 *
 * @param rule - The rule
 * @param path - The properties to follow, outermost first
 * @returns {TssProperty[]} What is written there
 */
function propertiesAt (rule: TssRule, path: string[]): TssProperty[] {
	let properties = rule.properties;

	for (const name of path) {
		// the one holding an object, since that is what a path leads into — an earlier duplicate
		// holding something else is not where the cursor is
		const value = properties.find(property => property.name === name && property.value?.kind === 'object')?.value;
		// defensive, and unreachable from nodeAt: a path is only ever the objects it descended into
		if (value?.kind !== 'object') {
			return [];
		}
		properties = value.properties;
	}

	return properties;
}

/**
 * What could be written as a property's value.
 *
 * Four sources, none of them the types, which carry no literal values at all: a translation key
 * inside `L()`, a configuration key after `Alloy.CFG.`, an image path in a string, and the
 * constants Titanium's apidoc says the property takes.
 *
 * @param context - The stylesheet and its readers
 * @param property - The property whose value is being written
 * @param path - The properties it sits inside
 * @param types - The types the rule styles
 * @returns {Promise<ViewCompletion[]>} The values
 */
async function valueCompletions (context: StyleCompletionContext, property: TssProperty, path: string[], types: string[]): Promise<ViewCompletion[]> {
	const { project, cache, offset, style } = context;

	const translations = await translationsIn({ project, view: style, offset, api: context.api, cache });
	if (translations) {
		return translations;
	}

	const valueStart = property.value?.range.start ?? property.valueStart ?? offset;
	const config = /Alloy\.CFG\.([A-Za-z0-9_$]*)$/.exec(style.text.slice(valueStart, offset));
	if (config) {
		const read = await readAlloyConfig(project, cache);
		return named(Object.keys(read?.values ?? {}).sort(), 'property', { start: offset - config[1].length, end: offset });
	}

	const value = property.value;

	// inside quotes a constant would be text, and the only thing a string names is a path
	if (value?.kind === 'string') {
		if (!isImageProperty(property.name, false)) {
			return [];
		}
		const contents = { start: value.range.start + 1, end: value.range.end - (value.terminated ? 1 : 0) };
		return named(await imagePathsFor(project, property.name, false), 'script', contents);
	}

	// a nested property takes no constants of its own that the table knows of
	if (path.length || (value && value.kind !== 'expression')) {
		return [];
	}

	const documentation = new Map<string, string>();
	const available = (namespace: string): string[] => context.api.constantsOf(namespace).map(constant => {
		documentation.set(`${namespace.replace(/^Titanium\b/, 'Ti')}.${constant.name}`, constant.documentation);
		return constant.name;
	});

	const range = value ? value.range : { start: offset, end: offset };

	return constantsFor(property.name, types, available).map(name => {
		const completion: ViewCompletion = { label: name, kind: 'const', range };
		if (documentation.get(name)) {
			completion.documentation = documentation.get(name);
		}
		return completion;
	});
}

/**
 * A type's last name, which is how the detail names it
 *
 * @param type - A fully qualified type
 * @returns {string} Its last segment
 */
function shortName (type: string): string {
	return type.slice(type.lastIndexOf('.') + 1);
}

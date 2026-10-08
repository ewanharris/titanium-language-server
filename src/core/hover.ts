import path from 'node:path';
import { isImageProperty } from './assets.ts';
import { resolveStyle, sortRules, styledElements, styles as selects, valueOf } from './cascade.ts';
import type { PropertySource, StyledElement } from './cascade.ts';
import { inLanguageOrder, localisedCallAt, readTranslations, translationKeyAt } from './i18n.ts';
import { previewImage } from './images.ts';
import type { ImagePreview } from './images.ts';
import { Project } from './project.ts';
import type { SourceCache, SourceFile } from './references.ts';
import { stylesheetsFor, viewsStyledBy } from './related.ts';
import { typeOfTag, typesStyledBy } from './style.ts';
import type { StyleCompletionContext } from './style.ts';
import { titaniumTypeOf } from './tags.ts';
import { nodeAt as tssNodeAt, parseSelector, parseTss, selectorPartAt, sourceRange } from './tss.ts';
import type { Selector, TssProperty, TssRange, TssRule, TssSelectorPart } from './tss.ts';
import { contextFor, RESERVED_EVENT_REGEX } from './view.ts';
import type { ViewCompletionContext } from './view.ts';
import { nodeAt, parseXml } from './xml.ts';
import type { XmlAttribute, XmlDocument, XmlElement, XmlRange } from './xml.ts';

/**
 * What hover shows in a view.
 *
 * Structured rather than rendered, because how it renders is the client's business: the same
 * answer is markdown with an embedded image for a client that declared markdown, and plain words
 * for one that did not. `server/convert.ts` makes that call.
 */
export interface ViewHover {
	/** What the cursor is on, which the client highlights */
	range: XmlRange;
	/** A one-line description in code form — a type, a property's signature */
	signature?: string;
	documentation?: string;
	/** The image a value names */
	image?: ImagePreview;
	/** A translation key's text in each locale that has it, present and possibly empty for a key */
	translations?: { locale: string; value: string }[];
	/** What an element ends up styled with, property by property, when anything styles it */
	styles?: HoverStyle[];
}

/** One property an element ends up with, and where it comes from */
export interface HoverStyle {
	/** Dotted when it is inside an object: `font.fontSize` */
	name: string;
	/** As it is written, absent when only a condition sets it */
	value?: string;
	/** The rule's selector, absent when the element's own attribute sets it */
	selector?: string;
	/** The stylesheet the rule is in, relative to `app/` */
	file?: string;
	/** Rules that take precedence where their condition holds */
	conditional: { selector: string; file: string; value: string }[];
}

/** Hover in a stylesheet is asked what completion there is, and which language to list first */
export type StyleHoverContext = StyleCompletionContext & Languages;

/** How many elements a selector's hover lists before it summarises the rest */
const LISTED_ELEMENTS = 10;

/**
 * Hover is asked what completion is — the view, where, and what to answer from — and which
 * language to list first
 */
export type ViewHoverContext = ViewCompletionContext & Languages;

/** What hover needs to know of the user's settings */
interface Languages {
	/** The locale a translation is listed first in, as `project.defaultI18nLanguage` sets it */
	defaultLanguage?: string;
}

/**
 * Alloy's own markup, which has no Titanium type to describe it.
 *
 * Written from Alloy's guides rather than read from anywhere, because nothing ships these as data:
 * `docs/api.jsca` covers the runtime and not the markup, and issue #38 records what reading Alloy's
 * JSDoc would take.
 */
const ALLOY_TAGS = new Map(Object.entries({
	Alloy: 'The root of every view. What it contains is what the controller creates.',
	Require: 'Includes another view and its controller here. `src` names the controller, relative to `app/controllers`; `type="widget"` makes it name a widget instead.',
	Widget: 'Includes a widget from `app/widgets`. `src` names the widget, and `name` picks which of its controllers — `widget` by default.',
	Model: 'Declares a model from `app/models` on `Alloy.Models`, or on the controller alone with `instance="true"`.',
	Collection: 'Declares a collection of a model from `app/models` on `Alloy.Collections`, or on the controller alone with `instance="true"`.'
}));

/**
 * Alloy's own attributes, which it reads rather than passing to Titanium.
 *
 * Maps rather than object literals, here and above: an attribute is whatever the user typed, and a
 * plain object answers `constructor` and `toString` from its prototype.
 */
const ALLOY_ATTRIBUTES = new Map(Object.entries({
	id: 'Names the element. It is `$.<id>` in the controller, and `#<id>` styles it.',
	class: 'Style classes, separated by spaces. `.<class>` in a stylesheet styles every element that has it.',
	platform: 'Includes the element only on the listed platforms, comma separated — `ios`, `android`. `!` before one excludes it instead.',
	formFactor: 'Includes the element only on a `handheld` or a `tablet`.',
	if: 'Includes the element only when the condition it names is true as the controller runs, such as `Alloy.Globals.isTablet`.',
	ns: 'The namespace the element is created from, in place of the one Alloy would pick.',
	method: 'The factory the element is created with, in place of `create` and the tag name.',
	module: 'Creates the element from a module — a CommonJS file under `app/lib`, or a native module — rather than from Titanium.',
	dataCollection: 'Binds the element\'s children to a collection, repeating them once per model.',
	dataFilter: 'A controller function that is given the collection and returns the models to show.',
	dataTransform: 'A controller function that is given a model and returns the values to bind, for anything that needs formatting first.',
	dataFunction: 'Names a function Alloy creates on the controller, which refreshes the binding when called.',
	autoStyle: 'Whether adding or removing a class at run time restyles the element.',
	bindId: 'Names this part of the item template, so a list item\'s data can set its properties under that name.'
}));

/** Attributes whose meaning depends on the tag they are written on */
const ALLOY_ATTRIBUTES_ON = new Map(Object.entries({
	Require: {
		src: 'The controller to include, relative to `app/controllers` — or to the widget\'s own inside a widget.',
		type: '`view` by default. `widget` makes `src` name a widget.'
	},
	Widget: {
		src: 'The widget to include, by its directory under `app/widgets`.',
		name: 'Which of the widget\'s controllers to include. `widget` by default.'
	},
	Model: { src: 'The model, by its file under `app/models`.' },
	Collection: { src: 'The model the collection holds, by its file under `app/models`.' },
	ItemTemplate: { name: 'The template\'s name, which a list item selects with `template`.' }
}).map(([ tag, attributes ]) => [ tag, new Map(Object.entries(attributes)) ]));

/**
 * What to show for whatever the cursor is on in a view.
 *
 * Never throws, and answers nothing rather than an empty tooltip where there is nothing to say.
 *
 * @param context - The view, the position and everything an answer is drawn from
 * @returns {Promise<ViewHover|undefined>} What to show
 */
export async function viewHoverAt (context: ViewHoverContext): Promise<ViewHover|undefined> {
	const { project, view, offset, cache } = context;
	if (await project.type() !== 'alloy') {
		return;
	}

	const document = parseXml(view.text);

	// first, because `L('` inside a value is a key whatever the attribute it is written into
	const key = translationKeyAt(document, view.text, offset);
	if (key) {
		const translations = inLanguageOrder((await readTranslations(project, cache))
			.filter(translation => translation.key === key.key)
			.map(translation => ({ locale: translation.locale, value: translation.value })), context.defaultLanguage);

		return translations.length
			? { range: key.range, translations }
			: { range: key.range, translations, documentation: `No locale declares \`${key.key}\`.` };
	}

	const at = nodeAt(document, offset);

	if (at?.kind === 'tag') {
		const found = tagHover(context, document, at.element);
		if (!found) {
			return;
		}

		const styles = await stylesOf(project, view, at.element, cache);
		return styles.length ? { ...found, styles } : found;
	}

	if (at?.kind === 'attributeName' && at.attribute) {
		return attributeHover(context, document, at.element, at.attribute);
	}

	if (at?.kind === 'attributeValue' && at.attribute?.value && at.attribute.valueRange && isImageProperty(at.attribute.name, false)) {
		const image = await previewImage(project, at.attribute.value);

		return image
			? { range: at.attribute.valueRange, image }
			: { range: at.attribute.valueRange, documentation: `No image at \`${at.attribute.value}\` in this project.` };
	}
}

/**
 * The type an element creates, or what Alloy's own markup is for
 *
 * @param context - What the types can be asked
 * @param document - The parsed view, for the element's ancestors
 * @param element - The element
 * @returns {ViewHover|undefined} What to show
 */
function tagHover (context: ViewHoverContext, document: XmlDocument, element: XmlElement): ViewHover|undefined {
	const tag = element.tag;
	if (!tag) {
		return;
	}

	const range = { start: element.range.start + 1, end: element.range.start + 1 + tag.length };
	const type = titaniumTypeOf(element, contextFor(document, element));

	if (type) {
		const documentation = context.api.documentationOf(type);

		// a name the types do not have resolves to a type all the same, and saying only its name
		// would claim a type that does not exist
		if (!documentation && !context.api.membersOf(type).length) {
			return;
		}

		return { range, signature: type, documentation };
	}

	const alloy = ALLOY_TAGS.get(tag);
	return alloy ? { range, signature: `<${tag}>`, documentation: alloy } : undefined;
}

/**
 * What an attribute is: Alloy's, an event, or a property of the element's type.
 *
 * Alloy's first, because it reads its own attributes before anything reaches Titanium — an `id`
 * never becomes the proxy's `id` property whatever the types say.
 *
 * @param context - What the types can be asked
 * @param document - The parsed view, for the element's ancestors
 * @param element - The element the attribute is on
 * @param attribute - The attribute
 * @returns {ViewHover|undefined} What to show
 */
function attributeHover (context: ViewHoverContext, document: XmlDocument, element: XmlElement, attribute: XmlAttribute): ViewHover|undefined {
	const range = attribute.nameRange;
	const { name } = attribute;

	const alloy = ALLOY_ATTRIBUTES_ON.get(element.tag ?? '')?.get(name) ?? ALLOY_ATTRIBUTES.get(name);
	if (alloy) {
		return { range, signature: `(Alloy) ${name}`, documentation: alloy };
	}

	const type = titaniumTypeOf(element, contextFor(document, element));
	if (!type) {
		return;
	}

	const event = RESERVED_EVENT_REGEX.exec(name);
	if (event) {
		// Alloy lowers the first letter of what follows `on`, which is how onClick reaches `click`
		const eventName = `${event[2].charAt(0).toLowerCase()}${event[2].slice(1)}`;
		const found = context.api.membersOf(`${type}EventMap`).find(member => member.name === eventName);
		if (!found) {
			return;
		}

		const platform = event[1] ? `Only on ${event[1]}.` : '';
		return {
			range,
			signature: `(event) ${type} ${eventName}: ${found.type}`,
			documentation: [ found.documentation, platform ].filter(Boolean).join('\n\n')
		};
	}

	const property = context.api.membersOf(type).find(member => member.name === name && member.kind === 'property');
	if (!property) {
		return;
	}

	return {
		range,
		signature: `(property) ${property.readonly ? 'readonly ' : ''}${type}.${name}: ${property.type}`,
		documentation: property.documentation
	};
}

/**
 * What an element in a view ends up styled with, from the stylesheets Alloy applies to the view
 *
 * @param project - The project
 * @param view - The view
 * @param element - The element
 * @param cache - Where the stylesheets are read from
 * @returns {Promise<HoverStyle[]>} Each property, in the order it was first set
 */
async function stylesOf (project: Project, view: SourceFile, element: XmlElement, cache: SourceCache): Promise<HoverStyle[]> {
	const styled = styledElements(view).find(candidate => candidate.element.range.start === element.range.start);
	if (!styled) {
		return [];
	}

	const rules = sortRules(await stylesheetsFor(project, view.path, cache));

	return resolveStyle(rules, styled).map(property => {
		const style: HoverStyle = {
			name: property.name,
			conditional: property.conditional.map(source => ({ selector: source.rule.part.text, file: inApp(project, source.rule.file), value: valueOf(source) }))
		};
		if (property.value !== undefined) {
			style.value = property.value;
		}
		if (property.applied) {
			style.selector = property.applied.rule.part.text;
			style.file = inApp(project, property.applied.rule.file);
		}
		return style;
	});
}

/**
 * What to show for whatever the cursor is on in a stylesheet.
 *
 * Never throws, and answers nothing rather than an empty tooltip where there is nothing to say.
 *
 * @param context - The stylesheet, the position and everything an answer is drawn from
 * @returns {Promise<ViewHover|undefined>} What to show
 */
export async function styleHoverAt (context: StyleHoverContext): Promise<ViewHover|undefined> {
	const { project, style, offset, cache } = context;
	if (await project.type() !== 'alloy') {
		return;
	}

	const at = tssNodeAt(parseTss(style.text), offset);
	if (!at) {
		return;
	}

	if (at.kind === 'selector') {
		// the part of a comma separated key under the cursor, which is a selector of its own
		const part = selectorPartAt(at.rule, offset);
		const selector = part && parseSelector(part.text);
		return selector && selectorHover(context, selector, selectorName(at.rule, part, selector));
	}

	const property = at.property;
	if (at.kind === 'propertyName' && property) {
		return propertyHover(context, await typesStyledBy(context, at.rule), at.path, property, selectorsOf(at.rule));
	}

	// first, because `L('` is a key whatever property it is written into
	const key = localisedCallAt(style.text, offset);
	if (key) {
		const translations = inLanguageOrder((await readTranslations(project, cache))
			.filter(translation => translation.key === key.key)
			.map(translation => ({ locale: translation.locale, value: translation.value })), context.defaultLanguage);

		return translations.length
			? { range: key.range, translations }
			: { range: key.range, translations, documentation: `No locale declares \`${key.key}\`.` };
	}

	const value = property?.value;

	if (value?.kind === 'string' && property && isImageProperty(property.name, false)) {
		const range = { start: value.range.start + 1, end: value.range.end - (value.terminated ? 1 : 0) };
		const image = await previewImage(project, value.value);

		return image
			? { range, image }
			: { range, documentation: `No image at \`${value.value}\` in this project.` };
	}

	if (value?.kind === 'expression') {
		return constantHover(context, value.text, value.range);
	}
}

/**
 * The types a selector styles and the elements it styles them on
 *
 * @param context - The stylesheet and its readers
 * @param selector - The selector
 * @param range - Where its name is written
 * @returns {Promise<ViewHover|undefined>} What to show
 */
async function selectorHover (context: StyleHoverContext, selector: Selector, range: TssRange): Promise<ViewHover|undefined> {
	const { project, style, cache, api } = context;

	const elements: { view: SourceFile; element: StyledElement }[] = [];
	for (const view of await viewsStyledBy(project, style.path, cache)) {
		for (const element of styledElements(view).filter(candidate => selects(selector, candidate))) {
			elements.push({ view, element });
		}
	}

	const types = selector.kind === 'tag'
		? [ typeOfTag(selector.name) ].filter(type => type !== undefined)
		: [ ...new Set(elements.map(({ element }) => element.type)) ];

	const listed = elements.slice(0, LISTED_ELEMENTS).map(({ view, element }) => `- ${describe(element)} in ${inApp(project, view.path)}`);
	if (elements.length > LISTED_ELEMENTS) {
		listed.push(`- and ${elements.length - LISTED_ELEMENTS} more`);
	}

	if (!types.length) {
		// a tag that names no type is not something to describe; a class or an id nothing carries is
		const kind = selector.kind === 'id' ? 'id' : 'class';
		return selector.kind === 'tag'
			? undefined
			: { range, documentation: `Nothing in the views this stylesheet applies to has the ${kind} \`${selector.name}\`.` };
	}

	// a tag whose name the types do not have resolves to a type all the same, as in a view
	if (selector.kind === 'tag' && !api.documentationOf(types[0]) && !api.membersOf(types[0]).length) {
		return;
	}

	const documentation = [
		selector.kind === 'tag' ? api.documentationOf(types[0]) : '',
		listed.length ? `Styles:\n${listed.join('\n')}` : ''
	].filter(Boolean).join('\n\n');

	return { range, signature: types.join(' | '), documentation };
}

/**
 * A property's type and documentation, and where the cascade takes it away from an element
 *
 * @param context - The stylesheet and its readers
 * @param types - The types the rule styles
 * @param propertyPath - The properties it sits inside
 * @param property - The property
 * @param selectors - The selectors the rule's key names, one per part Alloy would accept
 * @returns {Promise<ViewHover|undefined>} What to show
 */
async function propertyHover (context: StyleHoverContext, types: string[], propertyPath: string[], property: TssProperty, selectors: Selector[]): Promise<ViewHover|undefined> {
	const having = types.flatMap(type => {
		const member = context.api.membersOf(type, propertyPath).find(candidate => candidate.name === property.name && candidate.kind === 'property');
		return member ? [ { type, member } ] : [];
	});
	if (!having.length) {
		return;
	}

	const [ { type, member } ] = having;
	const dotted = [ ...propertyPath, property.name ].join('.');
	const signature = types.length > 1
		? `(property) ${property.name}: ${member.type} — ${having.map(found => found.type.slice(found.type.lastIndexOf('.') + 1)).join(', ')}`
		: `(property) ${type}.${dotted}: ${member.type}`;

	const cascade = await cascadeNotes(context, selectors, dotted, property);
	const documentation = [ member.documentation, ...cascade ].filter(Boolean).join('\n\n');

	return { range: property.nameRange, signature, documentation };
}

/**
 * Where a property in a rule does not reach an element the rule styles, because something of
 * higher priority sets it — outright, or where a condition holds
 *
 * @param context - The stylesheet and its readers
 * @param selectors - The selectors the rule's key names
 * @param dotted - The property, by its path through any objects
 * @param property - The property as written, which is how its own source is recognised
 * @returns {Promise<string[]>} One note per element and rule
 */
async function cascadeNotes (context: StyleHoverContext, selectors: Selector[], dotted: string, property: TssProperty): Promise<string[]> {
	const { project, style, cache } = context;
	const notes: string[] = [];
	const isThis = (source: PropertySource|undefined): boolean =>
		source?.rule.file === style.path && source.property.nameRange.start === property.nameRange.start;

	const views = await viewsStyledBy(project, style.path, cache);
	let loaded = false;

	for (const view of views) {
		// the stylesheet being hovered is the buffer, which may not have reached the cache
		const loads = await stylesheetsFor(project, view.path, cache);
		if (!loads.some(sheet => sheet.path === style.path)) {
			// a theme config.json does not select: comparing without it would say who overrides a
			// rule that is simply not applied
			continue;
		}
		loaded = true;

		const sheets = loads.map(sheet => sheet.path === style.path ? { ...sheet, text: style.text } : sheet);
		const rules = sortRules(sheets);

		for (const element of styledElements(view).filter(candidate => selectors.some(selector => selects(selector, candidate)))) {
			const resolved = resolveStyle(rules, element).find(candidate => candidate.name === dotted);
			if (!resolved) {
				continue;
			}

			if (resolved.attribute) {
				notes.push(`Overridden on ${describe(element)} by its own \`${dotted}\` attribute.`);
			} else if (resolved.applied && !isThis(resolved.applied)) {
				notes.push(`Overridden on ${describe(element)} by \`${resolved.applied.rule.part.text}\` in ${inApp(project, resolved.applied.rule.file)}.`);
			} else if (isThis(resolved.applied)) {
				for (const source of resolved.conditional) {
					notes.push(`\`${source.rule.part.text}\` in ${inApp(project, source.rule.file)} overrides it on ${describe(element)} where its condition holds.`);
				}
			}
		}
	}

	if (views.length && !loaded) {
		return [ 'No build loads this stylesheet: `config.json` selects no theme it belongs to, so nothing here reaches an element.' ];
	}

	return notes;
}

/**
 * A constant a value names, as `Ti.UI.SIZE` or `Titanium.UI.SIZE`
 *
 * @param context - What the types can be asked
 * @param text - The value
 * @param range - Where it is written
 * @returns {ViewHover|undefined} What to show
 */
function constantHover (context: StyleHoverContext, text: string, range: TssRange): ViewHover|undefined {
	const match = /^(?:Ti|Titanium)((?:\.[A-Za-z_$][\w$]*)*)\.([A-Za-z_$][\w$]*)$/.exec(text.trim());
	if (!match) {
		return;
	}

	const namespace = `Titanium${match[1]}`;
	const constant = context.api.constantsOf(namespace).find(candidate => candidate.name === match[2]);

	return constant && { range, signature: `(constant) ${namespace}.${constant.name}`, documentation: constant.documentation };
}

/**
 * Where a selector's name is written: after its `#` or `.`, and before any `[...]`
 *
 * @param rule - The rule, whose key says where each character is written
 * @param part - The part of the key the selector is
 * @param selector - The parsed selector
 * @returns {TssRange} The name, as written
 */
function selectorName (rule: TssRule, part: TssSelectorPart, selector: Selector): TssRange {
	const start = part.index + (selector.kind === 'tag' ? 0 : 1);
	return sourceRange(rule.selector, start, start + selector.name.length);
}

/**
 * Every selector a rule's key names, one per comma separated part Alloy would accept
 *
 * @param rule - The rule
 * @returns {Selector[]} The selectors
 */
function selectorsOf (rule: TssRule): Selector[] {
	return rule.selector.parts.flatMap(part => parseSelector(part.text) ?? []);
}

/**
 * An element the way a view writes it, by the attribute that best identifies it
 *
 * @param styled - The element
 * @returns {string} Such as `<Label id="title">`
 */
function describe (styled: StyledElement): string {
	const { element } = styled;
	const identifying = element.attributes.find(attribute => attribute.name === 'id' && attribute.value)
		?? element.attributes.find(attribute => attribute.name === 'class' && attribute.value);

	return `\`<${element.tag}${identifying ? ` ${identifying.name}="${identifying.value}"` : ''}>\``;
}

/**
 * A file's path under `app/`, which is how the project's own files are named in an answer
 *
 * @param project - The project
 * @param file - The file
 * @returns {string} Its path, with forward slashes
 */
function inApp (project: Project, file: string): string {
	return path.relative(path.join(project.filePath, 'app'), file).split(path.sep).join('/');
}

import { isImageProperty } from './assets.ts';
import { readTranslations, translationKeyAt } from './i18n.ts';
import { previewImage } from './images.ts';
import type { ImagePreview } from './images.ts';
import { titaniumTypeOf } from './tags.ts';
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
}

/** Hover is asked the same things completion is: the view, where, and what to answer from */
export type ViewHoverContext = ViewCompletionContext;

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
		const translations = (await readTranslations(project, cache))
			.filter(translation => translation.key === key.key)
			.map(translation => ({ locale: translation.locale, value: translation.value }))
			.sort((left, right) => left.locale.localeCompare(right.locale));

		return translations.length
			? { range: key.range, translations }
			: { range: key.range, translations, documentation: `No locale declares \`${key.key}\`.` };
	}

	const at = nodeAt(document, offset);

	if (at?.kind === 'tag') {
		return tagHover(context, document, at.element);
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

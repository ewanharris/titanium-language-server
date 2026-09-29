import path from 'node:path';
import type { SourceFile } from './references.ts';
import { titaniumTypeOf } from './tags.ts';
import { parseSelector, parseTss } from './tss.ts';
import type { Selector, TssProperty, TssRule, TssSelectorPart } from './tss.ts';
import { BIND_PROPERTIES, contextFor, RESERVED_ATTRIBUTES, RESERVED_EVENT_REGEX } from './view.ts';
import { parseXml } from './xml.ts';
import type { XmlElement } from './xml.ts';

/**
 * Which stylesheet rule actually sets a property on an element, as Alloy's compiler decides it.
 *
 * Lifted from `sortStyles` and `generateStyleParams` in Alloy's `commands/compile/styler.js`.
 * Priority is not document order: an id beats a class beats a tag wherever each is written, and a
 * `[...]` query adds to it. Only between two rules of the same priority does order decide, and the
 * order is the order Alloy loads them — `app.tss` before the view's own stylesheet.
 *
 * What cannot be known without a build is kept rather than guessed: a rule that holds only on a
 * platform, a form factor or an `if` is applied at run time when that holds, so it is reported as
 * something that may override rather than as the answer.
 */

/**
 * Alloy's weights, from `VALUES` in `styler.js`.
 *
 * `THEME` and the platform folder bonus are left out: this reads `app.tss` and the view's own
 * stylesheet, which are the two Alloy loads without either.
 */
const PRIORITY = {
	ID: 100000,
	CLASS: 10000,
	API: 1000,
	TSSIF: 500,
	PLATFORM: 100,
	FORMFACTOR: 10,
	SUM: 1,
	ORDER: 0.0001
};

/** One rule, placed where Alloy's sort puts it */
export interface CascadeRule {
	/** The stylesheet it is written in */
	file: string;
	/** The stylesheet's text, which the values it sets are read out of */
	text: string;
	rule: TssRule;
	/** The part of the rule's key this is, which is the whole key unless it is comma separated */
	part: TssSelectorPart;
	selector: Selector;
	/** Alloy's priority, which is what the rules are sorted by */
	priority: number;
	/** Applied only at run time, when its platform, form factor or `if` holds */
	conditional: boolean;
}

/** An element as the cascade sees it: what it creates, and what a selector can name it by */
export interface StyledElement {
	element: XmlElement;
	/** The Titanium type it creates, whose last segment is what a tag rule matches */
	type: string;
	/** Its id, or the view's name for a top level element that has none */
	id?: string;
	classes: string[];
}

/** One rule setting one property */
export interface PropertySource {
	rule: CascadeRule;
	property: TssProperty;
}

/** Where a property an element ends up with comes from */
export interface ResolvedProperty {
	/** The property, dotted when it is inside an object: `font.fontSize` */
	name: string;
	/** The rule whose value the element takes, absent when an attribute or only a condition sets it */
	applied?: PropertySource;
	/** Whether the element's own attribute sets it, which beats every rule */
	attribute: boolean;
	/** The value it takes, as it is written */
	value?: string;
	/** The rules it takes precedence over, in the order they were applied */
	overridden: PropertySource[];
	/** The rules that take precedence over it when their condition holds */
	conditional: PropertySource[];
}

/**
 * Every rule in the stylesheets given, in the order Alloy applies them.
 *
 * @param styles - The stylesheets, in the order Alloy loads them: `app.tss` first
 * @returns {CascadeRule[]} The rules, lowest priority first
 */
export function sortRules (styles: SourceFile[]): CascadeRule[] {
	const sorted: CascadeRule[] = [];
	let order = 0;

	for (const style of styles) {
		// the stylesheet is an object literal to Alloy, so a selector written twice is one key: the
		// later rule replaces the earlier outright, and takes the earlier one's place in the order
		const byKey = new Map<string, TssRule>();
		for (const rule of parseTss(style.text).rules) {
			byKey.set(rule.selector.text, rule);
		}

		// and a key names one rule per comma separated part, each weighed on its own and each
		// taking the next place in the order, as Alloy 3.1 splits them
		for (const rule of byKey.values()) {
			for (const part of rule.selector.parts) {
				const selector = parseSelector(part.text);
				if (!selector) {
					continue;
				}

				sorted.push({ file: style.path, text: style.text, rule, part, selector, ...weigh(selector, order++) });
			}
		}
	}

	// stable, as lodash's sortBy is, though the order term already makes every priority distinct
	return sorted.sort((left, right) => left.priority - right.priority);
}

/**
 * A selector's priority, and whether it is applied only under a condition
 *
 * @param selector - The selector
 * @param order - Where it came in the order the rules were read
 * @returns {{ priority: number; conditional: boolean }} What `sortStyles` and `generateStyleParams` make of it
 */
function weigh (selector: Selector, order: number): { priority: number; conditional: boolean } {
	let priority = order * PRIORITY.ORDER;
	priority += selector.kind === 'id' ? PRIORITY.ID : selector.kind === 'class' ? PRIORITY.CLASS : PRIORITY.API;

	for (const query of Object.keys(selector.queries)) {
		priority += PRIORITY.SUM + (query === 'platform' ? PRIORITY.PLATFORM : query === 'formFactor' ? PRIORITY.FORMFACTOR : query === 'if' ? PRIORITY.TSSIF : 0);
	}

	// generateStyleParams builds a run time condition from these three and merges anything else
	// outright, an unknown query included
	const { platform, formFactor } = selector.queries;
	const conditional = platform !== undefined || formFactor === 'tablet' || formFactor === 'handheld' || selector.queries.if !== undefined;

	return { priority, conditional };
}

/**
 * The elements of a view that a stylesheet can style: those that create a Titanium type.
 *
 * @param view - The view
 * @returns {StyledElement[]} Them, in document order
 */
export function styledElements (view: SourceFile): StyledElement[] {
	const document = parseXml(view.text);
	const viewName = path.basename(view.path, path.extname(view.path));
	const roots = new Set(document.roots.flatMap(root => root.tag === 'Alloy' ? root.children : []));

	return document.elements.flatMap(element => {
		const type = titaniumTypeOf(element, contextFor(document, element));
		if (!type) {
			return [];
		}

		const attribute = (name: string): string|undefined => element.attributes.find(candidate => candidate.name === name)?.value;

		return [ {
			element,
			type,
			// getParserArgs gives each direct child of <Alloy> the view's name when it has no id
			id: attribute('id') || (roots.has(element) ? viewName : undefined),
			classes: (attribute('class') ?? '').split(/\s+/).filter(Boolean)
		} ];
	});
}

/**
 * Whether a selector styles an element, whatever its condition
 *
 * @param selector - The selector
 * @param element - The element
 * @returns {boolean} Whether it does
 */
export function styles (selector: Selector, element: StyledElement): boolean {
	const { kind, name } = selector;

	// a tag rule is matched on the type the element creates rather than the tag it writes, so a
	// `<Row>` in a `<Picker>` is styled by `"PickerRow"`
	return kind === 'id' ? element.id === name
		: kind === 'class' ? element.classes.includes(name)
			: element.type.slice(element.type.lastIndexOf('.') + 1) === name;
}

/**
 * What an element ends up with, property by property, and where each comes from.
 *
 * @param rules - Every rule that could apply, as `sortRules` orders them
 * @param element - The element
 * @returns {ResolvedProperty[]} Each property something sets, in the order each was first set
 */
export function resolveStyle (rules: CascadeRule[], element: StyledElement): ResolvedProperty[] {
	const sources = new Map<string, PropertySource[]>();

	for (const rule of rules.filter(candidate => styles(candidate.selector, element))) {
		for (const [ name, property ] of leaves(rule.rule.properties, '')) {
			sources.set(name, [ ...sources.get(name) ?? [], { rule, property } ]);
		}
	}

	const attributes = new Map(element.element.attributes
		.filter(attribute => isStyleAttribute(attribute.name) && attribute.value !== undefined)
		.map(attribute => [ attribute.name, attribute.value as string ]));

	const names = [ ...sources.keys(), ...[ ...attributes.keys() ].filter(name => !sources.has(name)) ];

	return names.map(name => {
		const found = sources.get(name) ?? [];

		// the element's own attributes are merged last of all, after every conditional block
		if (attributes.has(name)) {
			return { name, attribute: true, value: attributes.get(name), overridden: found, conditional: [] };
		}

		const winner = found.findLastIndex(source => !source.rule.conditional);
		const applied = winner < 0 ? undefined : found[winner];

		return {
			name,
			applied,
			attribute: false,
			value: applied ? valueOf(applied) : undefined,
			overridden: found.slice(0, Math.max(winner, 0)),
			conditional: found.slice(winner + 1)
		};
	});
}

/**
 * The properties a rule sets, with an object's own properties in place of the object.
 *
 * Alloy merges styles with a deep extend, so a `font` from a tag rule and a `font` from an id rule
 * both reach the element: what one rule overrides is a leaf, never a whole object.
 *
 * @param properties - The properties
 * @param prefix - The path to them, dotted
 * @returns {[string, TssProperty][]} Each leaf, by its path
 */
function leaves (properties: TssProperty[], prefix: string): [ string, TssProperty ][] {
	return properties.flatMap((property): [ string, TssProperty ][] => {
		const name = `${prefix}${property.name}`;

		if (!property.value) {
			return [];
		}
		if (property.value.kind === 'object') {
			return leaves(property.value.properties, `${name}.`);
		}
		return [ [ name, property ] ];
	});
}

/**
 * Whether an attribute sets a property, rather than being something Alloy reads for itself
 *
 * @param name - The attribute
 * @returns {boolean} Whether it does
 */
function isStyleAttribute (name: string): boolean {
	// a platform prefixed attribute is applied on that platform alone, and events are listeners.
	// A bound element has all four binding attributes stripped before the rest are read, and
	// bindId names a part of an item template rather than setting anything on it
	return name !== 'id' && name !== 'class' && name !== 'bindId' && !name.includes(':')
		&& !RESERVED_ATTRIBUTES.includes(name) && !BIND_PROPERTIES.includes(name) && !RESERVED_EVENT_REGEX.test(name);
}

/**
 * A value as the stylesheet writes it
 *
 * @param source - The rule and the property
 * @returns {string} The value's text
 */
export function valueOf (source: PropertySource): string {
	const range = source.property.value?.range;
	return range ? source.rule.text.slice(range.start, range.end) : '';
}

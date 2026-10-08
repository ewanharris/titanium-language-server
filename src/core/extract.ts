import path from 'node:path';
import { appendTo, inApp, literal, quoteOf, styledAt } from './actions.ts';
import type { ActionContext, GeneratedEdit } from './actions.ts';
import { isStyleAttribute, resolveStyle, sortRules, styledElements } from './cascade.ts';
import type { CascadeRule, CascadeSource, StyledElement } from './cascade.ts';
import { ownStylesheet, stylesheetsFor } from './related.ts';
import { parseTss } from './tss.ts';
import type { SelectorKind } from './tss.ts';
import { nodeAt, parseXml, unescapeXml } from './xml.ts';
import type { XmlAttribute, XmlElement } from './xml.ts';

/**
 * Extract style: the refactorings that move an element's properties out of the view and into a
 * rule in its stylesheet — a new class, the element's id, or its tag.
 *
 * Three actions rather than one with a prompt, because the protocol has no standard way to ask for
 * text: the editor's code action menu is the choice, and the name is generated. A class is named
 * for the element's type and made unique against every stylesheet the view loads and every class
 * the view uses; an id is the element's own, or the view's name for a top level element that has
 * none — the id Alloy gives it, so adding one would change `$`; a tag is the type the element
 * creates, which is what a tag rule matches.
 *
 * Moving a property from an attribute to a rule can change what the element looks like: an
 * attribute beats every rule, and a rule only beats the rules below it. So each kind is replayed
 * through the cascade with the new rule in place, and offered only when the new rule is what every
 * moved property ends up with — on every platform, with no condition that would take it away.
 */

/** Where a selection ends as well as where it starts */
export interface ExtractContext extends ActionContext {
	/** Where the selection ends: `offset` itself for a cursor */
	end: number;
}

export interface ExtractAction {
	title: string;
	/** One edit to the view's start tag and one to the stylesheet, made together */
	edits: GeneratedEdit[];
	/** Where the new rule starts in the stylesheet once the edits are made, for a client to show */
	reveal: { path: string; offset: number };
}

/** A property's value as the stylesheet writes it, or an object of them for a dotted name */
type Tree = Map<string, string|Tree>;

/**
 * What `getParserArgs` in Alloy's `compilerUtils.js` evaluates rather than quotes: anything that
 * reaches into `Ti`, `Titanium`, `Alloy.Globals`, `Alloy.CFG` or `$.args`, a call to `L()` and one
 * to `WPATH()`
 */
const EXPRESSION = /(^|\+)\s*(?:(?:Ti|Titanium|Alloy\.Globals|Alloy\.CFG|\$\.args)\.|L\(.+\)\s*$|WPATH\()/;

/** A data binding, which is evaluated against a model and has no meaning in a stylesheet */
const BINDING = /^\s*\{[\s\S]*\}\s*$/;

/** A property name a stylesheet can write without quotes */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * The extractions offered at a position in a view.
 *
 * Anywhere in an element's start tag, for the attributes that set a property — or only those a
 * selection covers. What names the element, listens to it, limits it to a platform or binds it to a
 * model stays where it is.
 *
 * @param context - The view, the cursor or selection, and where to read from
 * @returns {Promise<ExtractAction[]>} A class, an id and a tag, each when it can be done safely
 */
export async function extractActionsAt (context: ExtractContext): Promise<ExtractAction[]> {
	const { project, file, offset, end, cache } = context;
	if (await project.type() !== 'alloy') {
		return [];
	}

	const document = parseXml(file.text);
	const at = nodeAt(document, offset);
	const element = at?.element;
	if (!at || at.kind === 'text' || !element?.tag || element.startTagEnd === undefined) {
		return [];
	}

	const styled = styledAt(file, document, element);
	if (!styled) {
		return [];
	}

	const moved = element.attributes.filter(attribute =>
		attribute.value !== undefined
		&& isStyleAttribute(attribute.name)
		&& !BINDING.test(attribute.value)
		&& (end <= offset || (attribute.range.start >= offset && attribute.range.end <= end)));

	const tree = treeOf(moved);
	if (!moved.length || !tree) {
		return [];
	}

	const sources = await stylesheetsFor(project, file.path, cache);
	const rules = sortRules(sources);
	const target = ownStylesheet(project, file.path);
	const targetText = (await cache.read(target)).text;
	const quote = quoteOf(targetText);
	const indent = indentOf(targetText);
	const type = styled.type.slice(styled.type.lastIndexOf('.') + 1);
	const base = type[0].toLowerCase() + type.slice(1);

	const named = (kind: SelectorKind): Set<string> => new Set(rules.filter(rule => rule.selector.kind === kind).map(rule => rule.selector.name));
	const viewName = path.basename(file.path, path.extname(file.path));

	const candidates: { kind: SelectorKind; name: string; attribute?: string }[] = [];

	const takenClasses = new Set([ ...named('class'), ...document.elements.flatMap(candidate => (valueOf(candidate, 'class') ?? '').split(/\s+/)) ]);
	candidates.push({ kind: 'class', name: unique(base, takenClasses), attribute: 'class' });

	const id = valueOf(element, 'id');
	const topLevel = document.roots.some(root => root.tag === 'Alloy' && root.children.includes(element));
	if (id || topLevel) {
		// an id the element has, or the one Alloy gives a top level element: either way it is
		// written already, so only the rule is new
		const name = id || viewName;
		if (!named('id').has(name)) {
			candidates.push({ kind: 'id', name });
		}
	} else {
		const takenIds = new Set([ ...named('id'), viewName, ...document.elements.map(candidate => valueOf(candidate, 'id') ?? '') ]);
		candidates.push({ kind: 'id', name: unique(base, takenIds), attribute: 'id' });
	}

	if (!named('tag').has(type)) {
		candidates.push({ kind: 'tag', name: type });
	}

	const actions: ExtractAction[] = [];
	for (const candidate of candidates) {
		const selector = candidate.kind === 'class' ? `.${candidate.name}` : candidate.kind === 'id' ? `#${candidate.name}` : candidate.name;
		const rule = `${literal(selector, quote)}: {\n${write(tree, quote, indent, 1)}\n}\n`;

		const startTag = rewriteStartTag(file.text, element, moved, candidate.attribute, candidate.name);
		const viewEdit: GeneratedEdit = { path: file.path, create: false, offset: element.range.start, end: element.startTagEnd, text: startTag };
		const styleEdit = await appendTo(target, rule, cache);

		const after = {
			view: { path: file.path, text: file.text.slice(0, element.range.start) + startTag + file.text.slice(element.startTagEnd) },
			style: targetText + styleEdit.text
		};
		if (!keepsTheLook(sources, target, after, element.range.start, moved, candidate.kind, candidate.name)) {
			continue;
		}

		actions.push({
			title: `Extract style to ${selector} in ${inApp(project, target)}`,
			edits: [ viewEdit, styleEdit ],
			reveal: { path: target, offset: styleEdit.offset + styleEdit.text.length - rule.length }
		});
	}

	return actions;
}

/**
 * The properties moved, nested as Alloy nests a dotted name with `_.set`
 *
 * @param attributes - The attributes being moved
 * @returns {Tree|undefined} Them, or nothing when a name is both a value and an object
 */
function treeOf (attributes: XmlAttribute[]): Tree|undefined {
	const tree: Tree = new Map();

	for (const attribute of attributes) {
		const segments = attribute.name.split('.');
		let level = tree;

		for (const segment of segments.slice(0, -1)) {
			const next = level.get(segment) ?? new Map();
			if (typeof next === 'string') {
				return;
			}
			level.set(segment, next);
			level = next;
		}

		const leaf = segments[segments.length - 1];
		if (level.get(leaf) instanceof Map) {
			return;
		}
		level.set(leaf, attribute.value ?? '');
	}

	return tree;
}

/**
 * A rule's body
 *
 * @param tree - The properties
 * @param quote - The quote the stylesheet writes strings in
 * @param indent - One level of its indent
 * @param depth - How deep this level is
 * @returns {string} The properties, one to a line
 */
function write (tree: Tree, quote: string, indent: string, depth: number): string {
	const pad = indent.repeat(depth);

	return [ ...tree ].map(([ name, value ]) => {
		const key = IDENTIFIER.test(name) ? name : literal(name, quote);
		return typeof value === 'string'
			? `${pad}${key}: ${valueIn(value, quote)}`
			: `${pad}${key}: {\n${write(value, quote, indent, depth + 1)}\n${pad}}`;
	}).join(',\n');
}

/**
 * An attribute's value as a stylesheet writes it: what Alloy would evaluate as an expression, a
 * boolean or a number as one, and a string for the rest
 *
 * @param raw - The value as the view writes it, XML escapes and all
 * @param quote - The quote the stylesheet writes strings in
 * @returns {string} The value's text in the rule
 */
function valueIn (raw: string, quote: string): string {
	const value = unescapeXml(raw);

	if (EXPRESSION.test(value)) {
		// Alloy quotes a key written bare in L(), which a stylesheet cannot leave to it
		return /^\s*L\([^'"]+\)\s*$/.test(value) ? value.replace(/\(/g, '("').replace(/\)/g, '")') : value;
	}
	if (value === 'true' || value === 'false') {
		return value;
	}

	const trimmed = value.trim();
	if (trimmed && (String(parseInt(value, 10)) === trimmed || String(parseFloat(value)) === trimmed)) {
		return trimmed;
	}

	return literal(value, quote);
}

/**
 * The start tag with the moved attributes taken out and the class or id the rule needs put in.
 *
 * Each attribute goes with the whitespace before it, so what is left keeps its own layout.
 *
 * @param text - The view
 * @param element - The element
 * @param moved - The attributes leaving
 * @param attribute - The attribute that names the rule, when the element needs it: `class` or `id`
 * @param name - The rule's class or id
 * @returns {string} The start tag
 */
function rewriteStartTag (text: string, element: XmlElement, moved: XmlAttribute[], attribute: string|undefined, name: string): string {
	const start = element.range.start;
	const changes: { from: number; to: number; text: string; removal: boolean }[] = moved.map(gone => {
		let from = gone.range.start;
		while (from > start && /\s/.test(text[from - 1])) {
			from--;
		}
		return { from, to: gone.range.end, text: '', removal: true };
	});

	const classes = element.attributes.find(candidate => candidate.name === 'class' && candidate.valueRange);
	if (attribute === 'class' && classes?.valueRange) {
		const at = classes.valueRange.end;
		changes.push({ from: at, to: at, text: `${classes.value?.trim() ? ' ' : ''}${name}`, removal: false });
	} else if (attribute) {
		const at = start + 1 + (element.tag ?? '').length;
		changes.push({ from: at, to: at, text: ` ${attribute}="${name}"`, removal: false });
	}

	// last first, so the earlier offsets still hold; at one offset a removal goes before an
	// insertion, or the removal would take the inserted text with it
	changes.sort((left, right) => right.from - left.from || Number(left.removal ? 0 : 1) - Number(right.removal ? 0 : 1));

	let tag = text.slice(start, element.startTagEnd);
	for (const change of changes) {
		tag = tag.slice(0, change.from - start) + change.text + tag.slice(change.to - start);
	}
	return tag;
}

/**
 * Whether the element looks the same with the properties in the new rule as it did with them as
 * attributes: the new rule sets every one of them, and nothing overrides it under any condition
 *
 * @param sources - The stylesheets the view loads, in Alloy's order
 * @param target - The stylesheet the rule goes into
 * @param after - The view and the stylesheet with the edits made
 * @param after.view - The view
 * @param after.style - The stylesheet
 * @param elementStart - Where the element starts, which the edits do not move
 * @param moved - The attributes moved
 * @param kind - The new rule's kind
 * @param name - What it names
 * @returns {boolean} Whether it does
 */
function keepsTheLook (
	sources: CascadeSource[],
	target: string,
	after: { view: { path: string; text: string }; style: string },
	elementStart: number,
	moved: XmlAttribute[],
	kind: SelectorKind,
	name: string
): boolean {
	const styles = sources.some(source => source.path === target)
		? sources.map(source => source.path === target ? { ...source, text: after.style } : source)
		: withOwn(sources, { path: target, text: after.style });

	const element: StyledElement|undefined = styledElements(after.view).find(candidate => candidate.element.range.start === elementStart);
	if (!element) {
		return false;
	}

	const resolved = new Map(resolveStyle(sortRules(styles), element).map(property => [ property.name, property ]));
	const isNew = (rule: CascadeRule): boolean => rule.file === target && rule.selector.kind === kind && rule.selector.name === name;

	return moved.every(attribute => {
		const property = resolved.get(attribute.name);
		return property?.applied && isNew(property.applied.rule) && !property.conditional.length;
	});
}

/**
 * The stylesheets with the view's own put where Alloy loads it: after the global ones, before its
 * platform folders' and its theme's copies
 *
 * @param sources - The stylesheets that exist
 * @param own - The view's own, which does not yet
 * @returns {CascadeSource[]} All of them
 */
function withOwn (sources: CascadeSource[], own: CascadeSource): CascadeSource[] {
	const globals = sources.findLastIndex(source => path.basename(source.path) === 'app.tss') + 1;
	return [ ...sources.slice(0, globals), own, ...sources.slice(globals) ];
}

/**
 * One level of a stylesheet's indent: that of its first property, or a tab
 *
 * @param text - The stylesheet
 * @returns {string} The indent
 */
function indentOf (text: string): string {
	for (const rule of parseTss(text).rules) {
		const property = rule.properties[0];
		if (property) {
			const lineStart = text.lastIndexOf('\n', property.nameRange.start - 1) + 1;
			const indent = text.slice(lineStart, property.nameRange.start);
			if (indent && !indent.trim()) {
				return indent;
			}
		}
	}
	return '\t';
}

/**
 * A name nothing has taken: the base, or the base with the first number that makes it free
 *
 * @param base - The name wanted
 * @param taken - The names in use
 * @returns {string} The name
 */
function unique (base: string, taken: Set<string>): string {
	if (!taken.has(base)) {
		return base;
	}
	let suffix = 2;
	while (taken.has(`${base}${suffix}`)) {
		suffix++;
	}
	return `${base}${suffix}`;
}

/**
 * An attribute's value
 *
 * @param element - The element
 * @param name - The attribute
 * @returns {string|undefined} Its value, when it has one
 */
function valueOf (element: XmlElement, name: string): string|undefined {
	return element.attributes.find(attribute => attribute.name === name)?.value;
}

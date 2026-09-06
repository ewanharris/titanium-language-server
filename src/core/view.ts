import htmlLanguageService from 'vscode-html-languageservice';
import { TextDocument } from 'vscode-languageserver-textdocument';

const { getLanguageService, TokenType } = htmlLanguageService;

/**
 * A parser for Alloy views, and for the other XML this project reads.
 *
 * It is built on `vscode-html-languageservice` rather than `@xmldom/xmldom`, which is what Alloy
 * itself uses. Alloy's tolerance for a half-written view is zero — ALOY-840 turns xmldom's
 * "unclosed xml attribute" warning into a fatal error — so parsing exactly as the compiler does
 * would mean answering nothing for the document a language server actually sees. xmldom does not
 * throw, but it drops everything after the malformation: on `<Alloy><Window class="` it yields
 * `Alloy` alone, which is the element the user is not editing.
 *
 * Fidelity to the compiler still holds where it can be defined. On a well formed view every
 * candidate parser agrees, and a malformed one is a document Alloy refuses to compile, so there is
 * nothing there to be faithful to.
 *
 * HTML semantics on XML costs one thing: a lowercase tag colliding with an HTML void name would
 * misparse. Alloy's tags are PascalCase, and a test covers the collision.
 */

/** A half-open span of the source text, in character offsets */
export interface ViewRange {
	start: number;
	end: number;
}

export interface ViewAttribute {
	name: string;
	/** Absent while the attribute is being typed, as in `<Window onOpen >` */
	value?: string;
	nameRange: ViewRange;
	/** The value without its quotes, so an edit replaces the value and not the delimiters */
	valueRange?: ViewRange;
	range: ViewRange;
}

export interface ViewElement {
	/** Absent for a `<` that has no name yet */
	tag?: string;
	/** Lifted out of the attributes because every cross-reference starts here */
	id?: string;
	attributes: ViewAttribute[];
	children: ViewElement[];
	/** The text directly inside the element, when it has any */
	text?: string;
	range: ViewRange;
}

export interface ViewDocument {
	roots: ViewElement[];
	/** Every element, in document order. `$.__views` is flat, so this is the shape it wants */
	elements: ViewElement[];
}

/** What sits at an offset, which is what a provider asks before deciding what to offer */
export interface ViewNodeAt {
	kind: 'tag' | 'attributeName' | 'attributeValue' | 'text';
	element: ViewElement;
	attribute?: ViewAttribute;
}

const service = getLanguageService();

/**
 * Parses a view, or any other XML this project reads.
 *
 * Never throws, and keeps the element under the cursor even when the document is mid-keystroke.
 *
 * @param text - The document contents
 * @returns {ViewDocument} The elements it found, as a tree and as a flat list
 */
export function parseView (text: string): ViewDocument {
	const parsed = service.parseHTMLDocument(TextDocument.create('untitled:view', 'html', 1, text));
	const attributes = readAttributes(text);

	const elements: ViewElement[] = [];
	const roots = parsed.roots.map(node => build(node, text, attributes, elements));

	return { roots, elements };
}

/**
 * Turns one parsed node into a ViewElement, collecting every element into the flat list as it goes
 *
 * @param node - The node from the language service
 * @param text - The document contents
 * @param attributes - Attribute ranges collected from the scanner, by start-tag offset
 * @param elements - The flat list being accumulated, in document order
 * @returns {ViewElement} The element
 */
function build (node: ParsedNode, text: string, attributes: Map<number, ViewAttribute[]>, elements: ViewElement[]): ViewElement {
	const own = attributes.get(node.start) ?? [];
	const id = own.find(attribute => attribute.name === 'id')?.value;

	const element: ViewElement = {
		tag: node.tag,
		id,
		attributes: own,
		children: [],
		text: textOf(node, text),
		range: { start: node.start, end: node.end }
	};

	elements.push(element);
	element.children = (node.children ?? []).map(child => build(child, text, attributes, elements));

	return element;
}

/**
 * The text directly inside an element, when it has some and no child elements
 *
 * @param node - The node from the language service
 * @param text - The document contents
 * @returns {string|undefined} The trimmed text, if there is any
 */
function textOf (node: ParsedNode, text: string): string|undefined {
	if (node.startTagEnd === undefined || node.endTagStart === undefined || (node.children ?? []).length) {
		return undefined;
	}
	const inner = text.slice(node.startTagEnd, node.endTagStart).trim();
	return inner.length ? inner : undefined;
}

/**
 * Collects attribute names and values with their source ranges.
 *
 * The parsed tree carries attributes as a map of strings with their quotes still on and no
 * positions, so the scanner is run once over the document and the tokens grouped by the start tag
 * they belong to.
 *
 * @param text - The document contents
 * @returns {Map<number, ViewAttribute[]>} Attributes by the offset of their element's `<`
 */
function readAttributes (text: string): Map<number, ViewAttribute[]> {
	const scanner = service.createScanner(text);
	const byElement = new Map<number, ViewAttribute[]>();

	let elementStart: number|undefined;
	let pending: ViewAttribute|undefined;

	const flush = (): void => {
		if (elementStart !== undefined && pending) {
			const list = byElement.get(elementStart) ?? [];
			list.push(pending);
			byElement.set(elementStart, list);
		}
		pending = undefined;
	};

	for (let token = scanner.scan(); token !== TokenType.EOS; token = scanner.scan()) {
		const start = scanner.getTokenOffset();
		const end = scanner.getTokenEnd();

		switch (token) {
			case TokenType.StartTagOpen:
				flush();
				elementStart = start;
				break;

			case TokenType.AttributeName:
				flush();
				pending = {
					name: scanner.getTokenText(),
					nameRange: { start, end },
					range: { start, end }
				};
				break;

			case TokenType.AttributeValue: {
				// defensive, and unreachable through the scanner: a value is only ever emitted
				// after a name and a `=`, and a bare quoted string is reported as a name instead
				if (!pending) {
					break;
				}
				const raw = scanner.getTokenText();
				const quoted = raw.length > 1 && (raw[0] === '"' || raw[0] === "'") && raw[raw.length - 1] === raw[0];
				pending.value = quoted ? raw.slice(1, -1) : raw;
				pending.valueRange = quoted ? { start: start + 1, end: end - 1 } : { start, end };
				pending.range = { start: pending.nameRange.start, end };
				flush();
				break;
			}

			case TokenType.StartTagClose:
			case TokenType.StartTagSelfClose:
			case TokenType.EndTagOpen:
				flush();
				break;

			default:
				break;
		}
	}

	flush();
	return byElement;
}

/**
 * What sits at an offset in a parsed document.
 *
 * This is what replaces matching a regular expression backwards from the cursor: a provider asks
 * where it is and gets an answer derived from the parse.
 *
 * @param document - The parsed document
 * @param offset - A character offset into the source
 * @returns {ViewNodeAt|undefined} What is there, if anything
 */
export function nodeAt (document: ViewDocument, offset: number): ViewNodeAt|undefined {
	// document order means a later element is always the more deeply nested one at this offset
	let found: ViewNodeAt|undefined;

	for (const element of document.elements) {
		if (offset < element.range.start || offset > element.range.end) {
			continue;
		}

		for (const attribute of element.attributes) {
			if (within(attribute.nameRange, offset)) {
				found = { kind: 'attributeName', element, attribute };
			} else if (attribute.valueRange && within(attribute.valueRange, offset)) {
				found = { kind: 'attributeValue', element, attribute };
			}
		}

		if (found?.element === element) {
			continue;
		}

		found = { kind: element.text ? 'text' : 'tag', element };
	}

	if (!found) {
		return;
	}

	// inside the element's name rather than its body
	const nameEnd = found.element.range.start + 1 + (found.element.tag?.length ?? 0);
	if (found.kind === 'text' && offset <= nameEnd) {
		return { kind: 'tag', element: found.element };
	}

	return found;
}

function within (range: ViewRange, offset: number): boolean {
	return offset >= range.start && offset <= range.end;
}

interface ParsedNode {
	tag?: string;
	start: number;
	end: number;
	startTagEnd?: number;
	endTagStart?: number;
	children?: ParsedNode[];
}

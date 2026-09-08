import path from 'node:path';
import { effectiveTag, resolveTag, startsLocal } from '../tags.ts';
import { parseXml } from '../xml.ts';
import type { TagContext } from '../tags.ts';
import type { XmlElement } from '../xml.ts';
import { GeneratedMapping } from './mapping.ts';
import type { MappingSegment, PositionMap } from './mapping.ts';

/**
 * The `$` declaration, generated from a view.
 *
 * Alloy emits `$.__views["myId"] = Ti.UI.createLabel(…)` for every element that reaches `$`, and
 * the controller template then runs `_.extend($, $.__views)`. So the type of `$` is a pure function
 * of the `(id, tag)` pairs in the view — of the pairs, not of the generated code. Nothing here
 * reproduces the compiler. It produces a declaration with the same shape as the compiler's output,
 * and `core/tags.ts` answers what each tag is.
 *
 * View text in, declaration and position map out. No I/O, so this serves the language server and
 * anything else identically.
 *
 * **Only one of these may be in scope at a time.** Every one declares `$`, because that is what
 * Alloy calls it in every controller, so two in the same program is a duplicate identifier.
 * `ProjectService.setGenerated` and `dropGenerated` are how a caller keeps it to one — the
 * declaration for the controller being asked about, and no other.
 *
 * The `Alloy` namespace is declared here rather than imported because there is nothing to import
 * it from: `@types/titanium` covers Titanium and stops there, with no `Alloy` namespace at all. A
 * declaration naming `Alloy.Controller` without one resolves to an error type, and an error type
 * for `$` takes every view member down with it.
 */

export interface ViewDeclaration {
	/** The declaration, as TypeScript */
	text: string;
	/** Where each part of it came from in the view */
	map: PositionMap;
	/**
	 * Whether the view parsed cleanly, so this is every id rather than the ids that survived.
	 *
	 * A half-typed view is the normal case rather than an error, and it still yields a useful
	 * declaration — the element being typed is the one the user is not asking about. But the
	 * difference matters to anything that would treat the absence of an id as meaningful, so it is
	 * reported rather than hidden.
	 */
	complete: boolean;
}

/**
 * The Alloy runtime, as much of it as a controller reaches through `$`.
 *
 * Transcribed from `Alloy/lib/alloy/controllers/BaseController.js` and the controller template.
 * Deliberately shallow: `unknown` where the real answer is "whatever that id is", because a
 * confident wrong type is worse than an honest unknown, and the view members beside it carry the
 * types that matter.
 */
const ALLOY_NAMESPACE = `declare namespace Alloy {

	/** The base class for Alloy controllers */
	interface Controller {
		/** The arguments the controller was created with */
		args: Record<string, unknown>;
		/** Every element of the view that has an id */
		__views: Record<string, unknown>;

		/** The view with this id, or the first top level view when none is given */
		getView (id?: string): unknown;
		/** Every element of the view that has an id */
		getViews (): Record<string, unknown>;
		getViewEx (options: { recurse: boolean }): unknown;
		/** The root view elements of this controller */
		getTopLevelViews (): unknown[];
		removeView (id: string): void;
		addTopLevelView (view: unknown): void;
		setParent (parent: unknown): void;

		getProxyProperty (name: string): unknown;
		getProxyPropertyEx (name: string, options: { recurse: boolean }): unknown;
		addProxyProperty (name: string, value: unknown): void;
		removeProxyProperty (name: string): void;

		/** The style a class or id resolves to in this controller's stylesheet */
		createStyle (options: unknown): Record<string, unknown>;
		addClass (proxy: unknown, classes: string | string[], options?: unknown): void;
		removeClass (proxy: unknown, classes: string | string[], options?: unknown): void;
		resetClass (proxy: unknown, classes?: string | string[], options?: unknown): void;
		updateViews (views: Record<string, unknown>): Controller;

		addListener (proxy: unknown, type: string, callback: (...args: unknown[]) => void): string;
		getListener (proxy?: unknown, type?: string): unknown[];
		removeListener (proxy?: unknown, type?: string, callback?: (...args: unknown[]) => void): void;

		destroy (): void;

		// Backbone.Events, which every controller is extended with
		on (event: string, callback: (...args: unknown[]) => void, context?: unknown): Controller;
		off (event?: string, callback?: (...args: unknown[]) => void, context?: unknown): Controller;
		once (event: string, callback: (...args: unknown[]) => void, context?: unknown): Controller;
		trigger (event: string, ...args: unknown[]): Controller;
		listenTo (other: unknown, event: string, callback: (...args: unknown[]) => void): Controller;
		stopListening (other?: unknown, event?: string, callback?: (...args: unknown[]) => void): Controller;
	}

	/** \`<Require>\` and \`<Widget>\` both compile to a controller */
	type Require = Controller;
	type Widget = Controller;

	/** A Backbone model, as \`<Model instance="true">\` puts one on \`$\` */
	interface Model {
		attributes: Record<string, unknown>;
		id: unknown;
		get (attribute: string): unknown;
		set (attribute: string | Record<string, unknown>, value?: unknown): Model;
		has (attribute: string): boolean;
		unset (attribute: string): Model;
		clear (): Model;
		toJSON (): Record<string, unknown>;
		fetch (options?: unknown): unknown;
		save (attributes?: unknown, options?: unknown): unknown;
		destroy (options?: unknown): unknown;
		on (event: string, callback: (...args: unknown[]) => void, context?: unknown): Model;
		off (event?: string, callback?: (...args: unknown[]) => void, context?: unknown): Model;
		trigger (event: string, ...args: unknown[]): Model;
	}

	/** A Backbone collection, as \`<Collection instance="true">\` puts one on \`$\` */
	interface Collection {
		models: Model[];
		length: number;
		at (index: number): Model;
		get (id: unknown): Model | undefined;
		add (models: unknown, options?: unknown): Collection;
		remove (models: unknown, options?: unknown): Collection;
		reset (models?: unknown, options?: unknown): Collection;
		each (iterator: (model: Model, index: number) => void): void;
		toJSON (): Record<string, unknown>[];
		fetch (options?: unknown): unknown;
		on (event: string, callback: (...args: unknown[]) => void, context?: unknown): Collection;
		off (event?: string, callback?: (...args: unknown[]) => void, context?: unknown): Collection;
		trigger (event: string, ...args: unknown[]): Collection;
	}
}`;

/** What the interface is called when the view's name yields no identifier at all */
const FALLBACK_NAME = 'Alloy';

/** An id that can be written as a bare property name rather than a quoted one */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** One member of `$`, before it is written out */
interface Member {
	id: string;
	types: string[];
	/** Where the view writes the id, or the element's tag when the id came from the view's name */
	source?: number;
	/**
	 * How much of the view the member stands for, when it is not a copy of what is written there.
	 *
	 * Only the default id needs it: `index` and the `Window` it names are different text of
	 * different lengths, so the run maps as a whole rather than character for character.
	 */
	sourceLength?: number;
	/** Whether the view wrote the id inside quotes, which decides how wide the mapping is */
	quotedInSource?: boolean;
}

/**
 * Generates the `$` declaration for one view.
 *
 * Never throws. A view that is being typed yields the members that parsed, with `complete` false.
 *
 * @param viewPath - The view's path, which names the interface and is what positions map back into
 * @param text - The view's contents
 * @returns {ViewDeclaration} The declaration, its mapping and whether it is the whole view
 */
export function generateViewDeclaration (viewPath: string, text: string): ViewDeclaration {
	const document = parseXml(text);
	const viewName = path.basename(viewPath, path.extname(viewPath));

	// keyed by id so a duplicate replaces rather than repeats: Alloy's `$.__views` takes the last
	// write, and TypeScript would reject the same member declared twice
	const members = new Map<string, Member>();

	const visit = (element: XmlElement, parent: XmlElement|undefined, local: boolean, parentTag: string|undefined): void => {
		collect(element, { parent, local, parentTag }, text, viewName, members);

		// a parent that a parser renamed renames its own children by the name it ended up with, so
		// the chain is folded on the way down rather than read off the tag the view writes
		const tag = effectiveTag(element, { parent, parentTag });

		for (const child of element.children) {
			visit(child, element, local || startsLocal(element), tag);
		}
	};

	for (const root of document.roots) {
		visit(root, undefined, false, undefined);
	}

	const interfaceName = `${identifierFrom(viewName)}Views`;
	const { body, segments } = write(interfaceName, [ ...members.values() ]);

	return {
		text: body,
		map: new GeneratedMapping(viewPath, segments),
		// an element with no tag is a `<` the user has just typed, and an unclosed one is a tag
		// they have not finished — either way there are ids still to come
		complete: document.elements.every(element => element.tag !== undefined && element.closed)
	};
}

/**
 * Records what one element contributes to `$`, if anything
 *
 * @param element - The element
 * @param context - What its surroundings say about it, which is what resolution reads
 * @param view - The view's contents, for reading around the id
 * @param viewName - The view's own name, which a root element with no id takes
 * @param members - The members being accumulated, by id
 */
function collect (element: XmlElement, context: TagContext, view: string, viewName: string, members: Map<string, Member>): void {
	const types = resolveTag(element, context);
	if (!types) {
		return;
	}

	const attribute = element.attributes.find(candidate => candidate.name === 'id');

	// an empty id is absent as far as Alloy is concerned — it generates one of its own, which
	// names nothing a controller can reach
	if (attribute?.value && attribute.valueRange) {
		members.set(attribute.value, {
			id: attribute.value,
			types,
			source: attribute.valueRange.start,
			quotedInSource: isQuote(view[attribute.valueRange.start - 1]) && isQuote(view[attribute.valueRange.end])
		});
		return;
	}

	// every direct child of <Alloy> with no id of its own takes the view's name as its id, which
	// is how `$.index` reaches a view's top level element. The name is the file's rather than the
	// view's, so there is no id to point at — but the element it names is in the view, and its tag
	// is where go to definition should land
	if (!attribute?.value && context.parent?.tag === 'Alloy' && element.tag) {
		members.set(viewName, {
			id: viewName,
			types,
			// the tag sits one character past the `<`
			source: element.range.start + 1,
			sourceLength: element.tag.length
		});
	}
}

/**
 * Writes the declaration out, recording where each id landed in it
 *
 * @param interfaceName - What to call the interface
 * @param members - The members, in document order
 * @returns The text and the runs of it that came from the view
 */
function write (interfaceName: string, members: Member[]): { body: string; segments: MappingSegment[] } {
	const segments: MappingSegment[] = [];
	let body = `${ALLOY_NAMESPACE}\n\ninterface ${interfaceName} {\n`;

	for (const member of members) {
		// a key is quoted only when it has to be. `$.__views["my-id"]` is legal in Alloy and
		// `my-id: T` is not legal TypeScript, so the quotes are there for the ids that need them —
		// and TypeScript reports the definition of a quoted key as the quotes and all, so leaving
		// them off wherever they are not needed is what makes go to definition land on the id
		const quoted = !IDENTIFIER.test(member.id);
		const key = quoted ? `"${member.id}"` : member.id;

		body += '\t';

		if (member.source !== undefined) {
			// a quoted key's span covers its quotes, and the view wrote its id in quotes too, so
			// the run to map is one character wider at each end — where the view really has them
			const withQuotes = quoted && member.quotedInSource;
			segments.push({
				generated: { start: body.length + (withQuotes ? 0 : Number(quoted)), length: member.id.length + (withQuotes ? 2 : 0) },
				// a length says the run stands for that source rather than copying it, which is
				// what a default id does — it names an element the view never spells out
				source: { start: member.source - (withQuotes ? 1 : 0), length: member.sourceLength }
			});
		}

		body += `${key}: ${member.types.join(' | ')};\n`;
	}

	body += `}\n\ndeclare const $: ${interfaceName} & Alloy.Controller;\n`;

	return { body, segments };
}

/**
 * Whether a character delimits an attribute value
 *
 * @param character - The character, or nothing when the offset was outside the document
 * @returns {boolean} Whether it is a quote
 */
function isQuote (character: string|undefined): boolean {
	return character === '"' || character === "'";
}

/**
 * A view's name as a PascalCase identifier.
 *
 * A view is a file name and a file name is not an identifier: `my-first.view.xml` is a legal view
 * and `my-first.viewViews` is not a legal interface name.
 *
 * @param name - The view's name, without its extension
 * @returns {string} An identifier
 */
function identifierFrom (name: string): string {
	const parts = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
	const identifier = parts.map(part => part[0].toUpperCase() + part.slice(1)).join('');

	// an identifier cannot start with a digit, and a view named `123.xml` is a view like any other
	return /^[A-Za-z]/.test(identifier) ? identifier : FALLBACK_NAME;
}

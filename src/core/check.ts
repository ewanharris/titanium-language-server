import { resolveStyle } from './cascade.ts';
import type { CascadeRule, ResolvedProperty, StyledElement } from './cascade.ts';
import type { SourceFile } from './references.ts';
import { effectiveTag, isAbstractTag } from './tags.ts';
import { parseXml } from './xml.ts';
import type { XmlElement } from './xml.ts';
import type { ApiMember } from './typescript/host.ts';

/**
 * Checking that a stylesheet or a view only writes properties the element actually has.
 *
 * Alloy is silent on this. `widht: 10` in a `.tss` and `colr="red"` in a view both compile without
 * a warning, reach the generated controller verbatim, and do nothing at run time.
 *
 * The question is one `@types/titanium` already answers, so nothing here carries a table of
 * properties: `core/cascade.ts` says which rules reach which element and what each one sets, and
 * `ProjectService.membersOf` says what that element's type has. This is the comparison between
 * them, and it reports what the author wrote rather than what the cascade made of it.
 *
 * Three things decide whether a property is a finding, and each of them is a false positive
 * otherwise.
 *
 * **It is reported once per place it is written, not once per element it reaches.** A `"Label"`
 * rule in a view with nine labels is one authored line and one mistake. Keying findings on the
 * element would report it nine times, which is what checking Alloy's generated output does and
 * the reason that approach is unusable.
 *
 * **A rule is judged against every element it styles, together.** A class shared by a `<Label>`
 * and a `<Window>` legitimately sets `text` for one and `orientationModes` for the other — Alloy
 * merges the same dictionary into both and each takes what it understands. So a property is only
 * unknown when it is unknown to all of them.
 *
 * **An element the project has no types for silences the rule it is in.** A native module's
 * proxies are not in `@types/titanium` at all, so `membersOf` answers nothing for a `module=` tag
 * and nothing is what we know about it. One such element in a rule's reach makes every property in
 * that rule unanswerable, not wrong.
 */

/** A span of a source file, in character offsets */
export interface SourceRange {
	start: number;
	end: number;
}

/** A view, its elements and the rules that could style them — what `unknownProperties` reads */
export interface CheckedView {
	view: SourceFile;
	elements: StyledElement[];
	/** Every rule that could apply, as `sortRules` orders them */
	rules: CascadeRule[];
}

/** A property written somewhere no element it reaches has it */
export interface Finding {
	/** The stylesheet or view that writes it */
	file: string;
	/** The property's name, where it is written */
	range: SourceRange;
	/** The property, dotted when it is inside an object: `font.fontSize` */
	property: string;
	/** The selector it is written under, absent when an element's own attribute writes it */
	selector?: string;
	/** The types it was checked against */
	types: string[];
	/** A name the types do have that it is close to, when there is one */
	suggestion?: string;
}

/**
 * Properties Alloy reads for itself, on the types it reads them for.
 *
 * These reach the proxy — they are not in `RESERVED_ATTRIBUTES`, so `getParserArgs` passes them
 * through to the create call, and the cascade is right to report them — but Titanium ignores them
 * and Alloy is the one that acts on them. So they are not mistakes, whatever the types say.
 */
const ALLOY_PROPERTIES: Record<string, string[]> = {
	// Ti.UI.Toolbar.js hands these to the activity when a Window names this toolbar as its
	// ActionBar, where they are ActionBar properties rather than Toolbar ones
	'Titanium.UI.Toolbar': [ 'backgroundImage', 'displayHomeAsUp', 'homeButtonEnabled', 'navigationMode', 'onHomeIconItemSelected' ],
	// and reads this off the parent Window to find which toolbar that is
	'Titanium.UI.Window': [ 'customToolbar' ]
};

/** How far apart two names may be and still be a plausible typo of each other */
const NEAR = 2;

/** Below this length a name is too short for two edits to mean anything */
const SHORT = 4;

/** What one source asks of the project's types. `ProjectService` satisfies it */
export interface MemberSource {
	membersOf (type: string, path?: string[]): ApiMember[];
}

/** One place a property is written, and what the types said about it there */
interface Observation {
	file: string;
	range: SourceRange;
	property: string;
	selector?: string;
	/** Every type it was checked against, in the order they were met */
	types: string[];
	/** Whether any of them has it */
	known: boolean;
	/** Whether any of them is a type the project has no answer for */
	opaque: boolean;
	/** The names those types do have, which a suggestion comes from */
	candidates: Set<string>;
}

/**
 * Every property written where nothing it reaches has it.
 *
 * A pure function of the views and rules it is given, so the same call serves the language server,
 * a build and a test. Reading the files, and resolving which stylesheets apply, is the caller's
 * business — `related.stylesheetsFor` and `cascade.sortRules` are what produce a `CheckedView`.
 *
 * @param views - The views to check, each with its elements and applicable rules
 * @param api - Where the project's types come from
 * @returns {Finding[]} The findings, in the order their files and positions were met
 */
export function unknownProperties (views: CheckedView[], api: MemberSource): Finding[] {
	const seen = new Map<string, Observation>();

	for (const checked of views) {
		const data = dataElements(checked.view.text);

		for (const element of checked.elements) {
			for (const resolved of resolveStyle(checked.rules, element)) {
				observe(seen, checked, element, resolved, api, data.has(element.element.range.start));
			}
		}
	}

	return [ ...seen.values() ]
		.filter(observation => !observation.known && !observation.opaque)
		.map(observation => ({
			file: observation.file,
			range: observation.range,
			property: observation.property,
			selector: observation.selector,
			types: observation.types,
			suggestion: nearest(leafOf(observation.property), observation.candidates)
		}));
}

/**
 * Records what the types say about one property of one element, against every place it is written.
 *
 * A property can be written in several rules and in the element's own attributes at once, and each
 * of those is a separate place a mistake could be. They are all recorded, so a name that is wrong
 * in two stylesheets is two findings and a name that is wrong in one is one.
 *
 * @param seen - The observations so far, by where they are written
 * @param checked - The view being read
 * @param element - The element the property resolved for
 * @param resolved - The property, as the cascade resolved it
 * @param api - Where the project's types come from
 * @param data - Whether the element is an entry of a property rather than a proxy, so its type is
 *   whatever the array around it holds and the tag it is written with does not say
 */
function observe (seen: Map<string, Observation>, checked: CheckedView, element: StyledElement, resolved: ResolvedProperty, api: MemberSource, data: boolean): void {
	if (ALLOY_PROPERTIES[element.type]?.includes(resolved.name)) {
		return;
	}

	const path = resolved.name.split('.');
	const leaf = path.pop() as string;

	const members = data ? [] : api.membersOf(element.type, path);
	const known = members.some(member => member.name === leaf);

	for (const site of sitesOf(checked, element, resolved)) {
		const key = `${site.file}\u0000${site.range.start}`;
		const observation = seen.get(key) ?? {
			...site,
			property: resolved.name,
			types: [],
			known: false,
			opaque: false,
			candidates: new Set<string>()
		};

		if (!observation.types.includes(element.type)) {
			observation.types.push(element.type);
		}
		observation.known ||= known;
		// nothing for the type at all, rather than the type not having this one
		observation.opaque ||= members.length === 0;
		for (const member of members) {
			observation.candidates.add(member.name);
		}

		seen.set(key, observation);
	}
}

/**
 * Every place one resolved property is written.
 *
 * The cascade reports the rule whose value won, the rules it overrode and the rules that would
 * override it at run time. All of them are authored lines, so a typo in an overridden rule or in a
 * platform-gated one is found rather than hidden by whichever rule happened to win.
 *
 * @param checked - The view being read
 * @param element - The element the property resolved for
 * @param resolved - The property, as the cascade resolved it
 * @returns Each file and range that writes it
 */
function sitesOf (checked: CheckedView, element: StyledElement, resolved: ResolvedProperty): { file: string; range: SourceRange; selector?: string }[] {
	const sites = [ ...resolved.overridden, ...resolved.conditional, ...resolved.applied ? [ resolved.applied ] : [] ]
		.map(source => ({
			file: source.rule.file,
			range: source.property.nameRange,
			selector: source.rule.part.text
		}));

	if (!resolved.attribute) {
		return sites;
	}

	// the element's own attribute, which the cascade reports as a winner with no rule behind it
	const attribute = element.element.attributes.find(candidate => candidate.name === resolved.name);

	return attribute ? [ ...sites, { file: checked.view.path, range: attribute.nameRange, selector: undefined } ] : sites;
}

/**
 * The elements of a view that are entries of a property rather than proxies of their own.
 *
 * Anything inside abstract markup: `<ButtonBar><Labels><Label image="…"/></Labels></ButtonBar>`
 * writes a `Label`, and Alloy turns it into an entry of the ButtonBar's `labels` array, whose
 * properties are the array's and not a Label's. The tag resolves to a Titanium type all the same,
 * so without this the entry is checked against the wrong one.
 *
 * What the entry's type actually is depends on the container Alloy translated the markup into —
 * `BarItemType` here — and nothing models that yet, so these are unanswerable rather than wrong.
 *
 * Reported by where each element starts rather than by identity: the caller parsed the view to
 * produce its elements and this parses it again, so there are two trees of the same text and only
 * the offsets are common to both.
 *
 * @param text - The view
 * @returns {Set<number>} Where each element inside abstract markup starts
 */
function dataElements (text: string): Set<number> {
	const data = new Set<number>();

	const visit = (element: XmlElement, parent: XmlElement|undefined, parentTag: string|undefined, inside: boolean): void => {
		if (inside) {
			data.add(element.range.start);
		}

		const tag = effectiveTag(element, { parent, parentTag });
		const abstract = element.tag !== undefined && isAbstractTag(element.tag);

		for (const child of element.children) {
			// any depth, not just a direct child: a <View> inside <Labels> is as much a part of
			// that array's entries as the elements beside it
			visit(child, element, tag, inside || abstract);
		}
	};

	for (const root of parseXml(text).roots) {
		visit(root, undefined, undefined, false);
	}

	return data;
}

/**
 * The last segment of a dotted property path, which is the name a type is asked for
 *
 * @param property - The property, dotted
 * @returns {string} Its last segment
 */
function leafOf (property: string): string {
	return property.slice(property.lastIndexOf('.') + 1);
}

/**
 * The name a type has that a written one was most likely meant to be.
 *
 * A short name is only ever one edit from what was meant: with two allowed, `top` is as close to
 * `tip` as to anything, and a confident wrong suggestion is worse than none.
 *
 * @param written - The name as written
 * @param candidates - The names the types have
 * @returns {string|undefined} The nearest, when one is near enough
 */
function nearest (written: string, candidates: Set<string>): string|undefined {
	const allowed = written.length <= SHORT ? 1 : NEAR;

	let best: string|undefined;
	let shortest = allowed + 1;

	for (const candidate of candidates) {
		// a name differing only in case is what was meant, whatever the edit distance says
		if (candidate.toLowerCase() === written.toLowerCase()) {
			return candidate;
		}

		const distance = editDistance(written, candidate);
		if (distance < shortest) {
			shortest = distance;
			best = candidate;
		}
	}

	return best;
}

/**
 * How many single character edits turn one string into another.
 *
 * Written out rather than taken from a package: it is a dozen lines, and the project's rule is to
 * check whether the platform does it before adding a dependency. The platform does not do this
 * one, but a dozen lines is not a dependency either.
 *
 * @param from - One string
 * @param to - The other
 * @returns {number} The number of edits between them
 */
function editDistance (from: string, to: string): number {
	let previous = Array.from({ length: to.length + 1 }, (_, index) => index);

	for (let i = 1; i <= from.length; i++) {
		const current = [ i ];

		for (let j = 1; j <= to.length; j++) {
			current[j] = from[i - 1] === to[j - 1]
				? previous[j - 1]
				: 1 + Math.min(previous[j - 1], previous[j], current[j - 1]);
		}

		previous = current;
	}

	return previous[to.length];
}

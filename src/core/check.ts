import { resolveStyle, sortRules, styledElements } from './cascade.ts';
import type { CascadeRule, PropertySource, ResolvedProperty, StyledElement } from './cascade.ts';
import type { Project } from './project.ts';
import type { SourceCache, SourceFile } from './references.ts';
import { stylesheetsFor, viewsStyledBy } from './related.ts';
import { effectiveTag, isAbstractTag } from './tags.ts';
import { parseXml } from './xml.ts';
import type { XmlAttribute, XmlElement } from './xml.ts';
import type { TssProperty } from './tss.ts';
import path from 'node:path';
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
	membersOf (type: string, path?: string[]): readonly ApiMember[];
}

/**
 * What one element's type says about one property.
 *
 * Four answers rather than two, because a rule is judged against every element it styles and only
 * one of them silences it. An element with no types at all says nothing about anything in the rule,
 * so the whole rule is unanswerable; a path through a value that is not an object says nothing about
 * this property alone, which is a question about the value rather than the name; and a type that
 * lacks the name says where in the path it went wrong, so a misspelt `fnt` is reported as `fnt`.
 */
type Answer =
	| { kind: 'known' }
	/** The type has no name at `depth` in the path; `candidates` are the names it has there */
	| { kind: 'unknown'; depth: number; candidates: readonly ApiMember[] }
	/** The path runs through something whose members cannot be read, such as a string */
	| { kind: 'unanswerable' }
	/** The element is not one the project's types describe */
	| { kind: 'opaque' };

/** One place a property is written: a rule's property, or an element's own attribute */
interface Site {
	file: string;
	/** The name as written: the leaf of a nested property, or the whole of a dotted attribute */
	range: SourceRange;
	selector?: string;
	/** The rule's property, so a name further up its path can be found again */
	source?: PropertySource;
}

/** One place a property is written, and what the types said about it there */
interface Observation {
	site: Site;
	property: string;
	/** Every type it was checked against, in the order they were met */
	types: string[];
	/** Whether any of them has it */
	known: boolean;
	/** Whether any of them is an element the project has no types for */
	opaque: boolean;
	/** The furthest into the path any type got before it went wrong */
	depth?: number;
	/** The names the types that got that far have there, which a suggestion comes from */
	candidates: Set<string>;
}

/** The elements Alloy hands their attributes to as arguments rather than as proxy properties */
const COMPONENT_TAGS = new Set([ 'Require', 'Widget', 'Module' ]);

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
export function unknownProperties (views: CheckedView[], source: MemberSource): Finding[] {
	const seen = new Map<string, Observation>();
	const api = remembering(source);

	for (const checked of views) {
		const data = dataElements(checked.view.text);

		for (const element of [ ...checked.elements, ...componentsOf(checked) ]) {
			const opaque = data.has(element.element.range.start) || isComponent(element.element);

			for (const resolved of resolveStyle(checked.rules, element)) {
				observe(seen, checked, element, resolved, opaque ? { kind: 'opaque' } : answerFor(api, element.type, resolved.name));
			}
		}
	}

	const findings = new Map<string, Finding>();
	for (const observation of seen.values()) {
		if (observation.known || observation.opaque || observation.depth === undefined) {
			continue;
		}

		const segments = observation.property.split('.').slice(0, observation.depth + 1);
		const range = rangeAt(observation.site, segments);
		// every property inside a misspelt object is the same mistake, written once
		const key = `${observation.site.file}\u0000${range.start}`;
		if (!findings.has(key)) {
			findings.set(key, {
				file: observation.site.file,
				range,
				property: segments.join('.'),
				selector: observation.site.selector,
				types: observation.types,
				suggestion: nearest(segments[segments.length - 1], observation.candidates)
			});
		}
	}

	return [ ...findings.values() ];
}

/** A view, and what reading it and its stylesheets needs */
export interface ViewCheckContext {
	project: Project;
	/** The view, as it is being edited */
	view: SourceFile;
	api: MemberSource;
	cache: SourceCache;
}

/** A stylesheet, and what reading it and the views it styles needs */
export interface StyleCheckContext {
	project: Project;
	/** The stylesheet, as it is being edited */
	style: SourceFile;
	api: MemberSource;
	cache: SourceCache;
}

/**
 * What a view's own attributes write that its elements do not have.
 *
 * Its stylesheets are checked with it, because the cascade is what says which attributes an element
 * takes as properties, but only what the view itself writes is answered: a mistake in a stylesheet
 * belongs to the stylesheet, and is reported there.
 *
 * @param context - The view and the project it is in
 * @returns {Promise<Finding[]>} The findings in the view
 */
export async function findingsInView (context: ViewCheckContext): Promise<Finding[]> {
	const { project, view, api, cache } = context;
	if (await project.type() !== 'alloy') {
		return [];
	}

	const checked = { view, elements: styledElements(view), rules: sortRules(await stylesheetsFor(project, view.path, cache)) };

	return unknownProperties([ checked ], api).filter(finding => finding.file === view.path);
}

/**
 * What a stylesheet writes that no element it styles has.
 *
 * Every view the stylesheet styles is checked at once, because a rule is judged against all of its
 * elements together: `app.tss` against every view in the project, widgets included, and a view's
 * own stylesheet against the view and its platform versions. A view that does not load it — a
 * theme `config.json` does not select — is left out, since nothing there is styled by it.
 *
 * @param context - The stylesheet and the project it is in
 * @returns {Promise<Finding[]>} The findings in the stylesheet
 */
export async function findingsInStyle (context: StyleCheckContext): Promise<Finding[]> {
	const { project, style, api, cache } = context;

	const views: CheckedView[] = [];
	for (const view of await viewsStyledBy(project, style.path, cache)) {
		const loads = await stylesheetsFor(project, view.path, cache);
		if (!loads.some(sheet => sheet.path === style.path)) {
			continue;
		}

		// the stylesheet as it is being edited, which may not have reached the cache
		const sheets = loads.map(sheet => sheet.path === style.path ? { ...sheet, text: style.text } : sheet);
		views.push({ view, elements: styledElements(view), rules: sortRules(sheets) });
	}

	return unknownProperties(views, api).filter(finding => finding.file === style.path);
}

/**
 * What to tell the user about a finding.
 *
 * Types are named as Titanium code writes them, `Ti.UI.Label` rather than `Titanium.UI.Label`.
 * A rule that styles elements of several types names them all, since the property is unknown to
 * every one and any of them is where it might have been meant to go.
 *
 * @param finding - The finding
 * @returns {string} The message
 */
export function messageFor (finding: Finding): string {
	const types = finding.types.map(type => type.replace(/^Titanium\./, 'Ti.'));
	const unknown = types.length === 1
		? `${types[0]} has no property '${finding.property}'.`
		: `None of the elements this rule styles has a property '${finding.property}': ${types.join(', ')}.`;

	return finding.suggestion ? `${unknown} Did you mean '${finding.suggestion}'?` : unknown;
}

/** An edit that corrects a finding */
export interface Replacement {
	range: SourceRange;
	text: string;
}

/**
 * The edit that changes a finding's name to the one it was probably meant to be.
 *
 * Only the last segment of the name is replaced, and not the quotes around it: a finding covers
 * `"widht"` with its quotes in a stylesheet and the whole of `font.fntSize` in an attribute, while
 * the suggestion is the one name the type has. So the span is found from the end of the finding's
 * range, and checked against the text rather than trusted.
 *
 * @param finding - The finding
 * @param text - The file it is in
 * @returns {Replacement|undefined} The edit, when there is a suggestion to make
 */
export function replacementFor (finding: Finding, text: string): Replacement|undefined {
	if (!finding.suggestion) {
		return;
	}

	const leaf = leafOf(finding.property);
	const written = text.slice(finding.range.start, finding.range.end);
	const end = finding.range.end - (/^["']/.test(written) ? 1 : 0);
	const start = end - leaf.length;

	if (start < finding.range.start || text.slice(start, end) !== leaf) {
		return;
	}

	return { range: { start, end }, text: finding.suggestion };
}

/**
 * A member source that asks each question once.
 *
 * One check asks after the same few types once per element per property — 4467 times for 50
 * types on a real project's `app.tss` — and even a source that remembers its answers does work to
 * find out whether its program has changed before it can give one. Within a single check it has
 * not, so the answers are kept here for as long as the check runs.
 *
 * @param source - Where the project's types come from
 * @returns {MemberSource} The same answers, each worked out once
 */
function remembering (source: MemberSource): MemberSource {
	const known = new Map<string, readonly ApiMember[]>();

	return {
		membersOf (type: string, path: string[] = []): readonly ApiMember[] {
			const key = [ type, ...path ].join('.');
			let members = known.get(key);
			if (!members) {
				members = source.membersOf(type, path);
				known.set(key, members);
			}
			return members;
		}
	};
}

/**
 * What a type says about a property, walking its path one name at a time.
 *
 * A property Alloy reads for itself is known whatever the types say, and counts as known for every
 * element a rule styles: a class shared by a Toolbar and a Label may set `displayHomeAsUp`.
 *
 * @param api - Where the project's types come from
 * @param type - The element's type
 * @param name - The property, dotted when it is inside an object
 * @returns {Answer} What the type says
 */
function answerFor (api: MemberSource, type: string, name: string): Answer {
	if (ALLOY_PROPERTIES[type]?.includes(name)) {
		return { kind: 'known' };
	}

	const path = name.split('.');
	let members = api.membersOf(type);
	if (!members.length) {
		return { kind: 'opaque' };
	}

	for (let depth = 0; ; depth++) {
		if (!members.some(member => member.name === path[depth])) {
			return { kind: 'unknown', depth, candidates: members };
		}
		if (depth === path.length - 1) {
			return { kind: 'known' };
		}

		members = api.membersOf(type, path.slice(0, depth + 1));
		if (!members.length) {
			return { kind: 'unanswerable' };
		}
	}
}

/**
 * Records what one element's type says about one property, against every place it is written.
 *
 * A property can be written in several rules and in the element's own attributes at once, and each
 * of those is a separate place a mistake could be. They are all recorded, so a name that is wrong
 * in two stylesheets is two findings and a name that is wrong in one is one.
 *
 * @param seen - The observations so far, by where they are written
 * @param checked - The view being read
 * @param element - The element the property resolved for
 * @param resolved - The property, as the cascade resolved it
 * @param answer - What the element's type says about it
 */
function observe (seen: Map<string, Observation>, checked: CheckedView, element: StyledElement, resolved: ResolvedProperty, answer: Answer): void {
	for (const site of sitesOf(checked, element, resolved)) {
		const key = `${site.file}\u0000${site.range.start}`;
		const observation = seen.get(key) ?? { site, property: resolved.name, types: [], known: false, opaque: false, candidates: new Set<string>() };

		if (!observation.types.includes(element.type)) {
			observation.types.push(element.type);
		}
		observation.known ||= answer.kind === 'known';
		observation.opaque ||= answer.kind === 'opaque';

		// the type that got furthest into the path says the most about what was meant: a Label has
		// `font` and lacks `fntSize`, where a Window lacks `font` and says only that it has none
		if (answer.kind === 'unknown' && (observation.depth === undefined || answer.depth >= observation.depth)) {
			if (answer.depth !== observation.depth) {
				observation.candidates.clear();
			}
			observation.depth = answer.depth;
			for (const member of answer.candidates) {
				observation.candidates.add(member.name);
			}
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
function sitesOf (checked: CheckedView, element: StyledElement, resolved: ResolvedProperty): Site[] {
	const sites: Site[] = [ ...resolved.overridden, ...resolved.conditional, ...resolved.applied ? [ resolved.applied ] : [] ]
		.map(source => ({
			file: source.rule.file,
			range: source.property.nameRange,
			selector: source.rule.part.text,
			source
		}));

	if (!resolved.attribute) {
		return sites;
	}

	// the element's own attribute, which the cascade reports as a winner with no rule behind it
	const attribute: XmlAttribute|undefined = element.element.attributes.find(candidate => candidate.name === resolved.name);

	return attribute ? [ ...sites, { file: checked.view.path, range: attribute.nameRange } ] : sites;
}

/**
 * Where the name a path went wrong at is written.
 *
 * The last of the segments, which is the leaf itself when the whole path is right but its last
 * name. Further up, a rule's property is found again in the rule, as the object holding the leaf;
 * a dotted attribute is one name, so the span is the part of it up to that segment.
 *
 * @param site - Where the property is written
 * @param segments - The path, up to and including the name that went wrong
 * @returns {SourceRange} The span to report
 */
function rangeAt (site: Site, segments: string[]): SourceRange {
	if (!site.source) {
		return { start: site.range.start, end: site.range.start + segments.join('.').length };
	}

	let properties: TssProperty[] = site.source.rule.rule.properties;
	let found: TssProperty|undefined;
	for (const segment of segments) {
		found = properties.find(property => property.name === segment && property.range.start <= site.range.start && site.range.start < property.range.end);
		properties = found?.value?.kind === 'object' ? found.value.properties : [];
	}

	return found?.nameRange ?? site.range;
}

/**
 * The elements Alloy creates but the cascade leaves out, because no Titanium type is behind them.
 *
 * `<Require>` and `<Widget>` take what a rule sets as arguments to a controller, so they are styled
 * like any element but answer nothing about what they accept. A rule that reaches one is not checked.
 *
 * @param checked - The view
 * @returns {StyledElement[]} Them, as the cascade would see them were they typed
 */
function componentsOf (checked: CheckedView): StyledElement[] {
	const typed = new Set(checked.elements.map(element => element.element.range.start));
	const document = parseXml(checked.view.text);
	const roots = new Set(document.roots.flatMap(root => root.tag === 'Alloy' ? root.children : []));
	const viewName = path.basename(checked.view.path, path.extname(checked.view.path));

	return document.elements
		.filter(element => isComponent(element) && !typed.has(element.range.start))
		.map(element => {
			const attribute = (name: string): string|undefined => element.attributes.find(candidate => candidate.name === name)?.value;
			return {
				element,
				type: `Alloy.${element.tag}`,
				id: attribute('id') || (roots.has(element) ? viewName : undefined),
				classes: (attribute('class') ?? '').split(/\s+/).filter(Boolean)
			};
		});
}

/**
 * Whether an element is created by something other than Titanium: a controller, a widget, or a
 * native module, whether named by `<Module>` or by a `module` attribute on any tag
 *
 * @param element - The element
 * @returns {boolean} Whether its type says nothing about what it accepts
 */
function isComponent (element: XmlElement): boolean {
	return (element.tag !== undefined && COMPONENT_TAGS.has(element.tag)) || element.attributes.some(attribute => attribute.name === 'module');
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

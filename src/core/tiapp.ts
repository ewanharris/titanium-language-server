import path from 'node:path';
import { compareVersions, readModules } from './modules.ts';
import type { InstalledModule } from './modules.ts';
import type { TitaniumInstall } from './titanium.ts';
import type { ViewCompletion } from './view.ts';
import { inComment, nodeAt, parseXml, unescapeXml } from './xml.ts';
import type { XmlDocument, XmlElement, XmlNodeAt, XmlRange } from './xml.ts';
import type { SourceFile } from './references.ts';

/**
 * What can be written at a position in a tiapp.xml.
 *
 * Two elements are answered from the machine rather than from the project: `<sdk-version>`
 * takes an SDK the CLI says is installed, and `<module>` takes a module installed in the project or
 * globally, with its `platform` and `version` narrowed to what is installed of it.
 *
 * The rest is a short list of the values people most often write, each checked against what the
 * SDK's build and runtime read rather than taken from the documentation alone — see `TEXT_VALUES`.
 *
 * Nothing here needs the project's types or even a registered project. A tiapp.xml without an
 * sdk-version is one the registry turns away, and it is exactly the one that most needs an SDK
 * offered — so this takes the tiapp.xml alone, and the modules directory beside it.
 */

/**
 * What the CLI can be asked.
 *
 * An interface rather than `TitaniumCli` itself so that composing a completion can be tested
 * without spawning anything.
 */
export interface InstalledSource {
	installed (): Promise<TitaniumInstall>;
}

export interface TiappCompletionContext {
	tiapp: SourceFile;
	offset: number;
	titanium: InstalledSource;
}

/** A module installed somewhere, and where */
interface FoundModule extends InstalledModule {
	scope: 'project' | 'global';
}

/** The platform names a tiapp.xml writes that the CLI reads as another */
const PLATFORM_ALIASES: Record<string, string> = { ipad: 'ios', iphone: 'ios' };

/**
 * The completions at a position in a tiapp.xml
 *
 * @param context - The tiapp.xml, the position in it, and the CLI to ask what is installed
 * @returns {Promise<ViewCompletion[]>} What could be written there
 */
export async function tiappCompletionsAt (context: TiappCompletionContext): Promise<ViewCompletion[]> {
	const { tiapp, offset } = context;
	if (inComment(tiapp.text, offset)) {
		return [];
	}

	const document = parseXml(tiapp.text);
	const at = nodeAt(document, offset);
	if (!at) {
		return [];
	}

	// the element's own text and nowhere past it: an element's range takes in its end tag, and the
	// cursor just after `</sdk-version>` reads as inside it
	const inText = at.kind === 'text' && offset <= textEnd(tiapp.text, at.element);
	const place = placeOf(document, at.element);

	if (inText && place === 'sdk-version') {
		const { sdks } = await context.titanium.installed();
		const range = textRange(tiapp.text, at.element, offset);

		return sdks.map((sdk, index) => ({ label: sdk.version, kind: 'enum member', detail: sdk.path, sortText: order(index), range }));
	}

	if (place !== 'modules/module') {
		return valuesAt(tiapp.text, at, place, inText, offset);
	}

	const platform = platformOf(at.element);

	if (inText) {
		const modules = (await installedModules(context)).filter(module => !platform || module.platform === platform);
		return moduleIds(modules, textRange(tiapp.text, at.element, offset));
	}

	if (at.kind !== 'attributeValue' || !at.attribute?.valueRange) {
		return [];
	}

	const { name, valueRange: range } = at.attribute;

	// a fixed list, answered before the CLI is asked: the first request waits for it, and a CLI that
	// hangs holds that request until it times out
	if (name === 'deploy-type') {
		return listEntryAt(at.attribute.value ?? '', range, offset, DEPLOY_TYPES);
	}
	if (name !== 'platform' && name !== 'version') {
		return [];
	}

	const id = moduleId(tiapp.text, at.element);
	const named = (await installedModules(context)).filter(module => !id || module.id === id);

	if (name === 'platform') {
		const platforms = [ ...new Set(named.map(module => module.platform)) ].sort();
		return platforms.map(platformName => ({ label: platformName, kind: 'enum member', range }));
	}

	const versions = [ ...new Set(named.filter(module => !platform || module.platform === platform).map(module => module.version)) ]
		.sort((a, b) => compareVersions(b, a));
	return versions.map((version, index) => ({ label: version, kind: 'enum member', sortText: order(index), range }));
}

/**
 * Where an element is, as the tags below the root that lead to it: `ios/use-autolayout`.
 *
 * The build reads a tiapp.xml from the root's own children down, so an element is only read where
 * its whole path says, and a lookalike nested elsewhere — an Android manifest has `<property>`
 * elements of its own — is read by nothing. The root is left out whatever it is called, as the
 * build reads it, and so is a nameless element: the XML declaration parses as one around the
 * document, and a bare `<` being typed as another.
 *
 * @param document - The parsed tiapp.xml
 * @param element - The element
 * @returns {string} Its path, empty for the root itself
 */
function placeOf (document: XmlDocument, element: XmlElement): string {
	const parents = new Map(document.elements.flatMap(parent => parent.children.map(child => [ child, parent ] as const)));

	const tags: string[] = [];
	for (let node: XmlElement|undefined = element; node; node = parents.get(node)) {
		if (node.tag) {
			tags.unshift(node.tag);
		}
	}

	return tags.slice(1).join('/');
}

/** `true` and `false`, in that order */
const BOOLEAN = [ 'true', 'false' ];

/** The deploy types the build filters `<module>` entries by */
const DEPLOY_TYPES = [ 'development', 'test', 'production' ];

/**
 * The values offered for the text of an element, by where it is.
 *
 * Kept to what is commonly written, and checked against the SDK rather than the reference page:
 *
 * - `fullscreen`, `navbar-hidden` and `statusbar-hidden` are read by the Android build, and
 *   `statusbar-hidden` by the iOS build too, as booleans at the top level
 * - `use-app-thinning` and `use-autolayout` are read by the iOS build from `<ios>`
 * - a `<target>` under `<deployment-targets>` says whether the project builds for its device
 */
const TEXT_VALUES: Record<string, string[]> = {
	'fullscreen': BOOLEAN,
	'navbar-hidden': BOOLEAN,
	'statusbar-hidden': BOOLEAN,
	'ios/use-app-thinning': BOOLEAN,
	'ios/use-autolayout': BOOLEAN,
	'deployment-targets/target': BOOLEAN
};

/**
 * The units `ti.ui.defaultunit` takes: those both runtimes' `TiDimension` accept. Android also reads
 * `pt`, `sp` and `sip`, which iOS warns about and replaces with `system`, so they are not offered
 */
const UNITS = [ 'system', 'dp', 'dip', 'px', 'mm', 'cm', 'in' ];

/** The types a `<property>` is converted to, as `node-titanium-sdk`'s `tiappxml.js` converts them */
const PROPERTY_TYPES = [ 'string', 'bool', 'int', 'double' ];

/** The devices a deployment target names, as the project creator writes them and the iOS build reads them */
const DEVICES = [ 'android', 'iphone', 'ipad' ];

/**
 * The fixed values that can be written at a position: an element's text or an attribute's value,
 * where the build reads one of a short list
 *
 * @param text - The document
 * @param at - What the cursor is on
 * @param place - Where the element is, from `placeOf`
 * @param inText - Whether the cursor is in the element's own text
 * @param offset - Where the cursor is
 * @returns {ViewCompletion[]} The values, or nothing
 */
function valuesAt (text: string, at: XmlNodeAt, place: string, inText: boolean, offset: number): ViewCompletion[] {
	const { element } = at;
	const attribute = (name: string): string|undefined => element.attributes.find(candidate => candidate.name === name)?.value?.trim();

	if (inText) {
		const values = place === 'property'
			? attribute('name') === 'ti.ui.defaultunit' ? UNITS : attribute('type') === 'bool' ? BOOLEAN : []
			: Object.hasOwn(TEXT_VALUES, place) ? TEXT_VALUES[place] : [];

		return offered(values, textRange(text, element, offset));
	}

	if (at.kind !== 'attributeValue' || !at.attribute?.valueRange) {
		return [];
	}

	if (place === 'property' && at.attribute.name === 'type') {
		return offered(PROPERTY_TYPES, at.attribute.valueRange);
	}
	if (place === 'deployment-targets/target' && at.attribute.name === 'device') {
		return offered(DEVICES, at.attribute.valueRange);
	}

	return [];
}

/**
 * The entry of a comma separated list the cursor is in, and the values not already listed
 *
 * @param value - The attribute's value
 * @param range - Where the value is written
 * @param offset - Where the cursor is
 * @param values - The values the list takes
 * @returns {ViewCompletion[]} The values, replacing the entry alone
 */
function listEntryAt (value: string, range: XmlRange, offset: number, values: string[]): ViewCompletion[] {
	const within = offset - range.start;
	const from = value.lastIndexOf(',', within - 1) + 1;
	const comma = value.indexOf(',', within);
	const to = comma === -1 ? value.length : comma;

	const entry = value.slice(from, to);
	const lead = entry.length - entry.trimStart().length;
	const start = range.start + from + lead;

	const listed = new Set(value.split(',').map(listedEntry => listedEntry.trim()));
	listed.delete(entry.trim());

	return offered(values.filter(candidate => !listed.has(candidate)), { start, end: start + entry.trim().length });
}

/**
 * Fixed values as completions, in the order given
 *
 * @param values - The values
 * @param range - What each replaces
 * @returns {ViewCompletion[]} The completions
 */
function offered (values: string[], range: XmlRange): ViewCompletion[] {
	return values.map((value, index) => ({ label: value, kind: 'enum member', sortText: order(index), range }));
}

/**
 * Every module installed for the project the tiapp.xml belongs to: its own, then the global ones.
 *
 * Read on every request rather than cached. A project's modules directory changes when a module is
 * dropped into it, which is not something the CLI's answer would notice, and a few directory reads
 * per tiapp completion cost nothing.
 *
 * @param context - The tiapp.xml and the CLI
 * @returns {Promise<FoundModule[]>} Each installed version, once
 */
async function installedModules (context: TiappCompletionContext): Promise<FoundModule[]> {
	const projectModules = path.join(path.dirname(context.tiapp.path), 'modules');
	const { moduleDirectories } = await context.titanium.installed();

	const found: FoundModule[] = [];
	const seen = new Set<string>();

	for (const [ directory, scope ] of [ [ projectModules, 'project' ] as const, ...moduleDirectories.map(directory => [ directory, 'global' ] as const) ]) {
		for (const module of await readModules(directory)) {
			if (!seen.has(module.path)) {
				seen.add(module.path);
				found.push({ ...module, scope });
			}
		}
	}

	return found;
}

/**
 * One completion per module id, saying what is installed of it
 *
 * @param modules - The installed versions to offer
 * @param range - What to replace
 * @returns {ViewCompletion[]} The completions, by id
 */
function moduleIds (modules: FoundModule[], range: XmlRange): ViewCompletion[] {
	const byId = Map.groupBy(modules, module => module.id);

	return [ ...byId.keys() ].sort().map(id => {
		const versions = byId.get(id) as FoundModule[];
		const platforms = [ ...new Set(versions.map(module => module.platform)) ].sort();
		const documentation = versions
			.map(module => `${module.platform} ${module.version} (${module.scope})`)
			.sort()
			.join('\n');

		return { label: id, kind: 'module', detail: platforms.join(', '), documentation, range };
	});
}

/**
 * The platform a `<module>` element names, as the CLI would read it
 *
 * @param element - The element
 * @returns {string|undefined} The platform, if it names one
 */
function platformOf (element: XmlElement): string|undefined {
	const written = element.attributes.find(attribute => attribute.name === 'platform')?.value?.trim().toLowerCase();
	return written ? PLATFORM_ALIASES[written] ?? written : undefined;
}

/**
 * The module id a `<module>` element names, when it names one
 *
 * @param text - The document
 * @param element - The element
 * @returns {string|undefined} The id
 */
function moduleId (text: string, element: XmlElement): string|undefined {
	const span = textSpan(text, element);
	const id = span ? unescapeXml(text.slice(span.start, span.end)) : '';
	return id || undefined;
}

/**
 * What a completion in an element's text replaces: the text already written when the cursor is in
 * it, and nothing otherwise.
 *
 * Never left to the client. A version is full of dots, and a client working out what to replace
 * from its own idea of a word turns accepting `12.` into `12.12.4.0.GA`.
 *
 * @param text - The document
 * @param element - The element being typed in
 * @param offset - Where the cursor is
 * @returns {XmlRange} What to replace
 */
function textRange (text: string, element: XmlElement, offset: number): XmlRange {
	const span = textSpan(text, element);
	return span && offset >= span.start && offset <= span.end ? span : { start: offset, end: offset };
}

/**
 * Where the text directly inside an element is, without the whitespace around it.
 *
 * Read from the source rather than from the parse, which only has text for an element that was
 * closed — and the one being typed in usually is not.
 *
 * @param text - The document
 * @param element - The element
 * @returns {XmlRange|undefined} The span, or nothing when there is no text
 */
function textSpan (text: string, element: XmlElement): XmlRange|undefined {
	if (element.startTagEnd === undefined) {
		return;
	}

	const end = textEnd(text, element);
	const raw = text.slice(element.startTagEnd, end);
	const trimmed = raw.trim();
	if (!trimmed) {
		return;
	}

	const start = element.startTagEnd + raw.indexOf(trimmed);
	return { start, end: start + trimmed.length };
}

/**
 * Where the text directly inside an element stops: at the next tag, or the end of a document still
 * being typed
 *
 * @param text - The document
 * @param element - The element, whose start tag is finished
 * @returns {number} The offset
 */
function textEnd (text: string, element: XmlElement): number {
	const next = text.indexOf('<', element.startTagEnd);
	return next === -1 ? text.length : next;
}

/**
 * A sort key that keeps a list in the order it was given, which a client would otherwise sort by
 * label
 *
 * @param index - The position in the list
 * @returns {string} A key that sorts as the index does
 */
function order (index: number): string {
	return String(index).padStart(4, '0');
}

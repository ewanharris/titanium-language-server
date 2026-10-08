import path from 'node:path';
import { compareVersions, readModules } from './modules.ts';
import type { InstalledModule } from './modules.ts';
import type { TitaniumInstall } from './titanium.ts';
import type { ViewCompletion } from './view.ts';
import { inComment, nodeAt, parseXml, unescapeXml } from './xml.ts';
import type { XmlElement, XmlRange } from './xml.ts';
import type { SourceFile } from './references.ts';

/**
 * What can be written at a position in a tiapp.xml.
 *
 * Two elements, both answered from the machine rather than from the project: `<sdk-version>`
 * takes an SDK the CLI says is installed, and `<module>` takes a module installed in the project or
 * globally, with its `platform` and `version` narrowed to what is installed of it.
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

	const at = nodeAt(parseXml(tiapp.text), offset);
	if (!at) {
		return [];
	}

	// the element's own text and nowhere past it: an element's range takes in its end tag, and the
	// cursor just after `</sdk-version>` reads as inside it
	const inText = at.kind === 'text' && offset <= textEnd(tiapp.text, at.element);

	if (inText && at.element.tag === 'sdk-version') {
		const { sdks } = await context.titanium.installed();
		const range = textRange(tiapp.text, at.element, offset);

		return sdks.map((sdk, index) => ({ label: sdk.version, kind: 'enum member', detail: sdk.path, sortText: order(index), range }));
	}

	if (at.element.tag !== 'module') {
		return [];
	}

	const platform = platformOf(at.element);

	if (inText) {
		const modules = (await installedModules(context)).filter(module => !platform || module.platform === platform);
		return moduleIds(modules, textRange(tiapp.text, at.element, offset));
	}

	if (at.kind !== 'attributeValue' || !at.attribute?.valueRange) {
		return [];
	}

	const id = moduleId(tiapp.text, at.element);
	const named = (await installedModules(context)).filter(module => !id || module.id === id);
	const range = at.attribute.valueRange;

	if (at.attribute.name === 'platform') {
		const platforms = [ ...new Set(named.map(module => module.platform)) ].sort();
		return platforms.map(name => ({ label: name, kind: 'enum member', range }));
	}

	if (at.attribute.name === 'version') {
		const versions = [ ...new Set(named.filter(module => !platform || module.platform === platform).map(module => module.version)) ]
			.sort((a, b) => compareVersions(b, a));
		return versions.map((version, index) => ({ label: version, kind: 'enum member', sortText: order(index), range }));
	}

	return [];
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

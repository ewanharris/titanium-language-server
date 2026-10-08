import fs from 'node:fs/promises';
import path from 'node:path';
import { sortRules, styledElements, styles } from './cascade.ts';
import type { CascadeRule, StyledElement } from './cascade.ts';
import { handlerDefinition } from './definition.ts';
import { pathExists } from './fs.ts';
import { localisedCallAt, readTranslations, translationKeyAt } from './i18n.ts';
import { Project } from './project.ts';
import { counterpartPath, inPlatformFolder, ownStylesheet, relatedFile, stylesheetsFor } from './related.ts';
import type { SourceCache, SourceFile } from './references.ts';
import { parseTss } from './tss.ts';
import type { SelectorKind } from './tss.ts';
import { RESERVED_EVENT_REGEX } from './view.ts';
import { nodeAt, parseXml } from './xml.ts';
import type { XmlDocument, XmlElement } from './xml.ts';

/**
 * The quick fixes that write what a view names and nothing defines yet: a stylesheet rule for a
 * class, an id or a tag, a handler in the controller, a string in the default language.
 *
 * Each is offered only where what it would write does not already exist, because accepting one
 * that did inserted a duplicate — the bug in the implementation being replaced. What "exists"
 * means is decided the way the other features decide it: a rule exists if any stylesheet Alloy
 * loads for the view has a selector that styles what is under the cursor, a handler if the
 * controller declares it, a string if the default language has the key.
 *
 * What is written follows the file it is written into rather than a setting: a rule takes the
 * quotes the stylesheet's other rules use, and a string the indent of the strings beside it. It
 * lands at the end of the file after a blank line — or before `</resources>` for a string. A file
 * that does not exist yet is created, which the adapter offers only to a client that can create one.
 */

/** One insertion into one file */
export interface GeneratedEdit {
	path: string;
	/** Whether the file has to be created before the text goes into it */
	create: boolean;
	/** Where the text goes, in the file as it reads now: 0 in one being created */
	offset: number;
	text: string;
}

export interface GenerateAction {
	title: string;
	edit: GeneratedEdit;
}

/** What an action is asked: the file, where in it, and what to read from */
export interface ActionContext {
	project: Project;
	/** The view or stylesheet, as text rather than as a path, so an unsaved buffer answers */
	file: SourceFile;
	offset: number;
	cache: SourceCache;
}

/** A handler a function declaration can write: a bare name, not a member of `$` */
const FUNCTION_NAME = /^[A-Za-z_$][\w$]*$/;

/**
 * The quick fixes for a position in a view.
 *
 * @param context - The view, the position, and what to read and write with
 * @returns {Promise<GenerateAction[]>} What can be generated there, which is usually nothing
 */
export async function viewActionsAt (context: ActionContext): Promise<GenerateAction[]> {
	const { project, file, offset } = context;
	if (await project.type() !== 'alloy') {
		return [];
	}

	const document = parseXml(file.text);

	// first, because `L('` inside a value is a key whatever the attribute it is written into
	const key = translationKeyAt(document, file.text, offset);
	if (key) {
		return translationActions(context, key.key);
	}

	const at = nodeAt(document, offset);

	if (at?.kind === 'tag') {
		const styled = styledAt(file, document, at.element);
		// the type's own name is what a tag rule matches, so a <Row> in a <Picker> is a PickerRow
		const name = styled?.type.slice(styled.type.lastIndexOf('.') + 1);
		return styled && name ? styleActions(context, 'tag', name, styled) : [];
	}

	const attribute = at?.kind === 'attributeValue' ? at.attribute : undefined;
	const valueRange = attribute?.valueRange;
	if (!at || !attribute || !valueRange) {
		return [];
	}

	const { element } = at;
	const value = attribute.value ?? '';

	if (RESERVED_EVENT_REGEX.test(attribute.name)) {
		return handlerActions(context, value.trim());
	}

	const styled = styledAt(file, document, element);
	if (!styled) {
		return [];
	}

	if (attribute.name === 'id' && value) {
		return styleActions(context, 'id', value, styled);
	}

	if (attribute.name === 'class') {
		// the class under the cursor, whole, rather than the word up to it
		const within = offset - valueRange.start;
		const token = [ ...value.matchAll(/\S+/g) ].find(match => within >= match.index && within <= match.index + match[0].length);
		return token ? styleActions(context, 'class', token[0], styled) : [];
	}

	return [];
}

/**
 * The quick fixes for a position in a stylesheet: a string for a key `L()` names.
 *
 * @param context - The stylesheet, the position, and what to read and write with
 * @returns {Promise<GenerateAction[]>} What can be generated there
 */
export async function styleActionsAt (context: ActionContext): Promise<GenerateAction[]> {
	if (await context.project.type() !== 'alloy') {
		return [];
	}

	const key = localisedCallAt(context.file.text, context.offset);
	return key ? translationActions(context, key.key) : [];
}

/**
 * The element as the cascade sees it, which is what a selector is matched against
 *
 * @param view - The view
 * @param document - It, parsed
 * @param element - The element in that parse
 * @returns {StyledElement|undefined} It, or nothing for an element that creates no Titanium type
 */
function styledAt (view: SourceFile, document: XmlDocument, element: XmlElement): StyledElement|undefined {
	// styledElements parses again, so its element is found by where it starts rather than by identity
	return element.tag ? styledElements(view).find(candidate => candidate.element.range.start === element.range.start) : undefined;
}

/**
 * A rule for a selector nothing loaded for the view defines yet, at the end of the view's own
 * stylesheet.
 *
 * Every stylesheet Alloy loads for the view is searched, platform and theme ones included, and a
 * rule with a query counts: a rule that styles the element somewhere is one the user meant, and
 * one more would be a duplicate to them.
 *
 * @param context - The view and what to read and write with
 * @param kind - What the selector names
 * @param name - The class, the id or the type's name
 * @param element - The element it is for
 * @returns {Promise<GenerateAction[]>} The rule, or nothing when one exists
 */
async function styleActions (context: ActionContext, kind: SelectorKind, name: string, element: StyledElement): Promise<GenerateAction[]> {
	const { project, file, cache } = context;

	const rules = sortRules(await stylesheetsFor(project, file.path, cache));
	if (rules.some(rule => defines(rule, kind, name, element))) {
		return [];
	}

	const selector = kind === 'class' ? `.${name}` : kind === 'id' ? `#${name}` : name;
	const target = ownStylesheet(project, file.path);
	const quote = quoteOf((await cache.read(target)).text);

	return [ {
		title: `Generate style for ${selector} in ${inApp(project, target)}`,
		edit: await appendTo(target, `${literal(selector, quote)}: {\n}\n`, cache)
	} ];
}

/**
 * The quote a stylesheet writes its selectors in: its first quoted key's, or the double quote
 * Alloy's own generated stylesheets use
 *
 * @param text - The stylesheet
 * @returns {string} The quote
 */
function quoteOf (text: string): string {
	for (const rule of parseTss(text).rules) {
		const quote = text[rule.selector.range.start];
		if (quote === '"' || quote === '\'') {
			return quote;
		}
	}
	return '"';
}

/**
 * A string literal in a stylesheet: a key or a value, quoted and escaped
 *
 * @param text - The string
 * @param quote - The quote to write it in
 * @returns {string} The literal
 */
export function literal (text: string, quote: string): string {
	const escaped = text.replaceAll('\\', '\\\\').replaceAll(quote, `\\${quote}`).replaceAll('\n', '\\n');
	return `${quote}${escaped}${quote}`;
}

/**
 * Whether a rule is the one a generated rule would duplicate
 *
 * @param rule - A rule loaded for the view
 * @param kind - What the generated selector names
 * @param name - What it names
 * @param element - The element it is for
 * @returns {boolean} Whether it is
 */
function defines (rule: CascadeRule, kind: SelectorKind, name: string, element: StyledElement): boolean {
	return rule.selector.kind === kind && rule.selector.name === name && (kind !== 'tag' || styles(rule.selector, element));
}

/**
 * A function for a handler the controller does not declare, at the end of the controller.
 *
 * A view with no controller gets one, except under a platform folder: a controller beside that
 * view would replace the one the view shares with the other platforms, on that platform alone.
 *
 * A TypeScript controller's function takes no parameter, because one without a type does not
 * compile under `noImplicitAny`, and the event's type is not one this can name.
 *
 * @param context - The view and what to read and write with
 * @param handler - The attribute's value
 * @returns {Promise<GenerateAction[]>} The function, or nothing
 */
async function handlerActions (context: ActionContext, handler: string): Promise<GenerateAction[]> {
	const { project, file, cache } = context;
	if (!FUNCTION_NAME.test(handler)) {
		return [];
	}

	const controller = await relatedFile(project, 'controller', file.path);
	if (!controller && inPlatformFolder(project, file.path)) {
		return [];
	}

	if ((await handlerDefinition(project, file.path, handler, cache)).length) {
		return [];
	}

	const target = controller ?? counterpartPath(project, 'controller', file.path);
	if (!target) {
		return [];
	}

	return [ {
		title: `Generate function ${handler} in ${inApp(project, target)}`,
		edit: await appendTo(target, `function ${handler}(${target.endsWith('.ts') ? '' : 'e'}) {\n}\n`, cache)
	} ];
}

/**
 * A string for a key the default language does not declare, before its `</resources>`.
 *
 * The default language alone, because it is the one `L()` falls back to: a key another locale has
 * and it lacks is a string missing for every device that falls back. `defaultLanguage` says which.
 *
 * @param context - What to read and write with
 * @param key - The key
 * @returns {Promise<GenerateAction[]>} The string, or nothing
 */
async function translationActions (context: ActionContext, key: string): Promise<GenerateAction[]> {
	const { project, cache } = context;
	if (!key) {
		return [];
	}

	const language = await defaultLanguage(project);

	const translations = await readTranslations(project, cache);
	if (translations.some(translation => translation.locale === language && translation.key === key)) {
		return [];
	}

	const i18n = await project.i18nPath();
	const target = path.join(i18n, language, 'strings.xml');
	const title = `Generate i18n string ${key} in ${path.relative(path.dirname(i18n), target).split(path.sep).join('/')}`;

	const exists = await pathExists(target);
	const { text } = await cache.read(target);

	// indented as the strings already there are, a tab when there are none to go by
	const indent = /^([ \t]*)<string\b/m.exec(text)?.[1] ?? '\t';
	const entry = `${indent}<string name="${escapeXml(key)}"></string>\n`;

	// a file with nothing in it is a file to fill, as one that is not there is
	if (!exists || !text.trim()) {
		return [ {
			title,
			edit: { path: target, create: !exists, offset: 0, text: `<?xml version="1.0" encoding="UTF-8"?>\n<resources>\n${entry}</resources>\n` }
		} ];
	}

	const end = text.lastIndexOf('</resources>');
	return end < 0 ? [] : [ { title, edit: { path: target, create: false, offset: end, text: entry } } ];
}

/**
 * The language a project's strings fall back to, and so the one a missing string is written into.
 *
 * Titanium builds `en` as the fallback — Android's `values/` and iOS's development region — so it
 * is the answer whenever the project has it. A project without it that has one language means
 * that one; with several and no `en`, nothing tells them apart, and `en` is what the build would
 * fall back to anyway.
 *
 * @param project - The project
 * @returns {Promise<string>} The locale folder's name
 */
export async function defaultLanguage (project: Project): Promise<string> {
	let entries;
	try {
		entries = await fs.readdir(await project.i18nPath(), { withFileTypes: true });
	} catch {
		return 'en';
	}

	const locales = entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
	return !locales.includes('en') && locales.length === 1 ? locales[0] : 'en';
}

/**
 * Text added at the end of a file, after a blank line
 *
 * @param target - The file, which may not exist yet
 * @param text - What to add
 * @param cache - Where it is read from, so an unsaved buffer decides where the end is
 * @returns {Promise<GeneratedEdit>} The edit
 */
async function appendTo (target: string, text: string, cache: SourceCache): Promise<GeneratedEdit> {
	const exists = await pathExists(target);
	const current = (await cache.read(target)).text;

	return {
		path: target,
		create: !exists,
		offset: current.length,
		text: `${!current.length || current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n'}${text}`
	};
}

/**
 * A path as a title shows it: from `app/`, with forward slashes on every platform
 *
 * @param project - The project
 * @param file - The file
 * @returns {string} The path
 */
function inApp (project: Project, file: string): string {
	return path.relative(path.join(project.filePath, 'app'), file).split(path.sep).join('/');
}

/**
 * Text as it can sit in an attribute
 *
 * @param text - The text
 * @returns {string} It, with what XML reads as markup escaped
 */
function escapeXml (text: string): string {
	return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
}

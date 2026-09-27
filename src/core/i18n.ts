import fs from 'node:fs/promises';
import path from 'node:path';
import { Project } from './project.ts';
import type { SourceCache } from './references.ts';
import { nodeAt, parseXml } from './xml.ts';
import type { XmlDocument, XmlRange } from './xml.ts';

/**
 * The translations a project has, read from its `strings.xml` files.
 *
 * Titanium keeps one directory per locale — `i18n/en/strings.xml`, `i18n/fr/strings.xml` — and
 * `L('key')` resolves against the device's locale with a fallback to the default language. So a
 * key is worth offering if *any* locale declares it: the file being edited may be the one that
 * does not yet, and that is exactly when the completion is most useful.
 *
 * Where the project keeps them differs by project type, and `Project.i18nPath` is what knows.
 * Classic puts `i18n/` beside `tiapp.xml`; Alloy puts it under `app/`.
 *
 * Each entry carries where its name is written, because the key alone is only half of what this is
 * for. Completions want the keys; a definition wants to land on the string that declares one.
 *
 * Read through the shared `SourceCache`, so a translation file open in the editor answers with what
 * the user has typed rather than what was last saved.
 */

export interface Translation {
	/** The `name` the string is declared under, which is what `L()` takes */
	key: string;
	/** The translated text */
	value: string;
	/** The locale directory it was found in, such as `en` */
	locale: string;
	/** The `strings.xml` it was read from */
	path: string;
	/** Where the key is written in that file, without its quotes */
	range: { start: number; end: number };
}

/**
 * Every translation the project declares, across every locale.
 *
 * Never throws. A missing `i18n` directory, a locale directory with no `strings.xml`, and a file
 * being typed all yield what there is rather than an error — a project need not be translated at
 * all, and a half-written file is the normal case while someone is editing one.
 *
 * @param project - The project to read
 * @param cache - Where open buffers come from, shared with the rest of the analysis
 * @returns {Promise<Translation[]>} Every string, by locale
 */
export async function readTranslations (project: Project, cache: SourceCache): Promise<Translation[]> {
	const root = await project.i18nPath();

	let locales;
	try {
		locales = await fs.readdir(root, { withFileTypes: true });
	} catch {
		// an untranslated project is a normal project
		return [];
	}

	const translations: Translation[] = [];

	for (const locale of locales) {
		if (!locale.isDirectory()) {
			continue;
		}

		const file = path.join(root, locale.name, 'strings.xml');
		// read answers empty for a file that is not there, which is what a locale directory
		// holding something else looks like
		const { text } = await cache.read(file);

		for (const element of parseXml(text).elements) {
			if (element.tag !== 'string') {
				continue;
			}

			const name = element.attributes.find(attribute => attribute.name === 'name');
			// a string still being typed has no name yet, and one written `name=""` names nothing.
			// Neither is a key, and inventing one would put an empty entry in every completion list
			if (!name?.value || !name.valueRange) {
				continue;
			}

			translations.push({
				key: name.value,
				value: element.text ?? '',
				locale: locale.name,
				path: file,
				range: { start: name.valueRange.start, end: name.valueRange.end }
			});
		}
	}

	return translations;
}

/**
 * The distinct keys across every locale, sorted.
 *
 * Sorted rather than in the order they were read, because this feeds a generated declaration and
 * an order that moved with the file system would rewrite it — and so re-parse it — for no reason.
 *
 * @param translations - Every translation read
 * @returns {string[]} Each key once
 */
export function translationKeys (translations: Translation[]): string[] {
	return [ ...new Set(translations.map(translation => translation.key)) ].sort();
}

/**
 * A Titanium property that takes a translation key rather than text.
 *
 * `titleid`, `textid`, `hinttextid`, `messageid` and the rest: the property's name and `id`, all in
 * lower case. Read off the shape rather than listed because every one `@types/titanium` 13.3.0
 * declares has it — nine names — and `bindId` and `itemId`, the two attributes that end in an id
 * and are not keys, are camel cased and so fall outside it.
 */
const TRANSLATION_ATTRIBUTE = /^[a-z]+id$/;

/**
 * `L('key')` and `L("key")`, with the key captured so its span can be worked out.
 *
 * A key stops at whitespace, a `<` or a `)` as well as at its closing quote. A key never holds
 * one — it is a resource name — and one still being typed has no closing quote yet, so without
 * them `L('gre</Label>` would read the end tag as part of the key.
 */
const LOCALISED_CALL = /L\(\s*(['"])([^'"\s<>)]*)\1?/g;

/**
 * Whether an attribute's value is a translation key
 *
 * @param name - The attribute name
 * @returns {boolean} Whether its value names a key
 */
export function isTranslationAttribute (name: string): boolean {
	return name !== 'id' && TRANSLATION_ATTRIBUTE.test(name);
}

/**
 * The translation key a view names at an offset, and where it is written.
 *
 * Two places one is written: as the whole value of an attribute that takes a key, and inside an
 * `L()` call — which Alloy accepts in an attribute value and in an element's text alike, and which
 * no XML parser sees inside, so that one is found in the text. The span is the key alone, without
 * its quotes, which is what a definition or a hover highlights.
 *
 * @param document - The parsed view
 * @param text - Its source
 * @param offset - Where the cursor is
 * @returns The key and its span, when the cursor is on one
 */
export function translationKeyAt (document: XmlDocument, text: string, offset: number): { key: string; range: XmlRange }|undefined {
	const at = nodeAt(document, offset);
	if (at?.kind === 'attributeValue' && at.attribute?.valueRange && isTranslationAttribute(at.attribute.name)) {
		return { key: at.attribute.value ?? '', range: at.attribute.valueRange };
	}

	for (const call of text.matchAll(LOCALISED_CALL)) {
		// the first quote in the match is the opening one: nothing before it in `L(` can be a quote
		const start = call.index + call[0].indexOf(call[1]) + 1;
		const range = { start, end: start + call[2].length };
		if (offset >= range.start && offset <= range.end) {
			return { key: call[2], range };
		}
	}
}

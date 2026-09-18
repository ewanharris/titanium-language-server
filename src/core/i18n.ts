import fs from 'node:fs/promises';
import path from 'node:path';
import { Project } from './project.ts';
import type { SourceCache } from './references.ts';
import { parseXml } from './xml.ts';

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

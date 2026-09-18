import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Project } from '../../core/project.ts';
import { SourceCache } from '../../core/references.ts';
import { readTranslations, translationKeys } from '../../core/i18n.ts';
import { fixturePath } from '../fixtures.ts';

/**
 * Loads a fixture project
 *
 * @param name - The fixture directory name
 * @returns {Promise<Project>} The loaded project
 */
async function project (name: string): Promise<Project> {
	const loaded = new Project(await fixturePath(name));
	await loaded.load();
	return loaded;
}

describe('Reading the translations', () => {

	it('should read the strings of an Alloy project from app/i18n', async () => {
		const loaded = await project('alloy-project');

		const found = await readTranslations(loaded, new SourceCache());

		assert.deepEqual(
			found.filter(entry => entry.locale === 'en').map(entry => entry.key).sort(),
			[ 'test', 'untranslated', 'welcome.title' ]
		);
	});

	it('should read the strings of a classic project from the i18n at the root', async () => {
		// classic keeps i18n beside tiapp.xml rather than under app/, and an Alloy-only fixture
		// would never notice the difference
		const loaded = await project('classic-project');

		const found = await readTranslations(loaded, new SourceCache());

		assert.deepEqual(found.map(entry => entry.key).sort(), [ 'classicOnly', 'test' ]);
		assert.ok(found.every(entry => entry.path.startsWith(path.join(loaded.filePath, 'i18n'))),
			'expected the classic i18n directory');
	});

	it('should carry the value and the locale, which is what makes a key worth showing', async () => {
		const found = await readTranslations(await project('alloy-project'), new SourceCache());
		const french = found.find(entry => entry.key === 'test' && entry.locale === 'fr');

		assert.equal(french?.value, 'Une chaîne de test');
	});

	it('should carry where the name is written, so a definition can point at it', async () => {
		// this is what #17 needs of it: a jump from `L('test')` lands on the string that declares it
		const found = await readTranslations(await project('alloy-project'), new SourceCache());
		const english = found.find(entry => entry.key === 'test' && entry.locale === 'en');
		assert.ok(english, 'expected the English string');

		const source = await new SourceCache().read(english.path);

		assert.equal(source.text.slice(english.range.start, english.range.end), 'test');
	});

	it('should read an open buffer rather than what is on disk', async () => {
		// the same rule as everywhere else: reading disk is wrong by one keystroke
		const loaded = await project('alloy-project');
		const cache = new SourceCache();
		const file = path.join(loaded.filePath, 'app', 'i18n', 'en', 'strings.xml');
		cache.override(file, '<resources><string name="justTyped">New</string></resources>');

		const found = await readTranslations(loaded, cache);

		assert.ok(found.some(entry => entry.key === 'justTyped'), 'expected the unsaved key');
		assert.ok(!found.some(entry => entry.key === 'untranslated' && entry.locale === 'en'),
			'expected the saved keys of that file to be gone');
	});

	it('should ignore anything in the i18n directory that is not a locale', async () => {
		// a readme, or the .DS_Store macOS leaves everywhere, sits beside the locale directories
		// and is not one
		const found = await readTranslations(await project('alloy-project'), new SourceCache());

		assert.deepEqual([ ...new Set(found.map(entry => entry.locale)) ].sort(), [ 'en', 'fr' ]);
	});

	it('should answer nothing for a project with no translations at all', async () => {
		assert.deepEqual(await readTranslations(await project('no-sdk-project'), new SourceCache()), []);
	});

	it('should ignore a string with no name rather than inventing a key for it', async () => {
		const loaded = await project('alloy-project');
		const cache = new SourceCache();
		cache.override(
			path.join(loaded.filePath, 'app', 'i18n', 'en', 'strings.xml'),
			'<resources><string>No name</string><string name="">Empty</string><string name="real">Yes</string></resources>'
		);

		const keys = (await readTranslations(loaded, cache)).filter(entry => entry.locale === 'en').map(entry => entry.key);

		assert.deepEqual(keys, [ 'real' ]);
	});

	it('should read what parsed from a half-written file rather than nothing', async () => {
		// a user editing a translation file is the normal case, not an error
		const loaded = await project('alloy-project');
		const cache = new SourceCache();
		cache.override(
			path.join(loaded.filePath, 'app', 'i18n', 'en', 'strings.xml'),
			'<resources><string name="first">One</string><string name="second'
		);

		const keys = (await readTranslations(loaded, cache)).filter(entry => entry.locale === 'en').map(entry => entry.key);

		assert.ok(keys.includes('first'), 'expected the string that is complete');
	});

	describe('the keys', () => {

		it('should be the union across every locale, deduplicated', async () => {
			// a key is worth offering if any locale has it: the one being edited may be the one
			// that does not, and Titanium falls back to the default language at run time
			const found = await readTranslations(await project('alloy-project'), new SourceCache());

			assert.deepEqual(translationKeys(found), [ 'test', 'untranslated', 'welcome.title' ]);
		});

		it('should be sorted, so the generated declaration does not churn', async () => {
			const keys = translationKeys([
				{ key: 'b', value: '', locale: 'en', path: '', range: { start: 0, end: 0 } },
				{ key: 'a', value: '', locale: 'fr', path: '', range: { start: 0, end: 0 } },
				{ key: 'b', value: '', locale: 'fr', path: '', range: { start: 0, end: 0 } }
			]);

			assert.deepEqual(keys, [ 'a', 'b' ]);
		});
	});
});

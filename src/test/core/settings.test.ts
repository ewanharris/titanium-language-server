import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { expandTemplate, readSettings } from '../../core/settings.ts';

describe('Reading the settings', () => {

	it('should answer vscode-titanium\'s defaults when the client supplies nothing', () => {
		// the same strings vscode-titanium declares in its package.json, escapes and all, so a user
		// who never touched them gets what they got before
		assert.deepEqual(readSettings(undefined), {
			codeTemplates: {
				jsFunction: '\\nfunction ${text}(e){\\n}\\n',
				tssClass: '\\n\'.${text}\': {\\n}\\n',
				tssId: '\\n\'#${text}\': {\\n}\\n',
				tssTag: '\\n\'${text}\': {\\n}\\n'
			},
			project: { defaultI18nLanguage: 'en' }
		});
	});

	it('should read each setting from the titanium section', () => {
		const read = readSettings({
			codeTemplates: { jsFunction: 'function ${text}() {}', tssClass: '".${text}": {}', tssId: '"#${text}": {}', tssTag: '"${text}": {}' },
			project: { defaultI18nLanguage: 'fr' }
		});

		assert.deepEqual(read, {
			codeTemplates: { jsFunction: 'function ${text}() {}', tssClass: '".${text}": {}', tssId: '"#${text}": {}', tssTag: '"${text}": {}' },
			project: { defaultI18nLanguage: 'fr' }
		});
	});

	it('should take each setting it is not given from the fallback, one by one', () => {
		// a client that answers for one setting has not unset the others: initializationOptions
		// stay the base that configuration overrides
		const base = readSettings({ codeTemplates: { tssId: 'base id' }, project: { defaultI18nLanguage: 'de' } });

		const read = readSettings({ codeTemplates: { tssClass: 'class' } }, base);

		assert.equal(read.codeTemplates.tssClass, 'class');
		assert.equal(read.codeTemplates.tssId, 'base id');
		assert.equal(read.codeTemplates.tssTag, readSettings(undefined).codeTemplates.tssTag);
		assert.equal(read.project.defaultI18nLanguage, 'de');
	});

	it('should ignore a value of the wrong type, or an empty one, as vscode-titanium does', () => {
		const read = readSettings({ codeTemplates: { jsFunction: 42, tssClass: '' }, project: 'fr' });

		assert.deepEqual(read, readSettings(undefined));
	});

	it('should ignore a section that is not an object', () => {
		// neovim answers null for a section it has nothing for, and a client may send anything
		for (const section of [ null, 'titanium', 7, [ 'fr' ] ]) {
			assert.deepEqual(readSettings(section), readSettings(undefined), JSON.stringify(section));
		}
	});

	it('should only take a language that names one directory', () => {
		// the language names a directory under i18n that a generated string is written into, so a
		// path in it would write outside the project
		for (const language of [ '../../etc', 'en/strings', '..', 'en\\fr', ' en' ]) {
			assert.equal(readSettings({ project: { defaultI18nLanguage: language } }).project.defaultI18nLanguage, 'en', language);
		}

		for (const language of [ 'en-GB', 'zh-Hans', 'pt_BR' ]) {
			assert.equal(readSettings({ project: { defaultI18nLanguage: language } }).project.defaultI18nLanguage, language);
		}
	});
});

describe('Expanding a code template', () => {

	it('should put the name where the template says and turn \\n into a line break', () => {
		assert.equal(expandTemplate(readSettings(undefined).codeTemplates.tssClass, 'title'), '\n\'.title\': {\n}\n');
		assert.equal(expandTemplate(readSettings(undefined).codeTemplates.jsFunction, 'onClick'), '\nfunction onClick(e){\n}\n');
	});

	it('should put the name in every place the template names it', () => {
		assert.equal(expandTemplate('${text} = ${text}', 'a'), 'a = a');
	});

	it('should leave a real line break in a template alone', () => {
		assert.equal(expandTemplate('".${text}": {\n}', 'a'), '".a": {\n}');
	});

	it('should insert the name as it is, whatever characters it holds', () => {
		// a replacement string gives `$&` and `$'` a meaning, which a name must not have
		assert.equal(expandTemplate('"#${text}"', '$&$\''), '"#$&$\'"');
	});
});

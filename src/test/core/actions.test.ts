import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultLanguage, styleActionsAt, viewActionsAt } from '../../core/actions.ts';
import type { GenerateAction } from '../../core/actions.ts';
import { Project } from '../../core/project.ts';
import { SourceCache } from '../../core/references.ts';
import { fixturePath } from '../fixtures.ts';

describe('Code actions in a view', () => {

	let project: Project;
	let root: string;

	const inApp = (...segments: string[]): string => path.join(root, 'app', ...segments);

	before(async () => {
		root = await fixturePath('alloy-project');
		project = new Project(root);
		await project.load();
	});

	/**
	 * The actions offered where `|` marks the cursor
	 *
	 * @param text - The view, with `|` marking the cursor
	 * @param options - Where the view is and what the cache holds
	 * @returns {Promise<GenerateAction[]>} What is offered
	 */
	const actionsAt = (text: string, options: { view?: string; cache?: SourceCache } = {}): Promise<GenerateAction[]> =>
		viewActionsAt({
			project,
			file: { path: options.view ?? inApp('views', 'index.xml'), text: text.replace('|', '') },
			offset: text.indexOf('|'),
			cache: options.cache ?? new SourceCache()
		});

	/** What appending to a file inserts: the text, after a blank line */
	const appended = (existing: string, text: string): string =>
		`${!existing.length || existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n'}${text}`;

	describe('generating a style for a class', () => {
		it('should offer a rule for a class nothing styles, at the end of the view\'s stylesheet', async () => {
			const cache = new SourceCache();
			const stylesheet = (await cache.read(inApp('styles', 'index.tss'))).text;

			const [ action, ...rest ] = await actionsAt('<Alloy><Window class="container fre|sh"/></Alloy>', { cache });

			assert.deepEqual(rest, []);
			assert.equal(action.title, 'Generate style for .fresh in styles/index.tss');
			assert.deepEqual(action.edit, {
				path: inApp('styles', 'index.tss'),
				create: false,
				offset: stylesheet.length,
				text: appended(stylesheet, '".fresh": {\n}\n')
			});
		});

		it('should take the whole class, wherever the cursor is in it', async () => {
			// the implementation being replaced cut the word at the cursor, so `noexi|stid`
			// generated `.noexi`
			const [ action ] = await actionsAt('<Alloy><Window class="noexi|stclass"/></Alloy>');

			assert.match(action.edit.text, /"\.noexistclass"/);
		});

		it('should not offer a class the view\'s own stylesheet already styles', async () => {
			// offering it was the other bug: accepting inserted a duplicate rule
			assert.deepEqual(await actionsAt('<Alloy><Window class="cont|ainer"/></Alloy>'), []);
		});

		it('should not offer a class app.tss already styles', async () => {
			assert.deepEqual(await actionsAt('<Alloy><Window class="third|Class"/></Alloy>'), []);
		});

		it('should not offer a class one part of a comma separated key styles', async () => {
			const cache = new SourceCache();
			cache.override(inApp('styles', 'index.tss'), '".other, .shared": { color: "red" }');

			assert.deepEqual(await actionsAt('<Alloy><Window class="sha|red"/></Alloy>', { cache }), []);
		});

		it('should not offer a class a rule with a query styles', async () => {
			const cache = new SourceCache();
			cache.override(inApp('styles', 'index.tss'), '".tablet[formFactor=tablet]": { color: "red" }');

			assert.deepEqual(await actionsAt('<Alloy><Window class="tab|let"/></Alloy>', { cache }), []);
		});

		it('should offer nothing between classes', async () => {
			assert.deepEqual(await actionsAt('<Alloy><Window class="one | two"/></Alloy>'), []);
		});

		it('should quote the selector the way the stylesheet already does', async () => {
			const cache = new SourceCache();
			cache.override(inApp('styles', 'index.tss'), '\'Label\': {\n\tcolor: \'red\'\n}\n');

			const [ action ] = await actionsAt('<Alloy><Window class="fre|sh"/></Alloy>', { cache });

			assert.equal(action.edit.text, '\n\'.fresh\': {\n}\n');
		});

		it('should go after a blank line, however the stylesheet ends', async () => {
			for (const [ existing, prefix ] of [ [ '"a": {}', '\n\n' ], [ '"a": {}\n', '\n' ], [ '"a": {}\n\n', '' ] ]) {
				const cache = new SourceCache();
				cache.override(inApp('styles', 'index.tss'), existing);

				const [ action ] = await actionsAt('<Alloy><Window class="fre|sh"/></Alloy>', { cache });

				assert.equal(action.edit.text, `${prefix}".fresh": {\n}\n`, JSON.stringify(existing));
			}
		});

		it('should create the stylesheet when the view has none', async () => {
			const [ action ] = await actionsAt('<Alloy><Window class="fre|sh"/></Alloy>', { view: inApp('views', 'unstyled.xml') });

			assert.deepEqual(action.edit, {
				path: inApp('styles', 'unstyled.tss'),
				create: true,
				offset: 0,
				text: '".fresh": {\n}\n'
			});
		});

		it('should write into a widget\'s own stylesheet', async () => {
			const [ action ] = await actionsAt('<Alloy><Label class="fre|sh"/></Alloy>', { view: inApp('widgets', 'widget-test', 'views', 'widget.xml') });

			assert.equal(action.edit.path, inApp('widgets', 'widget-test', 'styles', 'widget.tss'));
			assert.equal(action.title, 'Generate style for .fresh in widgets/widget-test/styles/widget.tss');
		});

		it('should write a view under a platform folder\'s rule into the stylesheet Alloy styles it from', async () => {
			// Alloy strips the platform folder before looking for a view's stylesheet
			const [ action ] = await actionsAt('<Alloy><Window class="fre|sh"/></Alloy>', { view: inApp('views', 'ios', 'index.xml') });

			assert.equal(action.edit.path, inApp('styles', 'index.tss'));
		});
	});

	describe('generating a style for an id', () => {
		it('should offer a rule for an id nothing styles', async () => {
			const [ action ] = await actionsAt('<Alloy><Window><Label id="head|ing"/></Window></Alloy>');

			assert.equal(action.title, 'Generate style for #heading in styles/index.tss');
			assert.match(action.edit.text, /"#heading": \{\n\}/);
		});

		it('should not offer an id already styled', async () => {
			assert.deepEqual(await actionsAt('<Alloy><Window><Label id="lab|el"/></Window></Alloy>'), []);
		});

	});

	describe('generating a style for a tag', () => {
		it('should offer a rule for a tag nothing styles', async () => {
			const [ action ] = await actionsAt('<Alloy><Window><But|ton/></Window></Alloy>');

			assert.equal(action.title, 'Generate style for Button in styles/index.tss');
			assert.match(action.edit.text, /"Button": \{\n\}/);
		});

		it('should not offer a tag already styled', async () => {
			assert.deepEqual(await actionsAt('<Alloy><Window><La|bel/></Window></Alloy>'), []);
		});

		it('should name the rule for the type the element creates, which is what a tag rule matches', async () => {
			// a <Row> in a <Picker> is a PickerRow, and a "Row" rule would style nothing
			const [ action ] = await actionsAt('<Alloy><Picker><Column><Ro|w/></Column></Picker></Alloy>');

			assert.equal(action.title, 'Generate style for PickerRow in styles/index.tss');
		});

		it('should offer nothing for Alloy\'s own markup', async () => {
			for (const view of [ '<All|oy/>', '<Alloy><Requ|ire src="a"/></Alloy>', '<Alloy><Widg|et src="a"/></Alloy>', '<Alloy><Mod|el src="a"/></Alloy>' ]) {
				assert.deepEqual(await actionsAt(view), [], view);
			}
		});

		it('should offer nothing on a closing tag', async () => {
			assert.deepEqual(await actionsAt('<Alloy><Window></Win|dow></Alloy>'), []);
		});
	});

	describe('generating a handler', () => {
		it('should offer a function the controller does not declare, at the end of the controller', async () => {
			const cache = new SourceCache();
			const controller = (await cache.read(inApp('controllers', 'index.js'))).text;

			const [ action, ...rest ] = await actionsAt('<Alloy><Window onOpen="onO|pen"/></Alloy>', { cache });

			assert.deepEqual(rest, []);
			assert.equal(action.title, 'Generate function onOpen in controllers/index.js');
			assert.deepEqual(action.edit, {
				path: inApp('controllers', 'index.js'),
				create: false,
				offset: controller.length,
				text: appended(controller, 'function onOpen(e) {\n}\n')
			});
		});

		it('should not offer one the controller declares', async () => {
			assert.deepEqual(await actionsAt('<Alloy><Label onClick="doCl|ick"/></Alloy>'), []);
		});

		it('should not offer one the controller declares as a variable, or in its unsaved buffer', async () => {
			const cache = new SourceCache();
			cache.override(inApp('controllers', 'index.js'), 'const onOpen = () => {};');

			assert.deepEqual(await actionsAt('<Alloy><Window onOpen="onO|pen"/></Alloy>', { cache }), []);
		});

		it('should offer nothing for a handler on $, which a function declaration cannot write', async () => {
			assert.deepEqual(await actionsAt('<Alloy><Window onOpen="$.onO|pen"/></Alloy>'), []);
		});

		it('should leave the parameter out of a TypeScript controller, which would need a type for it', async () => {
			// ts-lookup has a controller in both languages, and the TypeScript one wins
			const [ action ] = await actionsAt('<Alloy><Window onOpen="onO|pen"/></Alloy>', { view: inApp('views', 'ts-lookup.xml') });

			assert.equal(action.edit.path, inApp('controllers', 'ts-lookup.ts'));
			assert.match(action.edit.text, /function onOpen\(\) \{\n\}\n$/);
		});

		it('should create the controller when the view has none', async () => {
			const [ action ] = await actionsAt('<Alloy><Window onOpen="onO|pen"/></Alloy>', { view: inApp('views', 'unstyled.xml') });

			assert.equal(action.edit.path, inApp('controllers', 'unstyled.js'));
			assert.equal(action.edit.create, true);
		});

		it('should not create a controller for a view under a platform folder', async () => {
			// a controller beside it would replace the view's own controller on that platform
			assert.deepEqual(await actionsAt('<Alloy><Window onOpen="onO|pen"/></Alloy>', { view: inApp('views', 'ios', 'unstyled.xml') }), []);
		});

		it('should take an event under a platform prefix', async () => {
			const [ action ] = await actionsAt('<Alloy><Window ios:onOpen="onO|pen"/></Alloy>');

			assert.match(action.title, /onOpen/);
		});
	});

	describe('generating a translation', () => {
		it('should offer a key the default language does not declare, before </resources>', async () => {
			const cache = new SourceCache();
			const strings = (await cache.read(inApp('i18n', 'en', 'strings.xml'))).text;

			const [ action, ...rest ] = await actionsAt('<Alloy><Label text="L(\'fre|sh\')"/></Alloy>', { cache });

			assert.deepEqual(rest, []);
			assert.equal(action.title, 'Generate i18n string fresh in i18n/en/strings.xml');
			assert.deepEqual(action.edit, {
				path: inApp('i18n', 'en', 'strings.xml'),
				create: false,
				offset: strings.lastIndexOf('</resources>'),
				text: '\t<string name="fresh"></string>\n'
			});
		});

		it('should offer one from an attribute that takes a key', async () => {
			const [ action ] = await actionsAt('<Alloy><Window titleid="fre|sh"/></Alloy>');

			assert.match(action.edit.text, /name="fresh"/);
		});

		it('should not offer a key the default language declares', async () => {
			assert.deepEqual(await actionsAt('<Alloy><Label text="L(\'welcome.ti|tle\')"/></Alloy>'), []);
		});

		it('should not offer a key the default language declares and another lacks', async () => {
			// untranslated is in en alone: fr falling back to it is what L() does
			assert.deepEqual(await actionsAt('<Alloy><Label text="L(\'untrans|lated\')"/></Alloy>'), []);
		});

		it('should indent the string as the file\'s other strings are', async () => {
			const cache = new SourceCache();
			cache.override(inApp('i18n', 'en', 'strings.xml'), '<resources>\n    <string name="a">A</string>\n</resources>\n');

			const [ action ] = await actionsAt('<Alloy><Label text="L(\'fre|sh\')"/></Alloy>', { cache });

			assert.equal(action.edit.text, '    <string name="fresh"></string>\n');
		});

		it('should create strings.xml for a project with no translations', async () => {
			const themedRoot = await fixturePath('alloy-themed-project');
			const themed = new Project(themedRoot);
			await themed.load();
			const text = '<Alloy><Label text="L(\'fresh\')"/></Alloy>';

			const [ action ] = await viewActionsAt({
				project: themed,
				file: { path: path.join(themedRoot, 'app', 'views', 'index.xml'), text },
				offset: text.indexOf('fresh'),
				cache: new SourceCache()
			});

			assert.equal(action.title, 'Generate i18n string fresh in i18n/en/strings.xml');
			assert.deepEqual(action.edit, {
				path: path.join(themedRoot, 'app', 'i18n', 'en', 'strings.xml'),
				create: true,
				offset: 0,
				text: '<?xml version="1.0" encoding="UTF-8"?>\n<resources>\n\t<string name="fresh"></string>\n</resources>\n'
			});
		});

		it('should fill an empty strings.xml rather than look for an end tag in it', async () => {
			const cache = new SourceCache();
			cache.override(inApp('i18n', 'en', 'strings.xml'), '');

			const [ action ] = await actionsAt('<Alloy><Label text="L(\'fre|sh\')"/></Alloy>', { cache });

			assert.equal(action.edit.create, false);
			assert.match(action.edit.text, /^<\?xml[\s\S]*<\/resources>\n$/);
		});

		it('should offer nothing when strings.xml has nowhere to put it', async () => {
			const cache = new SourceCache();
			cache.override(inApp('i18n', 'en', 'strings.xml'), '<resources>\n\t<string name="a">A</string>');

			assert.deepEqual(await actionsAt('<Alloy><Label text="L(\'fre|sh\')"/></Alloy>', { cache }), []);
		});

		it('should escape what a key holds that XML would read as markup', async () => {
			const [ action ] = await actionsAt('<Alloy><Label text="L(\'a&|b\')"/></Alloy>');

			assert.equal(action.edit.text, '\t<string name="a&amp;b"></string>\n');
		});
	});

	it('should offer nothing in a classic project', async () => {
		const classicRoot = await fixturePath('classic-project');
		const classic = new Project(classicRoot);
		await classic.load();

		const found = await viewActionsAt({
			project: classic,
			file: { path: path.join(classicRoot, 'app', 'views', 'index.xml'), text: '<Alloy><Window class="fresh"/></Alloy>' },
			offset: 25,
			cache: new SourceCache()
		});

		assert.deepEqual(found, []);
	});

	it('should offer nothing where there is nothing to generate', async () => {
		assert.deepEqual(await actionsAt('<Alloy><Label text="He|llo"/></Alloy>'), []);
		assert.deepEqual(await actionsAt('<Alloy><Label>Hel|lo</Label></Alloy>'), []);
	});

	it('should offer no style for markup no stylesheet reaches', async () => {
		// a <Require> creates no Titanium type of its own, so nothing a rule names styles it
		assert.deepEqual(await actionsAt('<Alloy><Require src="a" class="fre|sh"/></Alloy>'), []);
	});

	it('should offer no string for a key not written yet', async () => {
		assert.deepEqual(await actionsAt('<Alloy><Label text="L(\'|\')"/></Alloy>'), []);
	});
});

describe('Code actions in a stylesheet', () => {

	let project: Project;
	let root: string;

	before(async () => {
		root = await fixturePath('alloy-project');
		project = new Project(root);
		await project.load();
	});

	const actionsAt = (text: string): Promise<GenerateAction[]> =>
		styleActionsAt({
			project,
			file: { path: path.join(root, 'app', 'styles', 'index.tss'), text: text.replace('|', '') },
			offset: text.indexOf('|'),
			cache: new SourceCache()
		});

	it('should offer a translation for a key in L()', async () => {
		const [ action ] = await actionsAt('"Label": { text: L(\'fre|sh\') }');

		assert.equal(action.edit.path, path.join(root, 'app', 'i18n', 'en', 'strings.xml'));
		assert.equal(action.edit.text, '\t<string name="fresh"></string>\n');
	});

	it('should not offer a key the default language declares', async () => {
		assert.deepEqual(await actionsAt('"Label": { text: L(\'te|st\') }'), []);
	});

	it('should offer nothing in a classic project', async () => {
		const classicRoot = await fixturePath('classic-project');
		const classic = new Project(classicRoot);
		await classic.load();
		const text = '"Label": { text: L(\'fresh\') }';

		const found = await styleActionsAt({
			project: classic,
			file: { path: path.join(classicRoot, 'app', 'styles', 'index.tss'), text },
			offset: text.indexOf('fresh'),
			cache: new SourceCache()
		});

		assert.deepEqual(found, []);
	});

	it('should offer nothing elsewhere', async () => {
		assert.deepEqual(await actionsAt('"La|bel": { text: "hi" }'), []);
	});
});

describe('The default language', () => {

	const scratch: string[] = [];

	/**
	 * A copy of an Alloy fixture with the locales given, so a project's language folders can be
	 * whatever a test needs without a fixture for each
	 *
	 * @param locales - The folders to put under app/i18n
	 * @returns {Promise<Project>} The project
	 */
	const withLocales = async (locales: string[]): Promise<Project> => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ti-ls-locales-'));
		scratch.push(root);
		await fs.cp(await fixturePath('alloy-no-widgets'), root, { recursive: true });
		for (const locale of locales) {
			await fs.mkdir(path.join(root, 'app', 'i18n', locale), { recursive: true });
			await fs.writeFile(path.join(root, 'app', 'i18n', locale, 'strings.xml'), '<resources>\n</resources>\n');
		}

		const project = new Project(root);
		await project.load();
		return project;
	};

	after(async () => {
		await Promise.all(scratch.map(root => fs.rm(root, { recursive: true, force: true })));
	});

	it('should be en when the project has it, whatever else it has', async () => {
		// Titanium builds en as the fallback: Android's values/ and iOS's development region
		assert.equal(await defaultLanguage(await withLocales([ 'de', 'en', 'fr' ])), 'en');
	});

	it('should be the only language a project without en has', async () => {
		assert.equal(await defaultLanguage(await withLocales([ 'de' ])), 'de');
	});

	it('should be en when there is nothing to tell between several', async () => {
		assert.equal(await defaultLanguage(await withLocales([ 'de', 'fr' ])), 'en');
	});

	it('should be en for a project with no translations', async () => {
		assert.equal(await defaultLanguage(await withLocales([])), 'en');
	});

	it('should read a classic project\'s i18n at its root', async () => {
		const classic = new Project(await fixturePath('classic-project'));
		await classic.load();

		assert.equal(await defaultLanguage(classic), 'en');
	});
});

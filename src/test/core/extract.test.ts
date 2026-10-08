import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { GeneratedEdit } from '../../core/actions.ts';
import { extractActionsAt } from '../../core/extract.ts';
import type { ExtractAction } from '../../core/extract.ts';
import { Project } from '../../core/project.ts';
import { SourceCache } from '../../core/references.ts';
import { fixturePath } from '../fixtures.ts';

describe('Extracting style from a view', () => {

	let project: Project;
	let root: string;

	const inApp = (...segments: string[]): string => path.join(root, 'app', ...segments);

	before(async () => {
		root = await fixturePath('alloy-project');
		project = new Project(root);
		await project.load();
	});

	/** A stylesheet that styles nothing the tests extract from, so each test says what it adds */
	const plainStyle = '"Window": {\n\tbackgroundColor: "white"\n}\n';

	interface Options {
		/** The view's own stylesheet, in place of what is on disk */
		style?: string;
		/** The view's path */
		view?: string;
		/** Where a selection ends, when the cursor is a selection */
		end?: number;
	}

	/**
	 * The extractions offered where `|` marks the cursor
	 *
	 * @param text - The view, with `|` marking the cursor
	 * @param options - The stylesheet, the view's path and a selection
	 * @returns The actions, and the cache they were found through
	 */
	const extractAt = async (text: string, options: Options = {}): Promise<{ actions: ExtractAction[]; cache: SourceCache; source: string }> => {
		const cache = new SourceCache();
		cache.override(inApp('styles', 'index.tss'), options.style ?? plainStyle);
		const source = text.replace('|', '');
		const offset = text.indexOf('|');

		const actions = await extractActionsAt({
			project,
			file: { path: options.view ?? inApp('views', 'index.xml'), text: source },
			offset,
			end: options.end ?? offset,
			cache
		});

		return { actions, cache, source };
	};

	/**
	 * A file's text once an action's edit to it is made
	 *
	 * @param text - The file as it was
	 * @param edit - The edit
	 * @returns {string} The file after
	 */
	const applied = (text: string, edit: GeneratedEdit): string =>
		text.slice(0, edit.offset) + edit.text + text.slice(edit.end ?? edit.offset);

	/**
	 * What each file reads once an action is taken
	 *
	 * @param action - The action
	 * @param cache - Where the files read from
	 * @param view - The view's text as the action was asked about
	 * @param viewPath - Where the view is
	 * @returns The view and the stylesheet afterwards
	 */
	const after = async (action: ExtractAction, cache: SourceCache, view: string, viewPath = inApp('views', 'index.xml')): Promise<{ view: string; style: string; stylePath: string }> => {
		const viewEdit = action.edits.find(edit => edit.path === viewPath);
		const styleEdit = action.edits.find(edit => edit.path !== viewPath);
		assert.ok(viewEdit && styleEdit, 'expected an edit to the view and one to the stylesheet');
		return {
			view: applied(view, viewEdit),
			style: applied(styleEdit.create ? '' : (await cache.read(styleEdit.path)).text, styleEdit),
			stylePath: styleEdit.path
		};
	};

	const byTitle = (actions: ExtractAction[]): Map<string, ExtractAction> => new Map(actions.map(action => [ action.title, action ]));

	describe('the three kinds', () => {
		const view = '<Alloy>\n\t<Window>\n\t\t<La|bel id="heading" color="red" width="100" onClick="doClick"/>\n\t</Window>\n</Alloy>';

		it('should offer a class, an id and a tag, in that order', async () => {
			const { actions } = await extractAt(view);

			assert.deepEqual(actions.map(action => action.title), [
				'Extract style to .label in styles/index.tss',
				'Extract style to #heading in styles/index.tss',
				'Extract style to Label in styles/index.tss'
			]);
		});

		it('should move the properties into a new class and give the element the class', async () => {
			const { actions, cache, source } = await extractAt(view);
			const result = await after(actions[0], cache, source);

			assert.equal(result.view, '<Alloy>\n\t<Window>\n\t\t<Label class="label" id="heading" onClick="doClick"/>\n\t</Window>\n</Alloy>');
			assert.equal(result.style, `${plainStyle}\n".label": {\n\tcolor: "red",\n\twidth: 100\n}\n`);
		});

		it('should move them into a rule for the element\'s own id, leaving the id where it is', async () => {
			const { actions, cache, source } = await extractAt(view);
			const result = await after(actions[1], cache, source);

			assert.equal(result.view, '<Alloy>\n\t<Window>\n\t\t<Label id="heading" onClick="doClick"/>\n\t</Window>\n</Alloy>');
			assert.equal(result.style, `${plainStyle}\n"#heading": {\n\tcolor: "red",\n\twidth: 100\n}\n`);
		});

		it('should move them into a rule for the type', async () => {
			const { actions, cache, source } = await extractAt(view);
			const result = await after(actions[2], cache, source);

			assert.equal(result.view, '<Alloy>\n\t<Window>\n\t\t<Label id="heading" onClick="doClick"/>\n\t</Window>\n</Alloy>');
			assert.match(result.style, /\n"Label": \{\n\tcolor: "red",\n\twidth: 100\n\}\n$/);
		});

		it('should edit the stylesheet before the view, so a failed create leaves the view as it was', async () => {
			const { actions } = await extractAt(view);

			assert.deepEqual(actions[0].edits.map(edit => path.basename(edit.path)), [ 'index.tss', 'index.xml' ]);
		});

		it('should point at the new rule, so a client can reveal it', async () => {
			const { actions, cache, source } = await extractAt(view);
			const result = await after(actions[0], cache, source);

			assert.equal(actions[0].reveal.path, inApp('styles', 'index.tss'));
			assert.equal(result.style.slice(actions[0].reveal.offset), '".label": {\n\tcolor: "red",\n\twidth: 100\n}\n');
		});

		it('should be offered from anywhere in the start tag', async () => {
			assert.equal((await extractAt(view.replace('La|bel', 'Label').replace('color="red"', 'color="r|ed"'))).actions.length, 3);
			assert.equal((await extractAt(view.replace('La|bel', 'Label').replace(' onClick', ' |onClick'))).actions.length, 3);
		});
	});

	describe('which attributes move', () => {
		it('should leave what is not a property where it is', async () => {
			// ids and classes name the element, events are listeners, a platform prefix or a
			// platform attribute limits it, and a binding is evaluated against a model
			const { actions, cache, source } = await extractAt('<Alloy><Window><La|bel id="a" class="b" color="red" onClick="c" ios:width="10" platform="ios" text="{title}" if="Alloy.Globals.x"/></Window></Alloy>');
			const result = await after(byTitle(actions).get('Extract style to Label in styles/index.tss') as ExtractAction, cache, source);

			assert.equal(result.view, '<Alloy><Window><Label id="a" class="b" onClick="c" ios:width="10" platform="ios" text="{title}" if="Alloy.Globals.x"/></Window></Alloy>');
			assert.match(result.style, /"Label": \{\n\tcolor: "red"\n\}/);
		});

		it('should move an on- property Alloy reads as a property', async () => {
			const { actions, cache, source } = await extractAt('<Alloy><Window><Swi|tch id="s" onTintColor="red" onChange="go"/></Window></Alloy>');
			const result = await after(byTitle(actions).get('Extract style to #s in styles/index.tss') as ExtractAction, cache, source);

			assert.equal(result.view, '<Alloy><Window><Switch id="s" onChange="go"/></Window></Alloy>');
			assert.match(result.style, /"#s": \{\n\tonTintColor: "red"\n\}/);
		});

		it('should leave a callback Alloy reads as a property, which names a function a stylesheet cannot', async () => {
			assert.deepEqual((await extractAt('<Alloy><Win|dow onHomeIconItemSelected="goHome"/></Alloy>')).actions, []);
		});

		it('should offer nothing when nothing would move', async () => {
			assert.deepEqual((await extractAt('<Alloy><Window><La|bel id="a" onClick="c"/></Window></Alloy>')).actions, []);
		});

		it('should move only the attributes a selection covers', async () => {
			const text = '<Alloy><Window><Label id="a" color="red" width="100"/></Window></Alloy>';
			const start = text.indexOf('color');
			const { actions, cache } = await extractAt(`${text.slice(0, start)}|${text.slice(start)}`, { end: start + 'color="red"'.length });
			const result = await after(byTitle(actions).get('Extract style to Label in styles/index.tss') as ExtractAction, cache, text);

			assert.equal(result.view, '<Alloy><Window><Label id="a" width="100"/></Window></Alloy>');
			assert.match(result.style, /"Label": \{\n\tcolor: "red"\n\}/);
		});

		it('should keep a line break that separates the attributes left', async () => {
			const text = '<Alloy>\n\t<Window>\n\t\t<La|bel\n\t\t\tid="a"\n\t\t\tcolor="red"\n\t\t/>\n\t</Window>\n</Alloy>';
			const { actions, cache, source } = await extractAt(text);
			const result = await after(byTitle(actions).get('Extract style to #a in styles/index.tss') as ExtractAction, cache, source);

			assert.equal(result.view, '<Alloy>\n\t<Window>\n\t\t<Label\n\t\t\tid="a"\n\t\t/>\n\t</Window>\n</Alloy>');
		});
	});

	describe('the values', () => {
		/** The rule's body once every attribute given is extracted to the tag */
		const body = async (attributes: string): Promise<string> => {
			const { actions, cache, source } = await extractAt(`<Alloy><Window><La|bel ${attributes}/></Window></Alloy>`);
			const result = await after(byTitle(actions).get('Extract style to Label in styles/index.tss') as ExtractAction, cache, source);
			return result.style.slice(result.style.indexOf('"Label": {') + '"Label": {'.length);
		};

		it('should read them as Alloy does: booleans, numbers, and strings for the rest', async () => {
			assert.equal(
				await body('visible="false" width="100" opacity="0.5" top="10dp" color="#fff"'),
				'\n\tvisible: false,\n\twidth: 100,\n\topacity: 0.5,\n\ttop: "10dp",\n\tcolor: "#fff"\n}\n'
			);
		});

		it('should keep an expression an expression', async () => {
			// what getParserArgs evaluates rather than quotes: Ti., Titanium., Alloy.Globals.,
			// Alloy.CFG., $.args. and L(), and Alloy quotes a key written bare in L()
			assert.equal(
				await body('height="Ti.UI.SIZE" width="Alloy.Globals.width" text="L(\'hello\')" title="L(bare)"'),
				'\n\theight: Ti.UI.SIZE,\n\twidth: Alloy.Globals.width,\n\ttext: L(\'hello\'),\n\ttitle: L("bare")\n}\n'
			);
		});

		it('should unescape what XML escaped and escape what the stylesheet needs', async () => {
			assert.equal(await body('text="a &amp; &quot;b&quot; c\\d"'), '\n\ttext: "a & \\"b\\" c\\\\d"\n}\n');
		});

		it('should nest a dotted name, as Alloy sets it', async () => {
			assert.equal(
				await body('font.fontSize="12" font.fontWeight="bold" color="red"'),
				'\n\tfont: {\n\t\tfontSize: 12,\n\t\tfontWeight: "bold"\n\t},\n\tcolor: "red"\n}\n'
			);
		});

		it('should offer nothing when a name is both a value and an object', async () => {
			assert.deepEqual((await extractAt('<Alloy><Window><La|bel font="x" font.fontSize="12"/></Window></Alloy>')).actions, []);
		});
	});

	describe('the names', () => {
		it('should pick a class no stylesheet and no element uses', async () => {
			const style = `${plainStyle}".label": { color: "blue" }\n`;
			const { actions } = await extractAt('<Alloy><Window class="label2"><La|bel color="red"/></Window></Alloy>', { style });

			assert.equal(actions[0].title, 'Extract style to .label3 in styles/index.tss');
		});

		it('should add the class to a class list the element already has', async () => {
			const { actions, cache, source } = await extractAt('<Alloy><Window><La|bel class="big" color="red"/></Window></Alloy>');
			const result = await after(actions[0], cache, source);

			assert.equal(result.view, '<Alloy><Window><Label class="big label"/></Window></Alloy>');
		});

		it('should give an element without an id a new one', async () => {
			const { actions, cache, source } = await extractAt('<Alloy><Window><Label id="label"/><La|bel color="red"/></Window></Alloy>');
			const id = byTitle(actions).get('Extract style to #label2 in styles/index.tss');
			assert.ok(id, `expected a new id, got ${actions.map(action => action.title).join(', ')}`);

			assert.equal((await after(id, cache, source)).view, '<Alloy><Window><Label id="label"/><Label id="label2"/></Window></Alloy>');
		});

		it('should style a top level element by the view\'s name, which is the id Alloy gives it', async () => {
			// adding an id would change it, and with it $.index
			const { actions, cache, source } = await extractAt('<Alloy><Win|dow backgroundColor="red"/></Alloy>');
			const id = byTitle(actions).get('Extract style to #index in styles/index.tss');
			assert.ok(id, `expected the view's name, got ${actions.map(action => action.title).join(', ')}`);

			assert.equal((await after(id, cache, source)).view, '<Alloy><Window/></Alloy>');
		});

		it('should read an id as its XML escapes stand for, as Alloy does', async () => {
			const { actions } = await extractAt('<Alloy><Window><La|bel id="heading&#50;" color="red"/></Window></Alloy>');

			assert.ok(actions.some(action => action.title === 'Extract style to #heading2 in styles/index.tss'), actions.map(action => action.title).join(', '));
		});

		it('should not offer an id that already has a rule', async () => {
			const style = `${plainStyle}"#heading": { top: 0 }\n`;
			const { actions } = await extractAt('<Alloy><Window><La|bel id="heading" color="red"/></Window></Alloy>', { style });

			assert.deepEqual(actions.map(action => action.title), [ 'Extract style to .label in styles/index.tss', 'Extract style to Label in styles/index.tss' ]);
		});

		it('should not offer a tag that already has a rule', async () => {
			const style = `${plainStyle}"Label": { top: 0 }\n`;
			const { actions } = await extractAt('<Alloy><Window><La|bel id="heading" color="red"/></Window></Alloy>', { style });

			assert.deepEqual(actions.map(action => action.title), [ 'Extract style to .label in styles/index.tss', 'Extract style to #heading in styles/index.tss' ]);
		});

		it('should name the tag rule for the type the element creates', async () => {
			const { actions } = await extractAt('<Alloy><Picker><Column><Ro|w title="a"/></Column></Picker></Alloy>');

			assert.deepEqual(actions.map(action => action.title), [
				'Extract style to .pickerRow in styles/index.tss',
				'Extract style to #pickerRow in styles/index.tss',
				'Extract style to PickerRow in styles/index.tss'
			]);
		});
	});

	describe('keeping what the element looks like', () => {
		it('should not offer a rule another rule would override', async () => {
			// an attribute beats every rule; a tag rule loses to the class the element has
			const style = `${plainStyle}".big": { color: "blue" }\n`;
			const { actions } = await extractAt('<Alloy><Window><La|bel class="big" color="red"/></Window></Alloy>', { style });

			assert.deepEqual(actions.map(action => action.title), [ 'Extract style to .label in styles/index.tss', 'Extract style to #label in styles/index.tss' ]);
		});

		it('should not offer a rule a conditional rule would override where its condition holds', async () => {
			const style = `${plainStyle}".big[platform=ios]": { color: "blue" }\n`;
			const { actions } = await extractAt('<Alloy><Window><La|bel class="big" color="red"/></Window></Alloy>', { style });

			assert.deepEqual(actions.map(action => action.title), [ 'Extract style to #label in styles/index.tss' ]);
		});
	});

	describe('the stylesheet', () => {
		it('should follow its quotes and its indent', async () => {
			const style = '\'Window\': {\n    backgroundColor: \'white\'\n}\n';
			const { actions, cache, source } = await extractAt('<Alloy><Window><La|bel color="red" text="it\'s"/></Window></Alloy>', { style });

			assert.equal((await after(actions[0], cache, source)).style, `${style}\n'.label': {\n    color: 'red',\n    text: 'it\\'s'\n}\n`);
		});

		it('should create the view\'s stylesheet when it has none', async () => {
			const viewPath = inApp('views', 'unstyled.xml');
			const { actions, cache, source } = await extractAt('<Alloy><Window><La|bel color="red"/></Window></Alloy>', { view: viewPath });
			const styleEdit = actions[0].edits.find(edit => edit.path !== viewPath);

			assert.equal(styleEdit?.path, inApp('styles', 'unstyled.tss'));
			assert.equal(styleEdit?.create, true);
			assert.equal((await after(actions[0], cache, source, viewPath)).style, '".label": {\n\tcolor: "red"\n}\n');
			assert.equal(actions[0].reveal.offset, 0);
		});
	});

	describe('where there is nothing to extract', () => {
		it('should offer nothing outside a start tag', async () => {
			assert.deepEqual((await extractAt('<Alloy><Window><Label color="red">He|llo</Label></Window></Alloy>')).actions, []);
			assert.deepEqual((await extractAt('<Alloy><Window><Label color="red"></La|bel></Window></Alloy>')).actions, []);
		});

		it('should offer nothing for Alloy\'s own markup', async () => {
			assert.deepEqual((await extractAt('<Alloy><Requ|ire src="a" color="red"/></Alloy>')).actions, []);
		});

		it('should offer nothing for a start tag still being typed', async () => {
			assert.deepEqual((await extractAt('<Alloy><Window><La|bel color="red"')).actions, []);
		});

		it('should offer nothing in a view named app, whose own stylesheet is the global one', async () => {
			// app.tss styles every view, so a rule there is not this element's alone
			assert.deepEqual((await extractAt('<Alloy><Window><La|bel color="red"/></Window></Alloy>', { view: inApp('views', 'app.xml') })).actions, []);
		});

		it('should offer nothing in a classic project', async () => {
			const classicRoot = await fixturePath('classic-project');
			const classic = new Project(classicRoot);
			await classic.load();
			const text = '<Alloy><Window><Label color="red"/></Window></Alloy>';

			const found = await extractActionsAt({
				project: classic,
				file: { path: path.join(classicRoot, 'app', 'views', 'index.xml'), text },
				offset: text.indexOf('Label'),
				end: text.indexOf('Label'),
				cache: new SourceCache()
			});

			assert.deepEqual(found, []);
		});
	});
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { Project } from '../../../core/project.ts';
import { SourceCache } from '../../../core/references.ts';
import { generateViewDeclaration } from '../../../core/typescript/declaration.ts';
import { ProjectService } from '../../../core/typescript/host.ts';
import { ProjectTypes } from '../../../core/typescript/types.ts';
import type { TypesLocation } from '../../../core/typescript/types.ts';
import { fixturePath } from '../../fixtures.ts';

/** A view path that looks like a real one, so the interface name comes from a realistic place */
function viewPath (name = 'index.xml'): string {
	return path.join('/project', 'app', 'views', name);
}

/**
 * Where a snippet sits in some text, failing loudly rather than returning -1
 *
 * @param text - The text to search
 * @param needle - What to find
 * @returns {number} The offset
 */
function offsetOf (text: string, needle: string): number {
	const offset = text.indexOf(needle);
	assert.notEqual(offset, -1, `expected to find ${JSON.stringify(needle)}`);
	return offset;
}

describe('core/typescript/declaration', () => {

	describe('the interface', () => {

		it('should declare a member for every id, with the type its tag resolves to', () => {
			const view = '<Alloy>\n\t<Window id="win">\n\t\t<Label id="label"/>\n\t</Window>\n</Alloy>';
			const { text } = generateViewDeclaration(viewPath(), view);

			assert.match(text, /\n\twin: Titanium\.UI\.Window;/);
			assert.match(text, /\n\tlabel: Titanium\.UI\.Label;/);
		});

		it('should name the interface after the view', () => {
			assert.match(generateViewDeclaration(viewPath('index.xml'), '<Alloy/>').text, /interface IndexViews/);
			assert.match(generateViewDeclaration(viewPath('sample.xml'), '<Alloy/>').text, /interface SampleViews/);
		});

		it('should turn a view name that is not an identifier into one', () => {
			assert.match(generateViewDeclaration(viewPath('my-first.view.xml'), '<Alloy/>').text, /interface MyFirstViewViews/);
			assert.match(generateViewDeclaration(viewPath('123.xml'), '<Alloy/>').text, /interface AlloyViews/);
		});

		it('should declare $ as the view members and the controller together', () => {
			const { text } = generateViewDeclaration(viewPath(), '<Alloy/>');
			assert.match(text, /declare const \$: IndexViews & Alloy\.Controller;/);
		});

		it('should declare the Alloy namespace it names', () => {
			// @types/titanium has no Alloy namespace, so the declaration carries its own or every
			// member of `$` that is not a view resolves to an error type
			const { text } = generateViewDeclaration(viewPath(), '<Alloy/>');

			assert.match(text, /declare namespace Alloy \{/);
			assert.match(text, /interface Controller \{/);
			assert.match(text, /\bargs\b/);
			assert.match(text, /getView\s?\(/);
		});

		it('should quote its keys so an id that is not an identifier still compiles', () => {
			// `$.__views["my-id"]` is legal in Alloy, and `my-id: T` is not legal TypeScript
			const { text } = generateViewDeclaration(viewPath(), '<Alloy><Label id="my-id"/></Alloy>');
			assert.match(text, /"my-id": Titanium\.UI\.Label;/);
		});

		it('should give an element with no id nothing', () => {
			const { text } = generateViewDeclaration(viewPath(), '<Alloy><Window><Label/></Window></Alloy>');
			assert.equal(/Titanium\.UI\.Label/.test(text), false);
		});

		it('should give an empty id nothing', () => {
			// Alloy treats an empty id as absent and generates one of its own, which names nothing
			// a controller can reach
			const { text } = generateViewDeclaration(viewPath(), '<Alloy><Window id="w"><Label id=""/></Window></Alloy>');
			assert.equal(/Titanium\.UI\.Label/.test(text), false);
		});

		it('should let the last of a duplicated id win, as Alloy does', () => {
			// $.__views takes the last write, and TypeScript will not accept a duplicate member
			const { text } = generateViewDeclaration(viewPath(), '<Alloy><Window><Label id="x"/><Button id="x"/></Window></Alloy>');

			assert.match(text, /\n\tx: Titanium\.UI\.Button;/);
			assert.equal(text.match(/\n\tx:/g)?.length, 1);
		});

		it('should give a root element with no id the view name, as Alloy does', () => {
			// `id = node.getAttribute('id') || defaultId || generateUniqueId()`, and the default id
			// for a direct child of <Alloy> is the view's own name — this is how $.index works
			const { text } = generateViewDeclaration(viewPath('index.xml'), '<Alloy><Window><Label id="label"/></Window></Alloy>');
			assert.match(text, /\n\tindex: Titanium\.UI\.Window;/);
		});

		it('should not give a nested element the view name', () => {
			const { text } = generateViewDeclaration(viewPath('index.xml'), '<Alloy><Window id="w"><Label/></Window></Alloy>');
			assert.equal(/\n\tindex:/.test(text), false);
		});
	});

	describe('the mapping', () => {

		it('should map a member back to where the view writes that id', () => {
			const view = '<Alloy>\n\t<Window class="container">\n\t\t<Label id="label"/>\n\t</Window>\n</Alloy>';
			const { text, map } = generateViewDeclaration(viewPath(), view);

			const at = map.position(offsetOf(text, '\tlabel:') + 1);

			assert.equal(at?.path, viewPath());
			assert.equal(view.slice(at!.offset, at!.offset + 'label'.length), 'label');
		});

		it('should map the span of a member back to the id and no further', () => {
			const view = '<Alloy><Label id="label"/></Alloy>';
			const { text, map } = generateViewDeclaration(viewPath(), view);
			const start = offsetOf(text, '\tlabel:') + 1;

			const range = map.range({ start, end: start + 'label'.length });

			assert.equal(view.slice(range!.range.start, range!.range.end), 'label');
		});

		it('should map the scaffolding to nothing', () => {
			// there is no honest answer for "where in the view is `interface IndexViews {`"
			const { text, map } = generateViewDeclaration(viewPath(), '<Alloy><Label id="label"/></Alloy>');

			assert.equal(map.position(offsetOf(text, 'interface IndexViews') + 1), undefined);
			assert.equal(map.position(offsetOf(text, 'declare const $') + 1), undefined);
		});

		it('should map a default id to the element it stands for', () => {
			// the id came from the file name rather than from the view, but the element it names is
			// right there — so it maps to that element's tag rather than to nothing
			const view = '<Alloy><Window/></Alloy>';
			const { text, map } = generateViewDeclaration(viewPath('index.xml'), view);

			const at = map.range({ start: offsetOf(text, '\tindex:') + 1, end: offsetOf(text, '\tindex:') + 6 });

			assert.equal(at?.path, viewPath('index.xml'));
			assert.equal(view.slice(at?.range.start, at?.range.end), 'Window');
		});

		it('should map every position in a default id to the same place', () => {
			// `index` and `Window` are different lengths, so the run stands for the tag rather than
			// copying it — anywhere in the member answers the start of the tag
			const { text, map } = generateViewDeclaration(viewPath('index.xml'), '<Alloy><Window/></Alloy>');
			const member = offsetOf(text, '\tindex:') + 1;

			assert.notEqual(map.position(member), undefined);
			assert.deepEqual(map.position(member), map.position(member + 4));
		});

		it('should say which file it maps into', () => {
			const { map } = generateViewDeclaration(viewPath(), '<Alloy/>');
			assert.equal(map.source, viewPath());
			assert.equal(map.generated, true);
		});
	});

	describe('a view being typed', () => {

		it('should say it is complete for a well formed view', () => {
			const { complete } = generateViewDeclaration(viewPath(), '<Alloy><Window id="w"><Label id="l"/></Window></Alloy>');
			assert.equal(complete, true);
		});

		it('should say it is incomplete while an element is unclosed', () => {
			// downstream must not treat this as the whole truth: the user is mid-keystroke and the
			// ids that are not there yet are not absent, only unwritten
			const { complete } = generateViewDeclaration(viewPath(), '<Alloy><Window id="w"><Label id="l"/>');
			assert.equal(complete, false);
		});

		it('should say it is incomplete for a bare < with no name yet', () => {
			const { complete } = generateViewDeclaration(viewPath(), '<Alloy><Window id="w"></Window><</Alloy>');
			assert.equal(complete, false);
		});

		it('should still declare the ids that did parse', () => {
			// a partial interface is worth more than none — the element being typed is the one the
			// user is not asking about
			const { text, complete } = generateViewDeclaration(viewPath(), '<Alloy>\n\t<Window id="win">\n\t\t<Label id="lab');

			assert.equal(complete, false);
			assert.match(text, /\n\twin: Titanium\.UI\.Window;/);
			assert.match(text, /\n\tlab: Titanium\.UI\.Label;/);
		});

		it('should never throw, whatever is in the file', () => {
			for (const view of [ '', '<', '</>', '<Alloy', '<Alloy></Window>', '<?xml', '<Alloy><Label id=' ]) {
				assert.doesNotThrow(() => generateViewDeclaration(viewPath(), view), `threw on ${JSON.stringify(view)}`);
			}
		});
	});

	describe('an empty view', () => {

		it('should still declare $, so a controller for a view with no ids answers', () => {
			const { text } = generateViewDeclaration(viewPath(), '<Alloy></Alloy>');

			assert.match(text, /interface IndexViews \{/);
			assert.match(text, /declare const \$: IndexViews & Alloy\.Controller;/);
		});
	});

	describe('what the language service makes of it', () => {

		/**
		 * The stubbed types the classic fixture installs, borrowed here the way the host tests
		 * borrow them
		 *
		 * @returns {Promise<TypesLocation>} Where the stub lives
		 */
		async function stubTypes (): Promise<TypesLocation> {
			const classic = new Project(await fixturePath('classic-project'));
			await classic.load();

			const located = await new ProjectTypes().locate(classic);
			assert.ok(located?.location, 'the classic fixture should carry the stubbed types');
			return located.location;
		}

		/**
		 * The alloy fixture, its index view, and a service with the generated declaration in scope
		 *
		 * @returns The service, the cache behind it, the view and the declaration
		 */
		async function declared (): Promise<{ service: ProjectService; cache: SourceCache; root: string; view: string; text: string }> {
			const project = new Project(await fixturePath('alloy-project'));
			await project.load();

			const cache = new SourceCache();
			const service = await ProjectService.create({ project, cache, types: await stubTypes() });

			const view = path.join(project.filePath, 'app', 'views', 'index.xml');
			const generated = generateViewDeclaration(view, await fs.readFile(view, 'utf-8'));

			service.setGenerated(path.join(project.filePath, 'app', 'controllers', 'index.views.d.ts'), generated.text, generated.map);

			return { service, cache, root: project.filePath, view, text: generated.text };
		}

		it('should typecheck clean against the Titanium types', async () => {
			// the whole declaration, the Alloy namespace included, compiled alongside the types a
			// project has — an error here is a `$` that resolves to nothing in every editor
			const types = await stubTypes();
			const { text } = generateViewDeclaration(viewPath(), '<Alloy><Window id="win"><Label id="my-label"/><Label id="b"/></Window></Alloy>');

			const declaration = path.join(path.dirname(types.entry), 'generated.d.ts');
			const host = ts.createCompilerHost({});
			const original = host.getSourceFile.bind(host);

			host.fileExists = file => file === declaration || ts.sys.fileExists(file);
			host.readFile = file => (file === declaration ? text : ts.sys.readFile(file));
			host.getSourceFile = (file, ...rest) => (file === declaration
				? ts.createSourceFile(file, text, ts.ScriptTarget.ES2020, true)
				: original(file, ...rest));

			const program = ts.createProgram([ types.entry, declaration ], { noEmit: true, strict: true, types: [] }, host);
			const errors = [ ...program.getSemanticDiagnostics(), ...program.getSyntacticDiagnostics() ]
				.filter(diagnostic => diagnostic.file?.fileName === declaration)
				.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));

			assert.deepEqual(errors, []);
		});

		it('should keep the rest of $ when one member names a type the types do not have', async () => {
			// a tag can resolve to a name @types/titanium has never heard of — ti.map's proxies are
			// not in it at all. That member degrades to `any`; the ones beside it must not
			const { service, cache, root } = await declared();
			const view = path.join(root, 'app', 'views', 'index.xml');
			const generated = generateViewDeclaration(view, '<Alloy><Window id="win"><Annotation id="pin"/><Label id="label"/></Window></Alloy>');
			service.setGenerated(path.join(root, 'app', 'controllers', 'index.views.d.ts'), generated.text, generated.map);

			const controller = path.join(root, 'app', 'controllers', 'scratch.js');
			cache.override(controller, '$.label.');

			assert.ok(generated.text.includes('Titanium.Map.Annotation'), 'expected the unresolvable name to be written out');
			assert.ok(service.completionsAt(controller, '$.label.'.length).some(entry => entry.name === 'text'), 'expected the other members to still answer');

			service.dispose();
		});

		it('should complete the view ids on $', async () => {
			const { service, cache, root } = await declared();
			const controller = path.join(root, 'app', 'controllers', 'scratch.js');
			cache.override(controller, '$.');

			const names = service.completionsAt(controller, 2).map(entry => entry.name);

			assert.ok(names.includes('label'), 'expected the view id');
			assert.ok(names.includes('index'), 'expected the default id of the root element');
			assert.ok(names.includes('args'), 'expected the controller members alongside them');

			service.dispose();
		});

		it('should complete the members of the type an id resolved to', async () => {
			// `$.label.` is the payoff: it needs the tag to have been resolved to Ti.UI.Label
			const { service, cache, root } = await declared();
			const controller = path.join(root, 'app', 'controllers', 'scratch.js');
			cache.override(controller, '$.label.');

			const names = service.completionsAt(controller, '$.label.'.length).map(entry => entry.name);

			assert.ok(names.includes('text'), 'expected a Label member');
			assert.ok(names.includes('backgroundColor'), 'expected an inherited View member');

			service.dispose();
		});

		it('should hover an id as the type its tag resolves to', async () => {
			const { service, cache, root } = await declared();
			const controller = path.join(root, 'app', 'controllers', 'scratch.js');
			cache.override(controller, '$.label;');

			const info = service.quickInfoAt(controller, '$.la'.length);

			assert.match(info!.text, /Titanium\.UI\.Label/);

			service.dispose();
		});

		it('should take go to definition from the controller to the id in the view', async () => {
			// the round trip the whole mapping design exists for: an editor lands in index.xml on
			// the id itself, not in a .d.ts that is on no disk
			const { service, cache, root, view } = await declared();
			const controller = path.join(root, 'app', 'controllers', 'scratch.js');
			cache.override(controller, '$.label;');

			const found = service.definitionsAt(controller, '$.la'.length);

			assert.equal(found.length, 1);
			assert.equal(found[0].path, view);

			const source = await fs.readFile(view, 'utf-8');
			assert.equal(source.slice(found[0].range.start, found[0].range.end), 'label');

			service.dispose();
		});

		it('should land on the element a default id stands for', async () => {
			// `$.index` is a name the file supplies rather than one the view writes, so there is no
			// id attribute to point at — the element that becomes it is the honest answer
			const { service, cache, root, view } = await declared();
			const controller = path.join(root, 'app', 'controllers', 'scratch.js');
			cache.override(controller, '$.index;');

			const found = service.definitionsAt(controller, '$.in'.length);

			assert.equal(found.length, 1);
			assert.equal(found[0].path, view);

			const source = await fs.readFile(view, 'utf-8');
			assert.equal(source.slice(found[0].range.start, found[0].range.end), 'Window');

			service.dispose();
		});
	});
});

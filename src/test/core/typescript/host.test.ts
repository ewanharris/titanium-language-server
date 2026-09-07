import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Project } from '../../../core/project.ts';
import { SourceCache } from '../../../core/references.ts';
import { ProjectService } from '../../../core/typescript/host.ts';
import { GeneratedMapping } from '../../../core/typescript/mapping.ts';
import type { PositionMap } from '../../../core/typescript/mapping.ts';
import { ProjectTypes } from '../../../core/typescript/types.ts';
import type { TypesLocation } from '../../../core/typescript/types.ts';
import { fixturePath } from '../../fixtures.ts';

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

/**
 * The stubbed types the classic fixture installs, which both project types borrow here.
 *
 * Resolution order has its own tests; these are about the host, so the types are handed to it
 * already resolved rather than resolved again through npm.
 *
 * @returns {Promise<TypesLocation>} Where the stub lives
 */
async function stubTypes (): Promise<TypesLocation> {
	const located = await new ProjectTypes().locate(await project('classic-project'));
	assert.ok(located?.location, 'the classic fixture should carry the stubbed types');
	return located.location;
}

/**
 * A service over a fixture project
 *
 * @param name - The fixture directory name
 * @param options - Pass `withoutTypes` for the case where nothing resolved
 * @returns The service and the cache behind it
 */
async function serviceFor (name: string, options: { withoutTypes?: boolean } = {}): Promise<{ service: ProjectService; cache: SourceCache; root: string }> {
	const loaded = await project(name);
	const cache = new SourceCache();
	const service = await ProjectService.create({
		project: loaded,
		cache,
		types: options.withoutTypes ? undefined : await stubTypes()
	});
	return { service, cache, root: loaded.filePath };
}

describe('The TypeScript language service host', () => {

	describe('a classic project', () => {
		it('should answer hover on a Titanium call', async () => {
			const { service, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'app.js');
			// `const window = Ti.UI.createWindow({...})` — the offset of `createWindow`
			const text = 'const window = Ti.UI.createWindow';

			const info = service.quickInfoAt(file, sourceOffset(await read(file), text) + text.length - 1);

			assert.ok(info, 'expected hover to answer');
			assert.match(info.text, /createWindow/);
			assert.match(info.text, /Window/);

			service.dispose();
		});

		it('should answer hover on a member of a local, which is the largest single gain', async () => {
			// `const win = Ti.UI.createWindow(); win.` is structurally impossible to answer without
			// a type system, and is the reason the whole engine exists
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			const text = 'const win = Ti.UI.createWindow();\nwin.title';
			cache.override(file, text);

			const info = service.quickInfoAt(file, text.length - 1);

			assert.ok(info, 'expected hover on the member to answer');
			assert.match(info.text, /title/);
			assert.match(info.text, /string/);

			service.dispose();
		});

		it('should resolve a require against Resources rather than app/lib', async () => {
			// classic and Alloy differ here, and the host takes the answer from the project rather
			// than assuming one
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			const text = 'const http = require(\'lib/http\');\nhttp';
			cache.override(file, text);

			const info = service.quickInfoAt(file, text.length - 1);

			assert.ok(info, 'expected the required module to resolve');

			service.dispose();
		});
	});

	describe('an Alloy project', () => {
		it('should answer hover in a controller', async () => {
			const { service, cache, root } = await serviceFor('alloy-project');
			const file = path.join(root, 'app', 'controllers', 'scratch.js');
			const text = 'const label = Ti.UI.createLabel();\nlabel.text';
			cache.override(file, text);

			const info = service.quickInfoAt(file, text.length - 1);

			assert.ok(info, 'expected hover to answer in an Alloy controller');
			assert.match(info.text, /text/);

			service.dispose();
		});

		it('should carry the JSDoc through, which is what makes hover worth showing', async () => {
			const { service, cache, root } = await serviceFor('alloy-project');
			const file = path.join(root, 'app', 'controllers', 'scratch.js');
			const text = 'const label = Ti.UI.createLabel();\nlabel.text';
			cache.override(file, text);

			const info = service.quickInfoAt(file, text.length - 1);

			assert.match(info?.documentation ?? '', /The text to display/);

			service.dispose();
		});
	});

	describe('the overlay', () => {
		it('should answer about the buffer rather than the file on disk', async () => {
			// a host that reads getScriptSnapshot from disk answers about the saved file, so every
			// result is one keystroke stale and it reads as flakiness rather than as a bug
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'app.js');
			cache.override(file, 'const label = Ti.UI.createLabel();\nlabel.color');

			const info = service.quickInfoAt(file, 'const label = Ti.UI.createLabel();\nlabel.color'.length - 1);

			assert.ok(info, 'expected the buffer to be read');
			assert.match(info.text, /color/, 'app.js on disk has no `color`, so this can only have come from the buffer');

			service.dispose();
		});

		it('should answer freshly after an edit', async () => {
			// if getScriptVersion does not move when the buffer does, the service serves the first
			// answer forever
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');

			cache.override(file, 'const win = Ti.UI.createWindow();\nwin.title');
			const first = service.quickInfoAt(file, 'const win = Ti.UI.createWindow();\nwin.title'.length - 1);

			cache.override(file, 'const view = Ti.UI.createImageView();\nview.image');
			const second = service.quickInfoAt(file, 'const view = Ti.UI.createImageView();\nview.image'.length - 1);

			assert.match(first?.text ?? '', /title/);
			assert.match(second?.text ?? '', /image/, 'the second answer should describe the edited buffer');

			service.dispose();
		});

		it('should go back to the file on disk once the buffer is dropped', async () => {
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'app.js');
			cache.override(file, 'const label = Ti.UI.createLabel();\nlabel.color');
			service.quickInfoAt(file, 10);
			cache.forget(file);

			const text = 'const window = Ti.UI.createWindow';
			const info = service.quickInfoAt(file, sourceOffset(await read(file), text) + text.length - 1);

			assert.match(info?.text ?? '', /createWindow/, 'should be answering about the saved file again');

			service.dispose();
		});
	});

	describe('answering nothing', () => {
		it('should answer nothing when no types resolved', async () => {
			// the failure case is a feature: answer nothing rather than from a stale or wrong copy
			const { service, cache, root } = await serviceFor('classic-project', { withoutTypes: true });
			const file = path.join(root, 'Resources', 'scratch.js');
			cache.override(file, 'Ti.UI.createWindow');

			assert.equal(service.quickInfoAt(file, 17), undefined);

			service.dispose();
		});

		it('should answer nothing for a position with nothing under it', async () => {
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			cache.override(file, '   \n   ');

			assert.equal(service.quickInfoAt(file, 1), undefined);

			service.dispose();
		});

		it('should survive a half-typed file rather than throwing', async () => {
			// sample.js is deliberately not valid JavaScript; a parser that gives up on it takes
			// every completion in the file with it
			const { service, root } = await serviceFor('alloy-project');

			assert.doesNotThrow(() => service.quickInfoAt(path.join(root, 'app', 'controllers', 'sample.js'), 3));

			service.dispose();
		});

		it('should answer nothing for a file outside the project', async () => {
			const { service } = await serviceFor('classic-project');

			assert.equal(service.quickInfoAt(path.join('/somewhere', 'else.js'), 0), undefined);

			service.dispose();
		});
	});

	describe('warming', () => {
		it('should build the program before the first request', async () => {
			// 623ms of cold parse landing on the first keystroke is the thing this avoids
			const { service } = await serviceFor('classic-project');

			service.warm();

			assert.equal(service.warmed, true);

			service.dispose();
		});

		it('should not warm when there are no types to parse', async () => {
			const { service } = await serviceFor('classic-project', { withoutTypes: true });

			service.warm();

			assert.equal(service.warmed, false);

			service.dispose();
		});
	});

	describe('completions', () => {
		it('should complete a namespace the types declare', async () => {
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			const text = 'Ti.UI.';
			cache.override(file, text);

			const names = service.completionsAt(file, text.length).map(entry => entry.name);

			assert.ok(names.includes('createWindow'), 'expected createWindow among the completions');
			assert.ok(names.includes('createLabel'), 'expected createLabel among the completions');

			service.dispose();
		});

		it('should complete a member of a local, inherited members included', async () => {
			// the same reason hover on a member matters: nothing but a type system can answer it, and
			// Label gets backgroundColor from View rather than declaring it
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			const text = 'const label = Ti.UI.createLabel();\nlabel.';
			cache.override(file, text);

			const names = service.completionsAt(file, text.length).map(entry => entry.name);

			assert.ok(names.includes('text'), 'expected the type\'s own member');
			assert.ok(names.includes('backgroundColor'), 'expected a member inherited from View');

			service.dispose();
		});

		it('should say what kind each completion is', async () => {
			// a client renders a method and a property differently, and guessing from the name is how
			// the previous implementation ended up with everything as a property
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			const text = 'const win = Ti.UI.createWindow();\nwin.';
			cache.override(file, text);

			const entries = service.completionsAt(file, text.length);

			assert.equal(entries.find(entry => entry.name === 'open')?.kind, 'method');
			assert.equal(entries.find(entry => entry.name === 'title')?.kind, 'property');

			service.dispose();
		});

		it('should answer the JSDoc for one completion, rather than for all of them', async () => {
			// a client asks for this when an item is highlighted, so resolving every entry up front
			// would pay for documentation nobody reads
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			const text = 'Ti.UI.';
			cache.override(file, text);

			const detail = service.completionDetail(file, text.length, 'createLabel');

			assert.match(detail?.documentation ?? '', /Creates a label/);
			assert.match(detail?.text ?? '', /createLabel/);

			service.dispose();
		});

		it('should answer no detail for an entry that is not in the list', async () => {
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			cache.override(file, 'Ti.UI.');

			assert.equal(service.completionDetail(file, 6, 'noSuchEntry'), undefined);

			service.dispose();
		});

		it('should complete in an Alloy controller', async () => {
			const { service, cache, root } = await serviceFor('alloy-project');
			const file = path.join(root, 'app', 'controllers', 'scratch.js');
			const text = 'const win = Ti.UI.createWindow();\nwin.';
			cache.override(file, text);

			const names = service.completionsAt(file, text.length).map(entry => entry.name);

			assert.ok(names.includes('open'), 'expected the Window members in a controller');

			service.dispose();
		});

		it('should answer nothing when no types resolved', async () => {
			const { service, cache, root } = await serviceFor('classic-project', { withoutTypes: true });
			const file = path.join(root, 'Resources', 'scratch.js');
			cache.override(file, 'Ti.UI.');

			assert.deepEqual(service.completionsAt(file, 6), []);
			assert.equal(service.completionDetail(file, 6, 'createLabel'), undefined);

			service.dispose();
		});

		it('should answer nothing for a file outside the project', async () => {
			const { service } = await serviceFor('classic-project');

			assert.deepEqual(service.completionsAt(path.join(path.sep, 'nowhere', 'x.js'), 0), []);

			service.dispose();
		});

		it('should survive a half-typed file rather than throwing', async () => {
			// this is the state every completion is actually requested in
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			cache.override(file, 'const win = Ti.UI.createWindow(\nwin.');

			assert.doesNotThrow(() => service.completionsAt(file, 36));

			service.dispose();
		});
	});

	describe('definitions', () => {
		it('should find a local declaration in the same file', async () => {
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			const text = 'const win = Ti.UI.createWindow();\nwin.open();';
			cache.override(file, text);

			const found = service.definitionsAt(file, sourceOffset(text, 'win.open') + 1);

			assert.equal(found.length, 1);
			assert.equal(found[0].path, file);
			assert.equal(text.slice(found[0].range.start, found[0].range.end), 'win');

			service.dispose();
		});

		it('should cross a require boundary, resolved the way the project resolves it', async () => {
			// classic resolves against Resources, so this lands in Resources/lib/http.js
			const { service, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'app.js');
			const source = await read(file);

			const found = service.definitionsAt(file, sourceOffset(source, 'http.noop') + 'http.'.length + 1);

			assert.equal(found.length, 1);
			assert.equal(found[0].path, path.join(root, 'Resources', 'lib', 'http.js'));

			service.dispose();
		});

		it('should point into the type definitions for a Titanium API', async () => {
			const { service, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'app.js');
			const source = await read(file);

			const found = service.definitionsAt(file, sourceOffset(source, 'Ti.UI.createWindow') + 'Ti.UI.'.length + 1);

			assert.equal(found.length, 1);
			assert.match(found[0].path, /@types[\\/]titanium[\\/]index\.d\.ts$/);

			service.dispose();
		});

		it('should answer nothing when no types resolved', async () => {
			const { service, root } = await serviceFor('classic-project', { withoutTypes: true });

			assert.deepEqual(service.definitionsAt(path.join(root, 'Resources', 'app.js'), 0), []);

			service.dispose();
		});

		it('should answer nothing where there is nothing to point at', async () => {
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			cache.override(file, '// just a comment\n');

			assert.deepEqual(service.definitionsAt(file, 3), []);

			service.dispose();
		});
	});

	describe('file names', () => {
		it('should answer about a file however its path is spelled', async () => {
			// TypeScript normalises paths internally and hands them back its way — forward slashes,
			// even on Windows — while the cache is keyed on the path the caller built. Every lookup
			// in the host has to normalise or a buffer that exists only in the overlay is invisible,
			// which is a Windows-only failure the suite would otherwise never see.
			const { service, cache, root } = await serviceFor('classic-project');
			const canonical = path.join(root, 'Resources', 'scratch.js');
			// forward slashes, which is exactly what TypeScript hands back. On POSIX this is the
			// same string and the test is vacuous; on Windows it is the failure, so CI is where it
			// asserts anything — the same posture as the npm symlink test.
			const spelled = canonical.split(path.sep).join('/');
			cache.override(canonical, 'const win = Ti.UI.createWindow();\nwin.title');

			assert.ok(service.quickInfoAt(spelled, 42), 'expected the same file to answer either way');

			service.dispose();
		});

		it('should answer paths in the platform\'s own form', async () => {
			// what comes back is compared against paths a caller built with path.join, and on
			// Windows TypeScript would answer with forward slashes
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			const text = 'const win = Ti.UI.createWindow();\nwin.open();';
			cache.override(file, text);

			const found = service.definitionsAt(file, sourceOffset(text, 'win.open') + 1);

			assert.equal(found[0]?.path, file);

			service.dispose();
		});
	});

	describe('generated content', () => {
		/**
		 * A `$` declaration of the shape #13 will generate, with `label` mapped back to where the
		 * view declares that id and everything else deliberately mapping nowhere
		 *
		 * @param root - The project root
		 * @returns The generated file's path, its text and the mapping back to the view
		 */
		async function declaration (root: string): Promise<{ file: string; text: string; map: PositionMap; view: string }> {
			const view = path.join(root, 'app', 'views', 'index.xml');
			const text = 'interface IndexViews {\n\tlabel: Titanium.UI.Label;\n}\ndeclare const $: IndexViews;\n';

			return {
				file: path.join(root, 'app', 'controllers', 'index.views.d.ts'),
				text,
				view,
				map: new GeneratedMapping(view, [ {
					generated: { start: sourceOffset(text, 'label'), length: 'label'.length },
					source: { start: sourceOffset(await read(view), 'label') }
				} ])
			};
		}

		it('should point at the view rather than at the file it generated', async () => {
			// the payoff for the whole mapping design: an editor lands in index.xml on the id, not in
			// a .d.ts that exists nowhere on disk
			const { service, cache, root } = await serviceFor('alloy-project');
			const generated = await declaration(root);
			service.setGenerated(generated.file, generated.text, generated.map);

			const controller = path.join(root, 'app', 'controllers', 'scratch.js');
			const source = '$.label;';
			cache.override(controller, source);

			const found = service.definitionsAt(controller, sourceOffset(source, 'label') + 1);

			assert.equal(found.length, 1);
			assert.equal(found[0].path, generated.view);
			assert.equal((await read(generated.view)).slice(found[0].range.start, found[0].range.end), 'label');

			service.dispose();
		});

		it('should answer nothing rather than pointing inside the scaffolding', async () => {
			// `interface IndexViews {` came from nowhere the user wrote, so there is no honest answer.
			// Nothing should ask about the generated file, and if something does it must not be told
			// a position in it.
			const { service, root } = await serviceFor('alloy-project');
			const generated = await declaration(root);
			service.setGenerated(generated.file, generated.text, generated.map);

			const info = service.quickInfoAt(generated.file, sourceOffset(generated.text, 'IndexViews') + 1);

			assert.equal(info, undefined);

			service.dispose();
		});

		it('should read the replacement after the content is generated again', async () => {
			// a view changes, the declaration is regenerated, and the service must not serve the old one
			const { service, cache, root } = await serviceFor('alloy-project');
			const generated = await declaration(root);
			service.setGenerated(generated.file, generated.text, generated.map);

			const controller = path.join(root, 'app', 'controllers', 'scratch.js');
			cache.override(controller, '$.');
			assert.ok(service.completionsAt(controller, 2).some(entry => entry.name === 'label'));

			const renamed = 'interface IndexViews {\n\theading: Titanium.UI.Label;\n}\ndeclare const $: IndexViews;\n';
			service.setGenerated(generated.file, renamed, new GeneratedMapping(generated.view, []));

			const names = service.completionsAt(controller, 2).map(entry => entry.name);
			assert.ok(names.includes('heading'), 'expected the regenerated member');
			assert.ok(!names.includes('label'), 'expected the old member to be gone');

			service.dispose();
		});

		it('should stop answering once the generated content is dropped', async () => {
			const { service, cache, root } = await serviceFor('alloy-project');
			const generated = await declaration(root);
			service.setGenerated(generated.file, generated.text, generated.map);

			const controller = path.join(root, 'app', 'controllers', 'scratch.js');
			cache.override(controller, '$.');
			assert.ok(service.completionsAt(controller, 2).some(entry => entry.name === 'label'));

			service.dropGenerated(generated.file);

			assert.ok(!service.completionsAt(controller, 2).some(entry => entry.name === 'label'));

			service.dispose();
		});
	});

	describe('positions', () => {
		it('should answer a range in the source file', async () => {
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			const text = 'const win = Ti.UI.createWindow();\nwin.title';
			cache.override(file, text);

			const info = service.quickInfoAt(file, text.length - 1);

			assert.equal(info?.path, file);
			assert.equal(text.slice(info?.range.start, info?.range.end), 'title');

			service.dispose();
		});
	});
});

/**
 * Reads a file the way the test needs it, without going through the cache under test
 *
 * @param file - The file to read
 * @returns {Promise<string>} Its contents
 */
async function read (file: string): Promise<string> {
	const { readFile } = await import('node:fs/promises');
	return readFile(file, 'utf-8');
}

/**
 * Where a snippet sits in some text, failing loudly rather than returning -1
 *
 * @param text - The text to search
 * @param needle - What to find
 * @returns {number} The offset
 */
function sourceOffset (text: string, needle: string): number {
	const offset = text.indexOf(needle);
	assert.notEqual(offset, -1, `expected to find ${JSON.stringify(needle)} in the fixture`);
	return offset;
}

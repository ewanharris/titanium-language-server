import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Project } from '../../../core/project.ts';
import { SourceCache } from '../../../core/references.ts';
import { ProjectDeclaration } from '../../../core/typescript/project-scope.ts';
import { ProjectService } from '../../../core/typescript/host.ts';
import { ProjectTypes } from '../../../core/typescript/types.ts';
import type { TypesLocation } from '../../../core/typescript/types.ts';
import { fixturePath } from '../../fixtures.ts';

/**
 * The stub the classic fixture installs, which both project types borrow here
 *
 * @returns {Promise<TypesLocation>} Where it lives
 */
async function stubTypes (): Promise<TypesLocation> {
	const project = new Project(await fixturePath('classic-project'));
	await project.load();

	const located = await new ProjectTypes().locate(project);
	assert.ok(located?.location, 'the classic fixture should carry the stubbed types');

	return located.location;
}

/**
 * A project declaration over a fixture project
 *
 * @param name - The fixture directory name
 * @returns The declaration owner, the service behind it, the shared cache and the project root
 */
async function owner (name: string): Promise<{
	declaration: ProjectDeclaration;
	service: ProjectService;
	cache: SourceCache;
	root: string;
}> {
	const project = new Project(await fixturePath(name));
	await project.load();

	const cache = new SourceCache();
	const service = await ProjectService.create({ project, cache, types: await stubTypes() });

	return { declaration: new ProjectDeclaration({ project, service, cache }), service, cache, root: project.filePath };
}

/**
 * What a source completes to at its end
 *
 * @param service - The service to ask
 * @param file - The file to ask in
 * @param cache - The cache holding its buffer
 * @param source - What the file says
 * @returns {string[]} The entry names
 */
function completions (service: ProjectService, file: string, cache: SourceCache, source: string): string[] {
	cache.override(file, source);
	return service.completionsAt(file, source.length).map(entry => entry.name);
}

describe('The project declaration in scope', () => {

	it('should put the configured keys on Alloy.CFG', async () => {
		const { declaration, service, cache, root } = await owner('alloy-project');
		const file = path.join(root, 'app', 'controllers', 'index.js');

		await declaration.ensure();

		const names = completions(service, file, cache, 'Alloy.CFG.');

		assert.ok(names.includes('test'), 'expected a key from the global section');
		assert.ok(names.includes('api'), 'expected a nested key');
	});

	it('should offer the project\'s controllers to Alloy.createController', async () => {
		const { declaration, service, cache, root } = await owner('alloy-project');
		const file = path.join(root, 'app', 'controllers', 'index.js');

		await declaration.ensure();

		assert.ok(completions(service, file, cache, 'Alloy.createController(\'').includes('sample'));
	});

	it('should offer the project\'s widgets to Alloy.createWidget', async () => {
		const { declaration, service, cache, root } = await owner('alloy-project');
		const file = path.join(root, 'app', 'controllers', 'index.js');

		await declaration.ensure();

		assert.ok(completions(service, file, cache, 'Alloy.createWidget(\'').includes('widget-test'));
	});

	it('should offer the translation keys to L in an Alloy project', async () => {
		const { declaration, service, cache, root } = await owner('alloy-project');
		const file = path.join(root, 'app', 'controllers', 'index.js');

		await declaration.ensure();

		const names = completions(service, file, cache, 'L(\'');

		assert.ok(names.includes('welcome.title'), 'expected a key with a dot in it');
		assert.ok(names.includes('untranslated'), 'expected a key only one locale declares');
	});

	it('should offer the translation keys to L in a classic project', async () => {
		// L is a Titanium global rather than an Alloy one, and classic keeps its i18n somewhere
		// else — an Alloy-only implementation answers nothing here
		const { declaration, service, cache, root } = await owner('classic-project');
		const file = path.join(root, 'Resources', 'scratch.js');

		await declaration.ensure();

		assert.ok(completions(service, file, cache, 'L(\'').includes('classicOnly'));
	});

	it('should declare no Alloy namespace in a classic project', async () => {
		const { declaration, service, cache, root } = await owner('classic-project');
		const file = path.join(root, 'Resources', 'scratch.js');

		await declaration.ensure();

		assert.ok(!completions(service, file, cache, 'Allo').includes('Alloy'), 'classic has no Alloy');
	});

	it('should install nothing for a project with nothing to declare', async () => {
		const { declaration, service } = await owner('no-sdk-project');
		const generated = mock.method(service, 'setGenerated');

		await declaration.ensure();

		assert.equal(generated.mock.callCount(), 0);
	});

	it('should not regenerate when none of what it read has moved', async () => {
		// this runs on every request, so rebuilding would put the config and every strings.xml
		// through the generator on each keystroke
		const { declaration, service } = await owner('alloy-project');
		await declaration.ensure();

		const generated = mock.method(service, 'setGenerated');
		await declaration.ensure();

		assert.equal(generated.mock.callCount(), 0);
	});

	it('should pick up a key added to config.json in the editor', async () => {
		const { declaration, service, cache, root } = await owner('alloy-project');
		const file = path.join(root, 'app', 'controllers', 'index.js');
		await declaration.ensure();

		cache.override(path.join(root, 'app', 'config.json'), '{ "global": { "justTyped": true } }');
		await declaration.ensure();

		const names = completions(service, file, cache, 'Alloy.CFG.');

		assert.ok(names.includes('justTyped'), 'expected the unsaved key');
		assert.ok(!names.includes('test'), 'expected the key it no longer has to be gone');
	});

	it('should pick up a string added to a strings.xml in the editor', async () => {
		const { declaration, service, cache, root } = await owner('alloy-project');
		const file = path.join(root, 'app', 'controllers', 'index.js');
		await declaration.ensure();

		cache.override(
			path.join(root, 'app', 'i18n', 'en', 'strings.xml'),
			'<resources><string name="justTyped">New</string></resources>'
		);
		await declaration.ensure();

		assert.ok(completions(service, file, cache, 'L(\'').includes('justTyped'));
	});

	it('should stop declaring L when the last translation is deleted', async () => {
		// going from something to nothing has to take the declaration back out, or the keys stay
		// in scope describing strings that no longer exist
		const { declaration, service, cache, root } = await owner('classic-project');
		const file = path.join(root, 'Resources', 'scratch.js');
		await declaration.ensure();

		cache.override(path.join(root, 'i18n', 'en', 'strings.xml'), '<resources></resources>');
		await declaration.ensure();

		assert.deepEqual(completions(service, file, cache, 'L(\''), []);
	});
});

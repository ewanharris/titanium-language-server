import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Project } from '../../core/project.ts';
import { SourceCache } from '../../core/references.ts';
import { readAlloyConfig } from '../../core/config.ts';
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

describe('Reading app/config.json', () => {

	it('should answer the keys under global', async () => {
		const config = await readAlloyConfig(await project('alloy-project'), new SourceCache());

		assert.equal(config?.values.test, 'value');
		assert.equal(config?.values.retries, 3);
	});

	it('should fold in the environment and platform sections', async () => {
		// Alloy merges global with the section for the build's environment and platform, and
		// neither is known while the file is being edited. A key any of them declares is a key the
		// user can legitimately write, so the union is what gets offered
		const config = await readAlloyConfig(await project('alloy-project'), new SourceCache());

		assert.equal(config?.values.debug, false, 'expected a key from an env: section');
		assert.equal(config?.values.androidOnly, 'yes', 'expected a key from an os: section');
	});

	it('should keep a nested object nested rather than flattening it', async () => {
		// Alloy.CFG.api.base is how it is written, so that is the shape the declaration needs
		const config = await readAlloyConfig(await project('alloy-project'), new SourceCache());

		assert.deepEqual(config?.values.api, { base: 'https://example.com', timeout: 30 });
	});

	it('should not put dependencies on CFG', async () => {
		// dependencies is the widget manifest rather than configuration: Alloy reads it to decide
		// what to bundle, and it never reaches Alloy.CFG
		const config = await readAlloyConfig(await project('alloy-project'), new SourceCache());

		assert.equal(config?.values.dependencies, undefined);
	});

	it('should answer the widget dependencies separately', async () => {
		const config = await readAlloyConfig(await project('alloy-project'), new SourceCache());

		assert.deepEqual(config?.dependencies, [ 'widget-test' ]);
	});

	it('should answer nothing for a classic project, which has no config.json', async () => {
		assert.equal(await readAlloyConfig(await project('classic-project'), new SourceCache()), undefined);
	});

	it('should answer nothing rather than throwing while the file is half written', async () => {
		// a user editing config.json is the normal case, and a parse error there must not take the
		// rest of the declaration down with it
		const loaded = await project('alloy-project');
		const cache = new SourceCache();
		cache.override(path.join(loaded.filePath, 'app', 'config.json'), '{ "global": { "test": ');

		assert.equal(await readAlloyConfig(loaded, cache), undefined);
	});

	it('should read an open buffer rather than what is on disk', async () => {
		const loaded = await project('alloy-project');
		const cache = new SourceCache();
		cache.override(path.join(loaded.filePath, 'app', 'config.json'), '{ "global": { "justTyped": 1 } }');

		const config = await readAlloyConfig(loaded, cache);

		assert.equal(config?.values.justTyped, 1);
		assert.equal(config?.values.test, undefined, 'expected the saved keys to be gone');
	});

	it('should ignore a section that is not an object', async () => {
		// config.json is hand written, and a string where a section belongs must not crash the
		// merge or put the characters of the string on CFG
		const loaded = await project('alloy-project');
		const cache = new SourceCache();
		cache.override(path.join(loaded.filePath, 'app', 'config.json'), '{ "global": "oops", "env:production": { "fine": true } }');

		const config = await readAlloyConfig(loaded, cache);

		assert.deepEqual(config?.values, { fine: true });
	});

	it('should answer nothing for a file that is valid JSON but not an object', async () => {
		const loaded = await project('alloy-project');
		const cache = new SourceCache();
		cache.override(path.join(loaded.filePath, 'app', 'config.json'), '[]');

		assert.equal(await readAlloyConfig(loaded, cache), undefined);
	});

	it('should answer an empty configuration for a file with no sections it knows', async () => {
		// an empty config.json is still an Alloy project, and Alloy.CFG is still a thing to write
		const loaded = await project('alloy-project');
		const cache = new SourceCache();
		cache.override(path.join(loaded.filePath, 'app', 'config.json'), '{}');

		const config = await readAlloyConfig(loaded, cache);

		assert.deepEqual(config?.values, {});
		assert.deepEqual(config?.dependencies, []);
	});
});

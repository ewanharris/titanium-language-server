import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Project } from '../../../core/project.ts';
import { SourceCache } from '../../../core/references.ts';
import { ProjectServices } from '../../../core/typescript/services.ts';
import { ProjectTypes } from '../../../core/typescript/types.ts';
import type { TypesSource } from '../../../core/typescript/types.ts';
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
 * A services manager over the given sources.
 *
 * The default is the project's own types only — never the npm acquirer, which would put a network
 * call in the suite.
 *
 * @param sources - Where types come from
 * @returns {ProjectServices} The manager
 */
function services (sources: TypesSource[] = [ new ProjectTypes() ]): ProjectServices {
	return new ProjectServices({ cache: new SourceCache(), sources });
}

/**
 * A source that lends every project the stub the classic fixture installs.
 *
 * The Alloy fixture deliberately has no node_modules of its own — `ProjectTypes` answering nothing
 * for it is asserted elsewhere — so a test that needs an Alloy project with types resolved says so
 * here rather than by installing types into the fixture and breaking that.
 *
 * @returns {TypesSource} The source
 */
function stubbed (): TypesSource {
	return {
		name: 'the stub',
		locate: async () => new ProjectTypes().locate(new Project(await fixturePath('classic-project')))
	};
}

describe('The per-project language services', () => {

	it('should open a warmed service, so the cold parse is not paid on the first request', async () => {
		const manager = services();

		const { service } = await manager.open(await project('classic-project'));

		assert.equal(service.warmed, true);
		assert.notEqual(service.types, undefined);

		manager.dispose();
	});

	it('should keep one service per project rather than rebuilding it', async () => {
		// each service holds a parsed program; building a second one per request would spend the
		// cold parse over and over
		const manager = services();
		const loaded = await project('classic-project');

		const first = await manager.open(loaded);
		const second = await manager.open(loaded);

		assert.equal(first.service, second.service);
		assert.equal(manager.get(loaded), first.service);

		manager.dispose();
	});

	it('should not resolve types again for a project it has already opened', async () => {
		// resolution can shell out to npm, so re-opening a project that is already open must not
		// pay for it a second time
		let locates = 0;
		const counted: TypesSource = {
			name: 'counted',
			locate: async (loaded) => {
				locates++;
				return new ProjectTypes().locate(loaded);
			}
		};
		const manager = services([ counted ]);
		const loaded = await project('classic-project');

		await manager.open(loaded);
		await manager.open(loaded);

		assert.equal(locates, 1);

		manager.dispose();
	});

	it('should have nothing for a project that was never opened', async () => {
		assert.equal(services().get(await project('classic-project')), undefined);
	});

	it('should still open a service when no types resolved, and say so', async () => {
		// the features it backs answer nothing, but the project is still registered and every other
		// feature still works — a missing type package is not a broken project
		const manager = services([]);
		const loaded = await project('classic-project');

		const { service, report } = await manager.open(loaded);

		assert.equal(service.types, undefined);
		assert.equal(service.warmed, false);
		assert.equal(report.level, 'warning');
		assert.match(report.message, /@types\/titanium/);

		manager.dispose();
	});

	it('should report where the types came from when they did resolve', async () => {
		const manager = services();

		const { report } = await manager.open(await project('classic-project'));

		assert.equal(report.level, 'info');

		manager.dispose();
	});

	it('should dispose and forget a project that is closed', async () => {
		const manager = services();
		const loaded = await project('classic-project');
		await manager.open(loaded);

		manager.close(loaded);

		assert.equal(manager.get(loaded), undefined);

		manager.dispose();
	});

	it('should ignore closing a project it never opened', async () => {
		const manager = services();

		assert.doesNotThrow(() => manager.close(new Project('/nowhere')));

		manager.dispose();
	});

	it('should close everything it holds when disposed', async () => {
		const manager = services();
		const classic = await project('classic-project');
		const alloy = await project('alloy-project');
		await manager.open(classic);
		await manager.open(alloy);

		manager.dispose();

		assert.equal(manager.get(classic), undefined);
		assert.equal(manager.get(alloy), undefined);
	});

	it('should share one cache across the projects it opens', async () => {
		// the overlay is what makes an unsaved buffer the thing analysed, and a second cache would
		// be a second source of truth that disagrees mid-edit
		const cache = new SourceCache();
		const manager = new ProjectServices({ cache, sources: [ new ProjectTypes() ] });
		const loaded = await project('classic-project');
		const file = path.join(loaded.filePath, 'Resources', 'scratch.js');

		const { service } = await manager.open(loaded);
		cache.override(file, 'const win = Ti.UI.createWindow();\nwin.title');

		assert.ok(service.quickInfoAt(file, 42), 'expected the service to read the shared overlay');

		manager.dispose();
	});

	it('should prepare a controller by putting its $ in scope before answering about it', async () => {
		// the declaration has to be installed before the service is asked, or the first completion
		// in a controller answers against a program with no $ in it at all
		const cache = new SourceCache();
		const manager = new ProjectServices({ cache, sources: [ stubbed() ] });
		const loaded = await project('alloy-project');
		const controller = path.join(loaded.filePath, 'app', 'controllers', 'index.js');

		await manager.open(loaded);
		const service = await manager.prepare(loaded, controller);
		cache.override(controller, '$.');

		assert.ok(service, 'expected the service for an opened project');
		assert.ok(
			service.completionsAt(controller, '$.'.length).some(entry => entry.name === 'label'),
			'expected the view id to reach $'
		);

		manager.dispose();
	});

	it('should keep one $ in scope as it prepares one controller after another', async () => {
		// every declaration declares $, so preparing the second has to take the first back out
		const cache = new SourceCache();
		const manager = new ProjectServices({ cache, sources: [ stubbed() ] });
		const loaded = await project('alloy-project');
		const sample = path.join(loaded.filePath, 'app', 'controllers', 'sample.js');

		await manager.open(loaded);
		await manager.prepare(loaded, path.join(loaded.filePath, 'app', 'controllers', 'index.js'));
		const service = await manager.prepare(loaded, sample);

		cache.override(sample, '$.');
		const members = service?.completionsAt(sample, '$.'.length).map(entry => entry.name) ?? [];

		assert.ok(members.includes('scrollView'), 'expected the prepared controller\'s ids');
		assert.ok(!members.includes('label'), 'expected the previous controller\'s ids to be gone');

		manager.dispose();
	});

	it('should prepare a classic file without a declaration, since classic has no $', async () => {
		const cache = new SourceCache();
		const manager = new ProjectServices({ cache, sources: [ new ProjectTypes() ] });
		const loaded = await project('classic-project');
		const file = path.join(loaded.filePath, 'Resources', 'app.js');

		await manager.open(loaded);
		const service = await manager.prepare(loaded, file);

		assert.equal(service, manager.get(loaded));

		manager.dispose();
	});

	it('should have nothing to prepare for a project that was never opened', async () => {
		const manager = services();

		assert.equal(await manager.prepare(await project('classic-project'), 'anything.js'), undefined);
	});
});

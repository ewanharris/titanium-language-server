import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Project } from '../../../core/project.ts';
import { acquiredTypes, projectTypes, resolveTypes } from '../../../core/typescript/types.ts';
import type { TypesAcquirer } from '../../../core/typescript/acquire.ts';
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

/** The majors DefinitelyTyped publishes, per `npm view @types/titanium versions` */
const published = [ '3.5.30', '7.3.1', '8.0.5', '9.2.2', '12.0.8', '13.3.0' ];

/**
 * An acquirer that installs into a temporary directory rather than fetching anything
 *
 * @param available - The versions it should claim are published
 * @returns The acquirer and the versions it was asked to install
 */
function fakeAcquirer (available: string[] = published): { acquirer: TypesAcquirer; installed: string[] } {
	const installed: string[] = [];

	return {
		installed,
		acquirer: {
			versions: async () => available,
			install: async version => {
				installed.push(version);
				const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ti-ls-types-'));
				const target = path.join(root, 'node_modules', '@types', 'titanium');
				await fs.mkdir(target, { recursive: true });
				await fs.writeFile(path.join(target, 'index.d.ts'), 'declare const Ti: unknown;');
				await fs.writeFile(path.join(target, 'package.json'), JSON.stringify({ name: '@types/titanium', version }));
				return target;
			}
		}
	};
}

/** An acquirer that can reach nothing, which is a locked-down machine */
const offlineAcquirer: TypesAcquirer = {
	versions: async () => [],
	install: async () => undefined
};

describe('Resolving @types/titanium', () => {

	describe('the project\'s own types', () => {
		it('should find a copy the project has installed', async () => {
			// the build is the authority: whatever the project compiles against is what the editor
			// should answer from
			const resolved = await projectTypes().locate(await project('classic-project'));

			assert.ok(resolved?.location, 'expected the fixture\'s own types to be found');
			assert.equal(resolved.location.version, '9.2.2');
			assert.ok(resolved.location.entry.endsWith('index.d.ts'));
		});

		it('should prefer the project\'s copy even when its version does not match the SDK', async () => {
			// classic-project declares sdk-version 12.4.0.GA and installs 9.2.2 types; the version
			// rule does not get a say, because the project has already made the choice
			const resolved = await projectTypes().locate(await project('classic-project'));

			assert.equal(resolved?.location?.version, '9.2.2');
			assert.equal(resolved?.report.level, 'info', 'the project\'s own choice is not a fallback to warn about');
		});

		it('should find nothing when the project has not installed them', async () => {
			assert.equal(await projectTypes().locate(await project('alloy-project')), undefined);
		});
	});

	describe('acquired types', () => {
		it('should acquire the newest release of the SDK\'s own major', async () => {
			const { acquirer, installed } = fakeAcquirer();

			const resolved = await acquiredTypes(acquirer).locate(await project('classic-project'));

			assert.deepEqual(installed, [ '12.0.8' ], 'sdk-version 12.4.0.GA should take the newest 12.x');
			assert.equal(resolved?.report.level, 'info', 'trailing inside a major is the common case and should stay quiet');
		});

		it('should fall back across the gap and say so', async () => {
			// alloy-project declares 10.1.0.GA, and DefinitelyTyped publishes no 10.x or 11.x
			const { acquirer, installed } = fakeAcquirer();

			const resolved = await acquiredTypes(acquirer).locate(await project('alloy-project'));

			assert.deepEqual(installed, [ '9.2.2' ]);
			assert.equal(resolved?.report.level, 'warning', 'crossing a major is worth telling the user about');
			assert.match(resolved.report.message, /10\.1\.0/, 'should name the sdk-version that could not be satisfied');
		});

		it('should report a failure when nothing is published at or below the SDK', async () => {
			const { acquirer, installed } = fakeAcquirer([ '13.3.0' ]);

			const resolved = await acquiredTypes(acquirer).locate(await project('alloy-project'));

			assert.equal(resolved, undefined, 'nothing resolved, so the next source gets a turn');
			assert.deepEqual(installed, [], 'should not install a major above the SDK');
		});

		it('should resolve nothing when the registry cannot be reached', async () => {
			assert.equal(await acquiredTypes(offlineAcquirer).locate(await project('alloy-project')), undefined);
		});

		it('should resolve nothing when the install itself fails', async () => {
			const acquirer: TypesAcquirer = {
				versions: async () => published,
				install: async () => undefined
			};

			assert.equal(await acquiredTypes(acquirer).locate(await project('alloy-project')), undefined);
		});
	});

	describe('resolution order', () => {
		it('should prefer the project\'s own types over acquiring', async () => {
			const { acquirer, installed } = fakeAcquirer();

			const resolved = await resolveTypes(await project('classic-project'), [ projectTypes(), acquiredTypes(acquirer) ]);

			assert.equal(resolved.location?.version, '9.2.2');
			assert.deepEqual(installed, [], 'should not have reached for the network at all');
		});

		it('should acquire when the project has no types of its own', async () => {
			const { acquirer, installed } = fakeAcquirer();

			const resolved = await resolveTypes(await project('alloy-project'), [ projectTypes(), acquiredTypes(acquirer) ]);

			assert.ok(resolved.location);
			assert.deepEqual(installed, [ '9.2.2' ]);
		});

		it('should take the first source that answers, so a new source can slot in ahead', async () => {
			// types published in the SDK itself are being pursued upstream and would sit between
			// the project's own copy and npm; nothing here should need changing when they land
			const { acquirer } = fakeAcquirer();
			const fromTheSdk = {
				name: 'the SDK',
				locate: async () => ({
					location: { packagePath: '/sdk', entry: '/sdk/index.d.ts', version: '13.4.1', source: 'the SDK' },
					report: { level: 'info' as const, message: 'from the SDK' }
				})
			};

			const resolved = await resolveTypes(await project('alloy-project'), [ projectTypes(), fromTheSdk, acquiredTypes(acquirer) ]);

			assert.equal(resolved.location?.source, 'the SDK');
		});

		it('should report clearly when no source can answer', async () => {
			// the failure case is a feature: say which sdk-version could not be satisfied and what
			// would fix it, rather than answering from something stale
			const resolved = await resolveTypes(await project('alloy-project'), [ projectTypes(), acquiredTypes(offlineAcquirer) ]);

			assert.equal(resolved.location, undefined);
			assert.equal(resolved.report.level, 'warning');
			assert.match(resolved.report.message, /10\.1\.0/, 'should name the sdk-version');
			assert.match(resolved.report.message, /@types\/titanium/, 'should name what would fix it');
		});

		it('should report clearly when there are no sources at all', async () => {
			const resolved = await resolveTypes(await project('alloy-project'), []);

			assert.equal(resolved.location, undefined);
			assert.equal(resolved.report.level, 'warning');
		});
	});
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNpmAcquirer, runCommand, typesCacheDirectory } from '../../../core/typescript/acquire.ts';
import type { CommandResult, CommandRunner } from '../../../core/typescript/acquire.ts';

/** Every npm invocation a test made, so the arguments can be asserted rather than the effect */
interface Recorded {
	command: string;
	args: string[];
}

/**
 * A command runner that answers from a script rather than spawning anything
 *
 * @param answers - What to answer, in call order
 * @returns The runner and the calls it recorded
 */
function fakeRunner (answers: CommandResult[]): { run: CommandRunner; calls: Recorded[] } {
	const calls: Recorded[] = [];
	let next = 0;

	return {
		calls,
		run: async (command, args) => {
			calls.push({ command, args });
			return answers[next++] ?? { code: 1, stdout: '', stderr: 'no answer scripted' };
		}
	};
}

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '' });
const failed = (stderr: string): CommandResult => ({ code: 1, stdout: '', stderr });

describe('Acquiring @types/titanium', () => {

	describe('the cache directory', () => {
		it('should key the cache on the version, so two projects on different SDKs coexist', () => {
			// the same shape TypeScript's own automatic type acquisition uses
			const nine = typesCacheDirectory('9.2.2');
			const thirteen = typesCacheDirectory('13.3.0');

			assert.notEqual(nine, thirteen);
			assert.ok(nine.endsWith(path.join('9.2.2')), `expected a directory ending in the version, got ${nine}`);
		});

		it('should be an absolute path', () => {
			assert.ok(path.isAbsolute(typesCacheDirectory('13.3.0')));
		});
	});

	describe('listing published versions', () => {
		it('should read the versions npm reports', async () => {
			const { run, calls } = fakeRunner([ ok('["9.2.2","12.0.8","13.3.0"]') ]);
			const acquirer = createNpmAcquirer({ run });

			assert.deepEqual(await acquirer.versions(), [ '9.2.2', '12.0.8', '13.3.0' ]);
			assert.equal(calls[0].command, 'npm');
			assert.ok(calls[0].args.includes('@types/titanium'), 'should ask npm about the types package');
			assert.ok(calls[0].args.includes('--json'), 'should ask for JSON rather than parsing npm prose');
		});

		it('should read a single version, which npm reports unwrapped', async () => {
			// `npm view <pkg> versions --json` answers with a bare string when only one exists
			const { run } = fakeRunner([ ok('"13.3.0"') ]);
			const acquirer = createNpmAcquirer({ run });

			assert.deepEqual(await acquirer.versions(), [ '13.3.0' ]);
		});

		it('should answer nothing when npm cannot reach the registry', async () => {
			// a locked-down machine is not an error worth throwing over: the resolver falls through
			// to reporting that nothing resolved
			const { run } = fakeRunner([ failed('ENOTFOUND registry.npmjs.org') ]);
			const acquirer = createNpmAcquirer({ run });

			assert.deepEqual(await acquirer.versions(), []);
		});

		it('should answer nothing when npm is not on the path at all', async () => {
			const acquirer = createNpmAcquirer({
				run: async () => {
					throw new Error('spawn npm ENOENT');
				}
			});

			assert.deepEqual(await acquirer.versions(), []);
		});

		it('should answer nothing when npm prints something that is not JSON', async () => {
			const { run } = fakeRunner([ ok('npm warn deprecated something') ]);
			const acquirer = createNpmAcquirer({ run });

			assert.deepEqual(await acquirer.versions(), []);
		});
	});

	describe('installing a version', () => {
		it('should install with --ignore-scripts', async () => {
			// a postinstall script from a fetched package running inside a language server is the
			// one risk this step actually carries, and it is what TypeScript's own installer does
			const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ti-ls-acquire-'));
			const { run, calls } = fakeRunner([ ok('') ]);
			const acquirer = createNpmAcquirer({ run, cacheDirectory: () => root });

			await acquirer.install('13.3.0');

			assert.equal(calls[0].command, 'npm');
			assert.ok(calls[0].args.includes('--ignore-scripts'), `expected --ignore-scripts, got ${calls[0].args.join(' ')}`);
			assert.ok(calls[0].args.includes('@types/titanium@13.3.0'), 'should pin the exact version');
		});

		it('should answer where the package landed', async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ti-ls-acquire-'));
			const installed = path.join(root, 'node_modules', '@types', 'titanium');
			const { run } = fakeRunner([ ok('') ]);
			const acquirer = createNpmAcquirer({
				run: async (...args) => {
					// npm would have written the package; the fake has to as well
					await fs.mkdir(installed, { recursive: true });
					await fs.writeFile(path.join(installed, 'index.d.ts'), 'declare const Ti: unknown;');
					return run(...args);
				},
				cacheDirectory: () => root
			});

			assert.equal(await acquirer.install('13.3.0'), installed);
		});

		it('should not run npm again for a version already in the cache', async () => {
			// the second project on the same SDK, and every restart after the first, should cost
			// nothing and work offline
			const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ti-ls-acquire-'));
			const installed = path.join(root, 'node_modules', '@types', 'titanium');
			await fs.mkdir(installed, { recursive: true });
			await fs.writeFile(path.join(installed, 'index.d.ts'), 'declare const Ti: unknown;');

			const { run, calls } = fakeRunner([ ok('') ]);
			const acquirer = createNpmAcquirer({ run, cacheDirectory: () => root });

			assert.equal(await acquirer.install('13.3.0'), installed);
			assert.deepEqual(calls, [], 'should not have spawned npm at all');
		});

		it('should answer nothing when the install fails', async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ti-ls-acquire-'));
			const { run } = fakeRunner([ failed('ENOTFOUND registry.npmjs.org') ]);
			const acquirer = createNpmAcquirer({ run, cacheDirectory: () => root });

			assert.equal(await acquirer.install('13.3.0'), undefined);
		});

		it('should answer nothing when npm reports success but writes no package', async () => {
			// npm exiting zero is not proof the package is there, and a path that does not exist
			// would fail later and further away
			const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ti-ls-acquire-'));
			const { run } = fakeRunner([ ok('') ]);
			const acquirer = createNpmAcquirer({ run, cacheDirectory: () => root });

			assert.equal(await acquirer.install('13.3.0'), undefined);
		});

		it('should answer nothing when npm cannot be spawned', async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ti-ls-acquire-'));
			const acquirer = createNpmAcquirer({
				run: async () => {
					throw new Error('spawn npm ENOENT');
				},
				cacheDirectory: () => root
			});

			assert.equal(await acquirer.install('13.3.0'), undefined);
		});
	});
});

describe('The default command runner', () => {
	// the seam above means nothing else in the suite spawns anything, so the real runner needs
	// covering directly rather than through the acquirer

	it('should resolve with what a command printed', async () => {
		// node is the one executable guaranteed present: the suite is running under it
		const result = await runCommand(process.execPath, [ '-e', 'process.stdout.write("hello")' ], {});

		assert.equal(result.code, 0);
		assert.equal(result.stdout, 'hello');
	});

	it('should resolve rather than reject when a command exits non-zero', async () => {
		// a command that ran and failed is an answer; the callers log its stderr
		const result = await runCommand(process.execPath, [ '-e', 'process.stderr.write("nope"); process.exit(3)' ], {});

		assert.equal(result.code, 3);
		assert.equal(result.stderr, 'nope');
	});

	it('should reject when the command cannot be started at all', async () => {
		// distinct from exiting non-zero: this says nothing about the registry, only about the
		// machine, and the callers word the log differently for it
		await assert.rejects(() => runCommand(path.join(os.tmpdir(), 'definitely-not-an-executable-xyz'), [], {}));
	});

	it('should run in the directory it is given', async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ti-ls-cwd-')));

		const result = await runCommand(process.execPath, [ '-e', 'process.stdout.write(process.cwd())' ], { cwd: root });

		assert.equal(result.stdout, root);
	});
});

describe('Where the cache lives', () => {
	it('should follow XDG_CACHE_HOME where the platform uses it', { skip: process.platform === 'win32' || process.platform === 'darwin' }, () => {
		const previous = process.env.XDG_CACHE_HOME;
		process.env.XDG_CACHE_HOME = path.join(os.tmpdir(), 'xdg-cache-probe');
		try {
			assert.ok(typesCacheDirectory('13.3.0').startsWith(process.env.XDG_CACHE_HOME));
		} finally {
			if (previous === undefined) {
				delete process.env.XDG_CACHE_HOME;
			} else {
				process.env.XDG_CACHE_HOME = previous;
			}
		}
	});

	it('should name the package it caches, so the directory is identifiable on disk', () => {
		assert.ok(typesCacheDirectory('13.3.0').includes('titanium-language-server'));
	});
});

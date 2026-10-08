import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readModules } from '../../core/modules.ts';

/**
 * Lays out a modules directory from a list of files, each relative to it.
 *
 * @param files - Paths under the modules directory, with their contents
 * @returns {Promise<string>} The modules directory
 */
async function layout (files: Record<string, string>): Promise<string> {
	const root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'ti-ls-modules-')), 'modules');

	for (const [ file, contents ] of Object.entries(files)) {
		await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
		await fs.writeFile(path.join(root, file), contents);
	}

	return root;
}

/**
 * A manifest as a module ships it
 *
 * @param fields - The keys to write
 * @returns {string} The manifest's contents
 */
function manifest (fields: Record<string, string>): string {
	return [ '#', '# this is your module manifest', '#', ...Object.entries(fields).map(([ key, value ]) => `${key}: ${value}`) ].join('\n');
}

describe('Reading installed modules', () => {

	it('should read the id, version and platform from each version\'s manifest', async () => {
		const root = await layout({
			'android/ti.map/5.6.0/manifest': manifest({ moduleid: 'ti.map', version: '5.6.0', platform: 'android' }),
			'iphone/ti.map/7.3.1/manifest': manifest({ moduleid: 'ti.map', version: '7.3.1', platform: 'iphone' })
		});

		assert.deepEqual(await readModules(root), [
			{ id: 'ti.map', version: '5.6.0', platform: 'android', path: path.join(root, 'android', 'ti.map', '5.6.0') },
			{ id: 'ti.map', version: '7.3.1', platform: 'ios', path: path.join(root, 'iphone', 'ti.map', '7.3.1') }
		]);
	});

	it('should ignore a stray file at every level', async () => {
		// the bug the previous implementation had: it checked the platform where it meant the
		// module, so a file beside the module directories was listed as one
		const root = await layout({
			'README.md': 'not a platform',
			'android/stray.txt': 'not a module',
			'android/ti.map/notes.txt': 'not a version',
			'android/ti.map/5.6.0/manifest': manifest({ moduleid: 'ti.map', version: '5.6.0', platform: 'android' })
		});

		assert.deepEqual((await readModules(root)).map(module => module.id), [ 'ti.map' ]);
	});

	it('should skip a version directory with no manifest, which the CLI would not build with', async () => {
		const root = await layout({
			'android/ti.map/5.6.0/README.md': 'half-copied'
		});

		assert.deepEqual(await readModules(root), []);
	});

	it('should skip a manifest without a moduleid or a platform, as the CLI does', async () => {
		// the build matches a tiapp's <module> against moduleid, so a module without one can never
		// be the one a tiapp names; the CLI drops one without a platform outright
		const root = await layout({
			'android/no.id/1.0.0/manifest': manifest({ version: '1.0.0', platform: 'android' }),
			'android/no.platform/1.0.0/manifest': manifest({ moduleid: 'no.platform', version: '1.0.0' })
		});

		assert.deepEqual(await readModules(root), []);
	});

	it('should take the version from the directory when the manifest has none, and skip one that is not a version', async () => {
		const root = await layout({
			'android/a.module/2.1/manifest': manifest({ moduleid: 'a.module', platform: 'android' }),
			'android/a.module/latest/manifest': manifest({ moduleid: 'a.module', platform: 'android' })
		});

		// the CLI pads to three parts before validating, so 2.1 is a version and latest is not
		assert.deepEqual((await readModules(root)).map(module => module.version), [ '2.1' ]);
	});

	it('should read the platform from the manifest rather than from the directory it sits in', async () => {
		const root = await layout({
			'android/misplaced/1.0.0/manifest': manifest({ moduleid: 'misplaced', version: '1.0.0', platform: 'commonjs' })
		});

		assert.deepEqual((await readModules(root)).map(module => module.platform), [ 'commonjs' ]);
	});

	it('should skip the directories the CLI skips', async () => {
		// the CLI's own pattern for operating system directories, and its default for version
		// control ones
		const root = await layout({
			'osx/old.module/1.0.0/manifest': manifest({ moduleid: 'old.module', version: '1.0.0', platform: 'osx' }),
			'.git/x/1.0.0/manifest': manifest({ moduleid: 'x', version: '1.0.0', platform: 'android' }),
			'android/.svn/1.0.0/manifest': manifest({ moduleid: 'y', version: '1.0.0', platform: 'android' })
		});

		assert.deepEqual(await readModules(root), []);
	});

	it('should read a manifest written with Windows line endings', async () => {
		const root = await layout({
			'android/crlf/1.0.0/manifest': 'moduleid: crlf\r\nversion: 1.0.0\r\nplatform: android\r\n'
		});

		assert.deepEqual(await readModules(root), [
			{ id: 'crlf', version: '1.0.0', platform: 'android', path: path.join(root, 'android', 'crlf', '1.0.0') }
		]);
	});

	it('should answer nothing for a directory that does not exist', async () => {
		assert.deepEqual(await readModules(path.join(os.tmpdir(), 'ti-ls-no-such-modules')), []);
	});

	it('should never unzip anything, which is what the CLI does on the way past', async () => {
		// `ti module list` extracts any zip shaped like a module beside the modules directory and
		// deletes it; reading for a completion must leave the disk as it found it
		const root = await layout({ 'android/stray.txt': '' });
		const zip = path.join(path.dirname(root), 'my-app-backup.zip');
		await fs.writeFile(zip, 'PK');

		await readModules(root);

		assert.equal(await fs.readFile(zip, 'utf-8'), 'PK');
	});
});

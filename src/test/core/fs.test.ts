import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findFiles, pathExists } from '../../core/fs.ts';

describe('core/fs', () => {
	let root: string;

	before(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'ti-ls-fs-'));
		await fs.mkdir(path.join(root, 'nested', 'deeper'), { recursive: true });
		await fs.writeFile(path.join(root, 'top.js'), '');
		await fs.writeFile(path.join(root, 'styles.tss'), '');
		await fs.writeFile(path.join(root, 'nested', 'middle.ts'), '');
		await fs.writeFile(path.join(root, 'nested', 'deeper', 'bottom.js'), '');
		await fs.writeFile(path.join(root, 'nested', 'ignored.txt'), '');
		// a directory whose name looks like a file, which extension matching alone would misread
		await fs.mkdir(path.join(root, 'nested', 'lib.js'));
	});

	after(async () => fs.rm(root, { recursive: true, force: true }));

	describe('pathExists', () => {
		it('should be true for a file and a directory', async () => {
			assert.equal(await pathExists(path.join(root, 'top.js')), true);
			assert.equal(await pathExists(path.join(root, 'nested')), true);
		});

		it('should be false for something that is not there', async () => {
			assert.equal(await pathExists(path.join(root, 'nope.js')), false);
		});
	});

	describe('findFiles', () => {
		it('should walk recursively and filter by extension', async () => {
			const found = await findFiles(root, [ '.js', '.ts' ]);
			const relative = found.map(file => path.relative(root, file).split(path.sep).join('/'));
			assert.deepEqual(relative, [ 'nested/deeper/bottom.js', 'nested/middle.ts', 'top.js' ]);
		});

		it('should not mistake a directory for a file', async () => {
			const found = await findFiles(root, [ '.js' ]);
			assert.equal(found.some(file => file.endsWith(`nested${path.sep}lib.js`)), false);
		});

		it('should return an empty list for a directory that does not exist', async () => {
			assert.deepEqual(await findFiles(path.join(root, 'no-such-dir'), [ '.js' ]), []);
		});

		it('should return an empty list when nothing matches', async () => {
			assert.deepEqual(await findFiles(root, [ '.xml' ]), []);
		});
	});
});

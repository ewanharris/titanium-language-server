import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findFiles, pathExists } from '../../core/fs';

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
			expect(await pathExists(path.join(root, 'top.js'))).to.equal(true);
			expect(await pathExists(path.join(root, 'nested'))).to.equal(true);
		});

		it('should be false for something that is not there', async () => {
			expect(await pathExists(path.join(root, 'nope.js'))).to.equal(false);
		});
	});

	describe('findFiles', () => {
		it('should walk recursively and filter by extension', async () => {
			const found = await findFiles(root, [ '.js', '.ts' ]);
			expect(found.map(file => path.relative(root, file).split(path.sep).join('/'))).to.deep.equal([
				path.join('nested', 'deeper', 'bottom.js').split(path.sep).join('/'),
				path.join('nested', 'middle.ts').split(path.sep).join('/'),
				'top.js'
			]);
		});

		it('should not mistake a directory for a file', async () => {
			const found = await findFiles(root, [ '.js' ]);
			expect(found.some(file => file.endsWith(`nested${path.sep}lib.js`))).to.equal(false);
		});

		it('should return an empty list for a directory that does not exist', async () => {
			expect(await findFiles(path.join(root, 'no-such-dir'), [ '.js' ])).to.deep.equal([]);
		});

		it('should return an empty list when nothing matches', async () => {
			expect(await findFiles(root, [ '.xml' ])).to.deep.equal([]);
		});
	});
});

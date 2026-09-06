import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { InitializeResult } from 'vscode-languageserver';
import { LspTestClient } from '../server/lsp-client.ts';
import { builtServer } from './built.ts';

/**
 * The command as a user installs it, which is the built artifact rather than the sources the rest
 * of the suite runs. Nothing here is about behaviour — that is covered from source — only about
 * the file npm links and whether starting it that way produces a server that answers.
 */
describe('the installed command', () => {

	describe('spawned through a symlink, as npm installs it', () => {
		let root: string;
		let link: string;
		let client: LspTestClient;

		before(async () => {
			// npm links a bin into node_modules/.bin rather than copying it, so argv[1] is the link
			// and not the file. Getting that wrong starts a process that answers nothing, which is
			// exactly what a user of the installed command would see.
			root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ti-ls-bin-'));
			link = path.join(root, 'titanium-language-server');
			await fsp.symlink(builtServer, link);
			client = new LspTestClient(link);
		});

		after(async () => {
			await client.dispose();
			await fsp.rm(root, { recursive: true, force: true });
		});

		it('should start and answer initialize', async (t) => {
			if (process.platform === 'win32') {
				// npm writes a .cmd shim there instead, which names the real path, so there is no
				// symlink to resolve and creating one needs privileges this may not have
				return t.skip('npm shims the command on Windows rather than linking it');
			}

			const result = await client.sendRequest<InitializeResult>('initialize', {
				processId: process.pid,
				rootUri: null,
				capabilities: {}
			});
			assert.notEqual(result.capabilities, undefined);
		});
	});

	describe('spawned directly, as the bin does', () => {
		let client: LspTestClient;

		before(() => {
			client = new LspTestClient(builtServer);
		});

		after(async () => client.dispose());

		it('should answer initialize from the built file', async () => {
			const result = await client.sendRequest<InitializeResult>('initialize', {
				processId: process.pid,
				rootUri: null,
				capabilities: {}
			});

			assert.notEqual(result.capabilities, undefined);
			assert.equal(client.stderr, '');
		});
	});
});

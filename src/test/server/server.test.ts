import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { InitializeResult } from 'vscode-languageserver';
import { LspTestClient } from './lsp-client.js';

describe('Language server', () => {

	describe('spawned directly, as an extension would via serverPath', () => {
		let client: LspTestClient;
		let result: InitializeResult;

		before(async () => {
			client = new LspTestClient();
			result = await client.sendRequest<InitializeResult>('initialize', {
				processId: process.pid,
				rootUri: null,
				capabilities: { workspace: { workspaceFolders: true } }
			});
			client.sendNotification('initialized', {});
		});

		after(async () => client.dispose());

		it('should answer initialize', () => {
			assert.notEqual(result.capabilities, undefined);
		});

		it('should write nothing unframed to stdout', () => {
			// The strict client throws on unframed output, so reaching here means the stream is
			// clean. stderr should also be quiet on a healthy start.
			assert.equal(client.stderr, '');
		});

		it('should log through window/logMessage rather than stdout', () => {
			const logs = client.notifications.filter(message => message.method === 'window/logMessage');
			assert.ok(logs.length > 0);
		});

		it('should advertise workspace folder support when the client has it', () => {
			assert.equal(result.capabilities.workspace?.workspaceFolders?.supported, true);
		});
	});

	describe('spawned via the bin', () => {
		let client: LspTestClient;

		before(() => {
			client = new LspTestClient(path.join(import.meta.dirname, '..', '..', '..', 'bin', 'titanium-language-server'));
		});

		after(async () => client.dispose());

		it('should start and answer initialize', async () => {
			// The bin cannot rely on server.js's entry-point guard, so this is a real regression test
			const result = await client.sendRequest<InitializeResult>('initialize', {
				processId: process.pid,
				rootUri: null,
				capabilities: {}
			});
			assert.notEqual(result.capabilities, undefined);
		});
	});

	describe('with a client that does not support workspace folders', () => {
		let client: LspTestClient;

		before(() => {
			client = new LspTestClient();
		});

		after(async () => client.dispose());

		it('should not advertise the capability back', async () => {
			const result = await client.sendRequest<InitializeResult>('initialize', {
				processId: process.pid,
				rootUri: null,
				capabilities: {}
			});
			assert.equal(result.capabilities.workspace, undefined);
		});
	});
});

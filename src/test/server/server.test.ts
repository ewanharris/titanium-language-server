import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import path from 'path';
import { InitializeResult } from 'vscode-languageserver';
import { LspTestClient } from './lsp-client';

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
			expect(result.capabilities).to.not.equal(undefined);
		});

		it('should write nothing unframed to stdout', () => {
			// The strict client throws on unframed output, so reaching here means the stream is
			// clean. stderr should also be quiet on a healthy start.
			expect(client.stderr).to.equal('');
		});

		it('should log through window/logMessage rather than stdout', () => {
			const logs = client.notifications.filter(message => message.method === 'window/logMessage');
			expect(logs.length).to.be.greaterThan(0);
		});

		it('should advertise workspace folder support when the client has it', () => {
			expect(result.capabilities.workspace?.workspaceFolders?.supported).to.equal(true);
		});
	});

	describe('spawned via the bin', () => {
		let client: LspTestClient;

		before(() => {
			client = new LspTestClient(path.join(__dirname, '..', '..', '..', 'bin', 'titanium-language-server'));
		});

		after(async () => client.dispose());

		it('should start and answer initialize', async () => {
			// The bin cannot rely on server.js's require.main guard, so this is a real regression test
			const result = await client.sendRequest<InitializeResult>('initialize', {
				processId: process.pid,
				rootUri: null,
				capabilities: {}
			});
			expect(result.capabilities).to.not.equal(undefined);
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
			expect(result.capabilities.workspace).to.equal(undefined);
		});
	});
});

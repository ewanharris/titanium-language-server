import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { CompletionItem, Hover, InitializeResult, Location } from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { LspTestClient } from './lsp-client.ts';
import { fixturePath } from '../fixtures.ts';

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

	describe('when the server cannot be spawned', () => {
		it('should fail the request rather than hang or throw uncaught', async () => {
			// This is what a broken bin looks like, and it used to surface as an uncaught ENOENT in
			// a hook plus a ten second timeout rather than as a failing assertion. The cause differs
			// by platform — a spawn error on POSIX, a clean exit from node on Windows — so this
			// asserts the guarantee that holds on both: it fails, and not by timing out.
			const client = new LspTestClient(path.join(import.meta.dirname, 'no-such-server'));

			await assert.rejects(
				client.sendRequest('initialize', { processId: process.pid, rootUri: null, capabilities: {} }),
				{ message: /^Server did not start: / }
			);

			client.sendNotification('initialized', {});
			await client.dispose();
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

	describe('answering a real request over the wire', () => {
		let client: LspTestClient;
		let root: string;

		const uriFor = (...segments: string[]): string => URI.file(path.join(root, ...segments)).toString();

		before(async () => {
			root = await fixturePath('alloy-project');
			client = new LspTestClient();
			await client.sendRequest<InitializeResult>('initialize', {
				processId: process.pid,
				rootUri: null,
				capabilities: { workspace: { workspaceFolders: true } },
				workspaceFolders: [ { uri: URI.file(root).toString(), name: 'alloy-project' } ]
			});
			client.sendNotification('initialized', {});

			// sent immediately, as a client does: the answer must wait for the workspace scan
			// rather than being answered against a registry that is still filling up
			client.sendNotification('textDocument/didOpen', {
				textDocument: {
					uri: uriFor('app', 'views', 'index.xml'),
					languageId: 'xml',
					version: 1,
					text: '<Alloy>\n\t<Window class="container"/>\n</Alloy>'
				}
			});
		});

		after(async () => client.dispose());

		it('should go from a class in a view to the rule that styles it', async () => {
			const found = await client.sendRequest<Location[]>('textDocument/definition', {
				textDocument: { uri: uriFor('app', 'views', 'index.xml') },
				position: { line: 1, character: 17 }
			});

			assert.equal(found.length, 1);
			assert.equal(found[0].uri, uriFor('app', 'styles', 'index.tss'));
			assert.deepEqual(found[0].range, {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 12 }
			});
		});

		it('should answer null rather than failing where there is nothing to point at', async () => {
			const found = await client.sendRequest<Location[]|null>('textDocument/definition', {
				textDocument: { uri: uriFor('app', 'views', 'index.xml') },
				position: { line: 0, character: 3 }
			});

			assert.equal(found, null);
		});

		it('should still have written nothing unframed to stdout', () => {
			assert.equal(client.stderr, '');
		});
	});

	describe('answering JavaScript requests over the wire', () => {
		// the classic fixture, because it carries its own @types/titanium: the default source list
		// ends in the npm acquirer, and a suite must not reach the network to be able to answer
		let client: LspTestClient;
		let root: string;
		let uri: string;

		before(async () => {
			root = await fixturePath('classic-project');
			uri = URI.file(path.join(root, 'Resources', 'scratch.js')).toString();

			client = new LspTestClient();
			await client.sendRequest<InitializeResult>('initialize', {
				processId: process.pid,
				rootUri: null,
				capabilities: {
					workspace: { workspaceFolders: true },
					textDocument: { hover: { contentFormat: [ 'markdown', 'plaintext' ] } }
				},
				workspaceFolders: [ { uri: URI.file(root).toString(), name: 'classic-project' } ]
			});
			client.sendNotification('initialized', {});

			client.sendNotification('textDocument/didOpen', {
				textDocument: {
					uri,
					languageId: 'javascript',
					version: 1,
					text: 'const win = Ti.UI.createLabel();\nwin.'
				}
			});
		});

		after(async () => client.dispose());

		it('should offer the members of a local', async () => {
			// structurally impossible for the implementation being replaced, which could only match
			// an expression against a table of api names
			const items = await client.sendRequest<CompletionItem[]>('textDocument/completion', {
				textDocument: { uri },
				position: { line: 1, character: 4 }
			});

			assert.ok(items.some(item => item.label === 'text'), 'expected the members of the local');
		});

		it('should resolve the documentation for one entry', async () => {
			const items = await client.sendRequest<CompletionItem[]>('textDocument/completion', {
				textDocument: { uri },
				position: { line: 1, character: 4 }
			});
			const item = items.find(entry => entry.label === 'text');
			assert.ok(item, 'expected the entry to resolve');

			const resolved = await client.sendRequest<CompletionItem>('completionItem/resolve', item);

			assert.match(String(resolved.documentation), /The text to display/);
		});

		it('should answer hover with the real type', async () => {
			const hover = await client.sendRequest<Hover>('textDocument/hover', {
				textDocument: { uri },
				position: { line: 1, character: 1 }
			});

			assert.match(JSON.stringify(hover.contents), /Label/);
		});

		it('should still have written nothing unframed to stdout', () => {
			assert.equal(client.stderr, '');
		});
	});

	describe('answering what the project declares, over the wire', () => {
		// the classic fixture again, for its own @types/titanium — and because L and the i18n it
		// reads are classic's as much as Alloy's
		let client: LspTestClient;
		let uri: string;

		before(async () => {
			const root = await fixturePath('classic-project');
			uri = URI.file(path.join(root, 'Resources', 'scratch.js')).toString();

			client = new LspTestClient();
			await client.sendRequest<InitializeResult>('initialize', {
				processId: process.pid,
				rootUri: null,
				capabilities: { workspace: { workspaceFolders: true } },
				workspaceFolders: [ { uri: URI.file(root).toString(), name: 'classic-project' } ]
			});
			client.sendNotification('initialized', {});

			client.sendNotification('textDocument/didOpen', {
				textDocument: { uri, languageId: 'javascript', version: 1, text: 'L(\'' }
			});
		});

		after(async () => client.dispose());

		it('should offer the translation keys to L', async () => {
			const items = await client.sendRequest<CompletionItem[]>('textDocument/completion', {
				textDocument: { uri },
				position: { line: 0, character: 3 }
			});

			assert.ok(items.some(item => item.label === 'classicOnly'), 'expected the classic project\'s own strings');
		});

		it('should still have written nothing unframed to stdout', () => {
			assert.equal(client.stderr, '');
		});
	});
});

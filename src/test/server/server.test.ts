import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { DefinitionLink, Location, ApplyWorkspaceEditParams } from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { LspTestClient } from './lsp-client';
import { getFixturePath, getFixtureUri } from '../test-util';

async function initialize (client: LspTestClient, fixture: string): Promise<void> {
	const rootUri = await getFixtureUri(fixture);
	await client.sendRequest('initialize', {
		processId: process.pid,
		rootUri,
		capabilities: { workspace: { workspaceFolders: true } },
		workspaceFolders: [ { uri: rootUri, name: path.basename(fixture) } ]
	});
	client.sendNotification('initialized', {});
}

async function openDocument (client: LspTestClient, fixture: string, languageId: string, text: string): Promise<string> {
	const uri = await getFixtureUri(fixture);
	client.sendNotification('textDocument/didOpen', {
		textDocument: { uri, languageId, version: 1, text }
	});
	return uri;
}

describe('Language server', () => {

	describe('in a Titanium project', () => {
		let client: LspTestClient;

		before(async () => {
			client = new LspTestClient();
			await initialize(client, 'alloy-project');
		});

		after(async () => client.dispose());

		it('should not write anything unframed to stdout', async () => {
			// Every one of these used to log to stdout, which corrupts the JSON-RPC stream. The
			// test client throws on any output that is not a framed message.
			const uri = await openDocument(client, 'alloy-project/app/views/sample.xml', 'xml', '<Alloy>\n<Widget src="widget-test" />\n</Alloy>\n');
			await client.sendRequest('textDocument/definition', {
				textDocument: { uri }, position: { line: 1, character: 16 }
			});
			await client.sendRequest('textDocument/hover', {
				textDocument: { uri }, position: { line: 1, character: 16 }
			});
			expect(client.stderr).to.equal('');
		});

		it('should log through window/logMessage rather than stdout', () => {
			const logs = client.notifications.filter(message => message.method === 'window/logMessage');
			expect(logs.length).to.be.greaterThan(0);
		});

		it('should return file uris for definitions', async () => {
			const uri = await openDocument(client, 'alloy-project/app/views/sample.xml', 'xml', '<Alloy>\n<Widget src="widget-test" />\n</Alloy>\n');
			const definitions = await client.sendRequest<DefinitionLink[]>('textDocument/definition', {
				textDocument: { uri }, position: { line: 1, character: 16 }
			});
			expect(definitions).to.have.lengthOf(1);
			expect(definitions[0].targetUri).to.equal(await getFixtureUri('alloy-project/app/widgets/widget-test/controllers/widget.js'));
		});

		it('should return file uris for locations', async () => {
			const uri = await openDocument(client, 'alloy-project/app/views/sample.xml', 'xml', '<Alloy>\n<Label class="testClass" />\n</Alloy>\n');
			const locations = await client.sendRequest<Location[]>('textDocument/definition', {
				textDocument: { uri }, position: { line: 1, character: 16 }
			});
			expect(locations).to.have.lengthOf(1);
			expect(locations[0].uri).to.equal(await getFixtureUri('alloy-project/app/styles/sample.tss'));
		});

		it('should route a tss document to the tss provider', async () => {
			const uri = await openDocument(client, 'alloy-project/app/styles/sample.tss', 'alloy-tss', '"#container": {\n}\n');
			const locations = await client.sendRequest<Location[]>('textDocument/definition', {
				textDocument: { uri }, position: { line: 0, character: 5 }
			});
			expect(locations).to.have.lengthOf(1);
			expect(locations[0].uri).to.equal(await getFixtureUri('alloy-project/app/views/sample.xml'));
		});

		it('should map the editor specific language ids', async () => {
			// Pulsar reports the grammar name, with different casing to the VS Code language id
			const uri = await openDocument(client, 'alloy-project/app/styles/sample.tss', 'Alloy (TSS)', '"#container": {\n}\n');
			const locations = await client.sendRequest<Location[]>('textDocument/definition', {
				textDocument: { uri }, position: { line: 0, character: 5 }
			});
			expect(locations).to.have.lengthOf(1);
			expect(locations[0].uri).to.equal(await getFixtureUri('alloy-project/app/views/sample.xml'));
		});

		it('should route a TypeScript controller to the JavaScript provider', async () => {
			const uri = await openDocument(client, 'alloy-project/app/controllers/ts-lookup.ts', 'typescript', 'import http from \'/http\';\n');
			const definitions = await client.sendRequest<DefinitionLink[]>('textDocument/definition', {
				textDocument: { uri }, position: { line: 0, character: 20 }
			});
			expect(definitions).to.have.lengthOf(1);
			expect(definitions[0].targetUri).to.equal(await getFixtureUri('alloy-project/app/lib/http.js'));
		});

		it('should report a failure to load completions as no completions', async () => {
			// The completions files are generated by the editor plugin, so they will not be there
			// in a fresh install. That must not fail the request.
			const uri = await openDocument(client, 'alloy-project/app/controllers/sample.js', 'javascript', 'Ti.UI.createWin');
			const completions = await client.sendRequest('textDocument/completion', {
				textDocument: { uri }, position: { line: 0, character: 15 }
			});
			expect(completions).to.equal(null);
			expect(client.stderr).to.equal('');
		});
	});

	describe('executing the insert code action command', () => {
		let client: LspTestClient;
		let target: string;
		let edit: ApplyWorkspaceEditParams|undefined;

		before(async () => {
			target = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'ti-ls-')), 'sample.tss');
			await fs.writeFile(target, '"#container": {\n}\n');

			client = new LspTestClient();
			client.onRequest('workspace/applyEdit', params => {
				edit = params as ApplyWorkspaceEditParams;
				return { applied: true };
			});
			await initialize(client, 'alloy-project');
			await client.sendRequest('workspace/executeCommand', {
				command: 'titanium.insertCodeAction',
				arguments: [ '\n"#newId": {\n}\n', target ]
			});
			await client.waitForRequest('workspace/applyEdit');
		});

		after(async () => {
			await client.dispose();
			await fs.remove(path.dirname(target));
		});

		it('should address the edit with a file uri', () => {
			const change = edit?.edit.documentChanges?.[0];
			expect(change).to.not.equal(undefined);
			expect((change as { textDocument: { uri: string } }).textDocument.uri).to.equal(URI.file(target).toString());
		});

		it('should not assert against a document version it does not know', () => {
			const change = edit?.edit.documentChanges?.[0] as { textDocument: { version: number|null } };
			expect(change.textDocument.version).to.equal(null);
		});

		it('should insert at the end of the file', () => {
			const change = edit?.edit.documentChanges?.[0] as { edits: { range: { start: { line: number; character: number } } }[] };
			// The fixture is 2 lines plus a trailing newline, so the end of the file is line 2
			expect(change.edits[0].range.start).to.deep.equal({ line: 2, character: 0 });
		});
	});

	describe('in a directory that is not a Titanium project', () => {
		let client: LspTestClient;

		before(async () => {
			client = new LspTestClient();
			await initialize(client, 'not-a-project');
		});

		after(async () => client.dispose());

		it('should not register the directory as a project', async () => {
			const uri = URI.file(path.join(await getFixturePath('not-a-project'), 'app', 'controllers', 'index.js')).toString();
			client.sendNotification('textDocument/didOpen', {
				textDocument: { uri, languageId: 'javascript', version: 1, text: 'Ti.UI.createWin' }
			});
			const completions = await client.sendRequest('textDocument/completion', {
				textDocument: { uri }, position: { line: 0, character: 15 }
			});
			// No project, so nothing to complete, and importantly no error response
			expect(completions).to.equal(null);
			expect(client.stderr).to.equal('');
		});
	});
});

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { URI } from 'vscode-uri';
import { TiLanguageService } from '../../server/service.ts';
import { logger } from '../../logger.ts';
import { FakeConnection } from './fake-connection.ts';
import { fixturePath } from '../fixtures.ts';

describe('The language service adapter', () => {

	let connection: FakeConnection;
	let service: TiLanguageService;
	let root: string;

	const uriFor = (...segments: string[]): string => URI.file(path.join(root, ...segments)).toString();

	beforeEach(async () => {
		root = await fixturePath('alloy-project');
		connection = new FakeConnection();
		service = new TiLanguageService(connection.asConnection());
		service.listen();
	});

	afterEach(() => logger.detach());

	describe('initialize', () => {
		it('should advertise what it can do', async () => {
			const result = await connection.initialize();

			assert.equal(result.capabilities.definitionProvider, true);
			assert.notEqual(result.capabilities.textDocumentSync, undefined);
		});

		it('should register the projects in the workspace folders', async () => {
			await connection.initialize({
				capabilities: { workspace: { workspaceFolders: true } },
				workspaceFolders: [ { uri: URI.file(root).toString(), name: 'alloy-project' } ]
			});

			assert.deepEqual(service.registry.projects.map(project => project.filePath), [ root ]);
		});

		it('should fall back to rootUri for a client that has no workspace folders', async () => {
			await connection.initialize({ rootUri: URI.file(root).toString() });

			assert.deepEqual(service.registry.projects.map(project => project.filePath), [ root ]);
			assert.equal(service.registry.projects.length, 1);
		});

		it('should register nothing when the client opens no folder at all', async () => {
			await connection.initialize();

			assert.deepEqual(service.registry.projects, []);
		});

		it('should start the connection and the document manager when told to listen', () => {
			assert.equal(connection.listening, true);
		});
	});

	describe('workspace folder changes', () => {
		beforeEach(async () => {
			await connection.initialize({ capabilities: { workspace: { workspaceFolders: true } } });
		});

		it('should register a folder that is added', async () => {
			await connection.changeWorkspaceFolders({ added: [ { uri: URI.file(root).toString(), name: 'alloy' } ], removed: [] });

			assert.deepEqual(service.registry.projects.map(project => project.filePath), [ root ]);
		});

		it('should forget a folder that is removed', async () => {
			const folder = { uri: URI.file(root).toString(), name: 'alloy' };

			await connection.changeWorkspaceFolders({ added: [ folder ], removed: [] });
			await connection.changeWorkspaceFolders({ added: [], removed: [ folder ] });

			assert.deepEqual(service.registry.projects, []);
		});
	});

	describe('definition', () => {
		beforeEach(async () => {
			await connection.initialize({ rootUri: URI.file(root).toString() });
		});

		it('should answer with the rule that styles the class under the cursor', async () => {
			const uri = uriFor('app', 'views', 'index.xml');
			connection.open(uri, 'xml', '<Alloy>\n\t<Window class="container"/>\n</Alloy>');

			const found = await connection.definition(uri, 1, 17);

			assert.equal(found?.length, 1);
			assert.equal(found?.[0].uri, uriFor('app', 'styles', 'index.tss'));
			// the rule sits on the first line of the stylesheet
			assert.deepEqual(found?.[0].range.start, { line: 0, character: 0 });
			assert.deepEqual(found?.[0].range.end, { line: 0, character: 12 });
		});

		it('should answer from the buffer being edited rather than the file on disk', async () => {
			const uri = uriFor('app', 'views', 'index.xml');
			connection.open(uri, 'xml', '<Alloy/>');
			connection.change(uri, '<Alloy>\n\t<Window class="container"/>\n</Alloy>');

			assert.equal((await connection.definition(uri, 1, 17))?.length, 1);
		});

		it('should read from disk again once the document is closed', async () => {
			const uri = uriFor('app', 'views', 'index.xml');
			connection.open(uri, 'xml', '<Alloy/>');
			connection.close(uri);

			// index.xml on disk styles a container, the buffer that replaced it did not
			assert.equal((await connection.definition(uri, 1, 17))?.length, 1);
		});

		it('should answer nothing for a document in no project', async () => {
			const outside = URI.file(path.join(path.dirname(root), 'elsewhere', 'app', 'views', 'index.xml')).toString();
			connection.open(outside, 'xml', '<Alloy><Window class="container"/></Alloy>');

			assert.equal(await connection.definition(outside, 0, 24), null);
		});

		it('should answer nothing for a file that is not a view', async () => {
			// the same class name, in a stylesheet rather than in a view
			const uri = uriFor('app', 'styles', 'index.tss');
			connection.open(uri, 'tss', '".container": {}');

			assert.equal(await connection.definition(uri, 0, 4), null);
		});

		it('should answer nothing where there is no rule to point at', async () => {
			const uri = uriFor('app', 'views', 'index.xml');
			connection.open(uri, 'xml', '<Alloy>\n\t<Window class="nothingStylesThis"/>\n</Alloy>');

			assert.equal(await connection.definition(uri, 1, 17), null);
		});

		it('should route on a grammar name as well as a language id', async () => {
			// Pulsar reports the grammar rather than a VS Code language id
			const uri = uriFor('app', 'views', 'index.xml');
			connection.open(uri, 'Alloy (XML)', '<Alloy>\n\t<Window class="container"/>\n</Alloy>');

			assert.equal((await connection.definition(uri, 1, 17))?.length, 1);
		});
	});

	describe('when a provider throws', () => {
		beforeEach(async () => {
			await connection.initialize({ rootUri: URI.file(root).toString() });
		});

		it('should answer nothing and log it, rather than failing the request', async () => {
			service.registry.projectFor = (): never => {
				throw new Error('the sky fell in');
			};
			const uri = uriFor('app', 'views', 'index.xml');
			connection.open(uri, 'xml', '<Alloy><Window class="container"/></Alloy>');

			assert.equal(await connection.definition(uri, 0, 24), null);
			assert.ok(connection.errors.some(message => message.includes('the sky fell in')));
		});
	});
});

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { URI } from 'vscode-uri';
import { TiLanguageService } from '../../server/service.ts';
import { Project } from '../../core/project.ts';
import { ProjectTypes } from '../../core/typescript/types.ts';
import type { TypesSource } from '../../core/typescript/types.ts';
import { logger } from '../../logger.ts';
import { FakeConnection } from './fake-connection.ts';
import { fixturePath } from '../fixtures.ts';

/**
 * A source that lends every project the stub the classic fixture installs.
 *
 * The Alloy fixture deliberately carries no node_modules — that `ProjectTypes` answers nothing for
 * it is asserted elsewhere, and the warning it produces is tested here — so a test that needs an
 * Alloy project with types resolved says so rather than installing types into the fixture.
 */
const lentTypes: TypesSource = {
	name: 'the stub',
	locate: async () => new ProjectTypes().locate(new Project(await fixturePath('classic-project')))
};

describe('The language service adapter', () => {

	let connection: FakeConnection;
	let service: TiLanguageService;
	let root: string;

	const uriFor = (...segments: string[]): string => URI.file(path.join(root, ...segments)).toString();

	beforeEach(async () => {
		root = await fixturePath('alloy-project');
		connection = new FakeConnection();
		// the project's own types only: the default list ends in the npm acquirer, and a test suite
		// must not reach the network to find out what it resolves
		service = new TiLanguageService(connection.asConnection(), [ new ProjectTypes() ]);
		service.listen();
	});

	afterEach(() => logger.detach());

	describe('initialize', () => {
		it('should advertise what it can do', async () => {
			const result = await connection.initialize();

			assert.equal(result.capabilities.definitionProvider, true);
			assert.notEqual(result.capabilities.textDocumentSync, undefined);
		});

		it('should record what the client can do', async () => {
			await connection.initialize({
				capabilities: {
					textDocument: {
						completion: { completionItem: { snippetSupport: true } },
						codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: [] } } }
					},
					window: { showDocument: { support: true } },
					workspace: { workspaceFolders: true }
				}
			});

			assert.equal(service.capabilities.snippets, true);
			assert.equal(service.capabilities.showDocument, true);
			assert.equal(service.capabilities.codeActionLiterals, true);
			assert.equal(service.capabilities.workspaceFolders, true);
		});

		it('should assume nothing of a client that declares nothing', async () => {
			// an editor that sends an empty capability set gets the careful path, not the VS Code
			// one — this is the case that broke the implementation being replaced
			await connection.initialize({ capabilities: {} });

			assert.equal(service.capabilities.snippets, false);
			assert.equal(service.capabilities.showDocument, false);
			assert.equal(service.capabilities.codeActionLiterals, false);
			assert.equal(service.capabilities.workspaceFolders, false);
		});

		it('should have answers before a client has said anything', async () => {
			// a request can arrive before initialize in a misbehaving client, and reading a
			// capability then must be false rather than a crash on undefined
			assert.equal(service.capabilities.snippets, false);
			assert.equal(service.capabilities.workspaceFolders, false);
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

	describe('language services', () => {
		it('should hold a warmed service for each registered project', async () => {
			// warming at registration is the point: the cold parse of the Titanium types is 623ms and
			// must not land on the first keystroke. The classic fixture is the one carrying types.
			const classic = await fixturePath('classic-project');

			await connection.initialize({ rootUri: URI.file(classic).toString() });

			const project = service.registry.projects[0];
			assert.equal(service.services.get(project)?.warmed, true);
		});

		it('should tell the client where the types came from', async () => {
			const classic = await fixturePath('classic-project');

			await connection.initialize({ rootUri: URI.file(classic).toString() });

			assert.ok(connection.logs.some(message => /@types\/titanium/.test(message)),
				'expected the types resolution to be reported');
		});

		it('should warn through the client when no types resolved', async () => {
			// a warning is worth interrupting for: the JavaScript features are simply unavailable, and
			// silence would read as the server being broken. Info is only logged — the types trail
			// the SDK on nearly every project and a message about that would be noise.
			await connection.initialize({ rootUri: URI.file(root).toString() });

			assert.ok(connection.warnings.some(message => /No @types\/titanium could be resolved/.test(message)),
				'expected a warning naming the unresolved SDK');
		});

		it('should carry on with the other projects when one cannot be opened', async () => {
			// resolving types can reach the network, and one project that cannot be served is not a
			// reason to leave the rest of the workspace without a registry
			service.services.open = (): never => {
				throw new Error('npm is not answering');
			};

			await connection.initialize({ rootUri: URI.file(root).toString() });

			assert.equal(service.registry.projects.length, 1);
			assert.ok(connection.errors.some(message => message.includes('npm is not answering')));
		});

		it('should dispose the service for a folder that is removed', async () => {
			await connection.initialize({ capabilities: { workspace: { workspaceFolders: true } } });
			const folder = { uri: URI.file(root).toString(), name: 'alloy' };
			await connection.changeWorkspaceFolders({ added: [ folder ], removed: [] });
			const project = service.registry.projects[0];
			assert.ok(service.services.get(project), 'expected a service to have been opened');

			await connection.changeWorkspaceFolders({ added: [], removed: [ folder ] });

			assert.equal(service.services.get(project), undefined);
		});

		it('should register the project even when its types cannot be resolved', async () => {
			// a missing type package makes the JavaScript features unavailable; it does not make the
			// project invalid, and every other feature still has to work
			await connection.initialize({ rootUri: URI.file(root).toString() });

			assert.equal(service.registry.projects.length, 1);
			assert.equal(service.services.get(service.registry.projects[0])?.types, undefined);
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

	/**
	 * A server over a fixture project with types resolved, ready to be asked.
	 *
	 * Replaces the one the outer setup built rather than adding a second, so the logger stays
	 * attached to exactly one connection and `afterEach` still detaches it.
	 *
	 * @param fixture - The fixture directory name
	 * @returns {Promise<string>} The project root
	 */
	async function serverOn (fixture: string): Promise<string> {
		const projectRoot = await fixturePath(fixture);

		connection = new FakeConnection();
		service = new TiLanguageService(connection.asConnection(), [ lentTypes ]);
		service.listen();
		await connection.initialize({ rootUri: URI.file(projectRoot).toString() });

		return projectRoot;
	}

	/**
	 * The URI for a path inside a project
	 *
	 * @param projectRoot - The project directory
	 * @param segments - The path within it
	 * @returns {string} The URI
	 */
	function uriIn (projectRoot: string, ...segments: string[]): string {
		return URI.file(path.join(projectRoot, ...segments)).toString();
	}

	describe('completion', () => {
		it('should be advertised, with resolve and the characters that start a completion', async () => {
			const result = await connection.initialize();

			assert.equal(result.capabilities.completionProvider?.resolveProvider, true);
			assert.ok(result.capabilities.completionProvider?.triggerCharacters?.includes('.'),
				'expected a dot to start a completion');
		});

		it('should offer the Titanium API in a classic project', async () => {
			const projectRoot = await serverOn('classic-project');
			const uri = uriIn(projectRoot, 'Resources', 'scratch.js');
			connection.open(uri, 'javascript', 'Ti.UI.');

			const items = await connection.completion(uri, 0, 'Ti.UI.'.length);

			assert.ok(items?.some(item => item.label === 'createWindow'), 'expected the Titanium API');
		});

		it('should offer members on a local, for both project types', async () => {
			// the single biggest gain over the implementation being replaced, which could only
			// match an expression against a table of api names and so had nothing to say here
			for (const [ fixture, directory ] of [ [ 'classic-project', 'Resources' ], [ 'alloy-project', path.join('app', 'lib') ] ] as const) {
				const projectRoot = await serverOn(fixture);
				const uri = uriIn(projectRoot, directory, 'scratch.js');
				connection.open(uri, 'javascript', 'const win = Ti.UI.createWindow();\nwin.');

				const items = await connection.completion(uri, 1, 'win.'.length);

				assert.ok(items?.some(item => item.label === 'title'), `expected members on a local in ${fixture}`);
				assert.ok(items?.some(item => item.label === 'open'), `expected inherited members in ${fixture}`);
			}
		});

		it('should offer the ids of a controller\'s view on $', async () => {
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'controllers', 'index.js');
			connection.open(uri, 'javascript', '$.');

			const items = await connection.completion(uri, 0, '$.'.length);

			assert.ok(items?.some(item => item.label === 'label'), 'expected the view id to reach $');
		});

		it('should offer the members of an id on $', async () => {
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'controllers', 'index.js');
			connection.open(uri, 'javascript', '$.label.');

			const items = await connection.completion(uri, 0, '$.label.'.length);

			assert.ok(items?.some(item => item.label === 'text'), 'expected the members of the tag the id resolves to');
		});

		it('should not leak one controller\'s ids into the next', async () => {
			// every declaration declares $, so asking about a second controller has to take the
			// first back out rather than leave both in the program
			const projectRoot = await serverOn('alloy-project');
			const index = uriIn(projectRoot, 'app', 'controllers', 'index.js');
			const sample = uriIn(projectRoot, 'app', 'controllers', 'sample.js');

			connection.open(index, 'javascript', '$.');
			connection.open(sample, 'javascript', '$.');
			await connection.completion(index, 0, '$.'.length);
			const items = await connection.completion(sample, 0, '$.'.length);

			assert.ok(items?.some(item => item.label === 'scrollView'), 'expected the ids of the controller asked about');
			assert.ok(!items?.some(item => item.label === 'label'), 'expected the other controller\'s ids to be gone');
		});

		it('should answer from the buffer rather than from what is on disk', async () => {
			// reading disk is wrong by one keystroke, which is every keystroke a user makes
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'views', 'index.xml');
			const controller = uriIn(projectRoot, 'app', 'controllers', 'index.js');

			connection.open(controller, 'javascript', '$.');
			connection.open(uri, 'xml', '<Alloy><Window id="renamed"/></Alloy>');
			const items = await connection.completion(controller, 0, '$.'.length);

			assert.ok(items?.some(item => item.label === 'renamed'), 'expected the unsaved view');
			assert.ok(!items?.some(item => item.label === 'label'), 'expected what the view no longer says to be gone');
		});

		it('should answer nothing for a file the language service has nothing to say about', async () => {
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'styles', 'index.tss');
			connection.open(uri, 'tss', '".container": {}');

			assert.equal(await connection.completion(uri, 0, 3), null);
		});

		it('should answer nothing for a file in no registered project', async () => {
			const projectRoot = await serverOn('alloy-project');
			const uri = URI.file(path.join(path.dirname(projectRoot), 'not-a-project', 'stray.js')).toString();
			connection.open(uri, 'javascript', 'Ti.');

			assert.equal(await connection.completion(uri, 0, 3), null);
		});

		it('should answer nothing in a project whose service could not be opened', async () => {
			// the project is registered and every other feature still works; the JavaScript ones
			// have nothing behind them, and that is an empty answer rather than a failed request
			const projectRoot = await fixturePath('classic-project');
			connection = new FakeConnection();
			service = new TiLanguageService(connection.asConnection(), [ lentTypes ]);
			service.services.open = (): never => {
				throw new Error('npm is not answering');
			};
			service.listen();
			await connection.initialize({ rootUri: URI.file(projectRoot).toString() });

			const uri = uriIn(projectRoot, 'Resources', 'scratch.js');
			connection.open(uri, 'javascript', 'Ti.UI.');

			assert.equal(await connection.completion(uri, 0, 'Ti.UI.'.length), null);
		});
	});

	describe('completion resolve', () => {
		it('should fill in the detail only when the client asks for it', async () => {
			// documentation per entry is the expensive half, and a client asks for it once, for the
			// one entry it is showing
			const projectRoot = await serverOn('classic-project');
			const uri = uriIn(projectRoot, 'Resources', 'scratch.js');
			connection.open(uri, 'javascript', 'Ti.UI.');

			const items = await connection.completion(uri, 0, 'Ti.UI.'.length);
			const item = items?.find(entry => entry.label === 'createLabel');
			assert.ok(item, 'expected the entry to resolve the detail of');
			assert.equal(item.documentation, undefined);

			const resolved = await connection.resolveCompletion(item);

			assert.match(String(resolved.documentation), /Creates a label/);
			assert.ok(resolved.detail, 'expected the signature');
		});

		it('should hand back an item it cannot place unchanged', async () => {
			// a client may resolve an item this server never sent, and an item with no detail is a
			// better answer than a failed request
			await serverOn('classic-project');

			assert.deepEqual(await connection.resolveCompletion({ label: 'whatever' }), { label: 'whatever' });
		});

		it('should hand back an item whose detail the language service has nothing for', async () => {
			// the position is real and the entry is not: a stale list, or a buffer that has moved on
			const projectRoot = await serverOn('classic-project');
			const uri = uriIn(projectRoot, 'Resources', 'scratch.js');
			connection.open(uri, 'javascript', 'Ti.UI.');

			const item = { label: 'noSuchMember', data: { uri, offset: 'Ti.UI.'.length } };

			assert.deepEqual(await connection.resolveCompletion(item), item);
		});
	});

	describe('hover', () => {
		it('should be advertised', async () => {
			assert.equal((await connection.initialize()).capabilities.hoverProvider, true);
		});

		it('should carry the real type of a local, with its documentation', async () => {
			const projectRoot = await serverOn('classic-project');
			const uri = uriIn(projectRoot, 'Resources', 'scratch.js');
			connection.open(uri, 'javascript', 'const win = Ti.UI.createLabel();\nwin.text');

			const hover = await connection.hover(uri, 1, 5);

			assert.match(JSON.stringify(hover?.contents), /The text to display/);
		});

		it('should say what an id on $ is', async () => {
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'controllers', 'index.js');
			connection.open(uri, 'javascript', '$.label');

			const hover = await connection.hover(uri, 0, 4);

			assert.match(JSON.stringify(hover?.contents), /Label/);
		});

		it('should answer nothing where there is nothing to say', async () => {
			const projectRoot = await serverOn('classic-project');
			const uri = uriIn(projectRoot, 'Resources', 'scratch.js');
			connection.open(uri, 'javascript', '\n\n');

			assert.equal(await connection.hover(uri, 0, 0), null);
		});

		it('should answer nothing for a file the language service has nothing to say about', async () => {
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'styles', 'index.tss');
			connection.open(uri, 'tss', '".container": {}');

			assert.equal(await connection.hover(uri, 0, 3), null);
		});
	});

	describe('definition in JavaScript', () => {
		it('should jump from an id on $ into the view that declares it', async () => {
			// the answer maps back to the view the user wrote, never into the generated declaration
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'controllers', 'index.js');
			connection.open(uri, 'javascript', '$.label.text');

			const found = await connection.definition(uri, 0, 4);

			assert.equal(found?.length, 1);
			assert.equal(found?.[0].uri, uriIn(projectRoot, 'app', 'views', 'index.xml'));
		});

		it('should jump to a local declaration in a classic project', async () => {
			const projectRoot = await serverOn('classic-project');
			const uri = uriIn(projectRoot, 'Resources', 'scratch.js');
			connection.open(uri, 'javascript', 'const win = Ti.UI.createWindow();\nwin.open();');

			const found = await connection.definition(uri, 1, 1);

			assert.equal(found?.[0].uri, uri);
			assert.deepEqual(found?.[0].range.start, { line: 0, character: 6 });
		});

		it('should answer nothing where nothing is declared', async () => {
			const projectRoot = await serverOn('classic-project');
			const uri = uriIn(projectRoot, 'Resources', 'scratch.js');
			connection.open(uri, 'javascript', '\n\n');

			assert.equal(await connection.definition(uri, 0, 0), null);
		});

		it('should cross a require the way each project type resolves it', async () => {
			// the same specifier names a different file in each: classic resolves against
			// Resources, Alloy against app/lib. An Alloy-only fixture hides the classic half
			const cases = [
				{ fixture: 'classic-project', from: [ 'Resources', 'scratch.js' ], specifier: 'lib/http', target: [ 'Resources', 'lib', 'http.js' ], member: 'noop' },
				{ fixture: 'alloy-project', from: [ 'app', 'controllers', 'scratch.js' ], specifier: 'folder/custom-view', target: [ 'app', 'lib', 'folder', 'custom-view.js' ], member: 'createCustomView' }
			] as const;

			for (const { fixture, from, specifier, target, member } of cases) {
				const projectRoot = await serverOn(fixture);
				const uri = uriIn(projectRoot, ...from);
				const text = `const required = require('${specifier}');\nrequired.${member}`;
				connection.open(uri, 'javascript', text);

				const found = await connection.definition(uri, 1, `required.${member}`.length - 1);

				assert.equal(found?.length, 1, `expected ${specifier} to resolve in ${fixture}`);
				assert.equal(found?.[0].uri, uriIn(projectRoot, ...target));
			}
		});
	});

	describe('regressions from the implementation being replaced', () => {
		// Each of these was a real bug, found once and fixed once. The approach that produced them
		// matched the text before the cursor against a table of api names with regular expressions;
		// answering through the language service makes most of them structurally impossible rather
		// than merely fixed. They are asserted anyway, because "impossible" is a claim about the
		// current design and the next one has to keep them true.

		it('should complete an id on $ that contains the letters of a Titanium prefix', async () => {
			// the `Ti|Titanium` branch ran before the `$.` branches and its expression was
			// unanchored and case insensitive, so it swallowed any id containing "ti" and
			// `$.activityIndicator` answered nothing at all
			const projectRoot = await serverOn('alloy-project');
			const view = uriIn(projectRoot, 'app', 'views', 'index.xml');
			const controller = uriIn(projectRoot, 'app', 'controllers', 'index.js');

			connection.open(view, 'xml', '<Alloy><ActivityIndicator id="activityIndicator"/></Alloy>');
			connection.open(controller, 'javascript', '$.activityIndicator.');

			const items = await connection.completion(controller, 0, '$.activityIndicator.'.length);

			assert.ok(items?.some(item => item.label === 'message'), 'expected the members of the id');
		});

		it('should complete an api name that is not at the start of the line', async () => {
			// the name was derived by splitting the whole line, so an assignment or any indentation
			// at all put something in front of it and the answer came back empty
			const projectRoot = await serverOn('classic-project');
			const uri = uriIn(projectRoot, 'Resources', 'scratch.js');

			for (const line of [ 'const win = Ti.UI.', '  Ti.UI.', '\t\tTi.UI.', 'foo(Ti.UI.' ]) {
				connection.open(uri, 'javascript', line);

				const items = await connection.completion(uri, 0, line.length);

				assert.ok(items?.some(item => item.label === 'createWindow'), `expected completions after ${JSON.stringify(line)}`);
			}
		});

		it('should complete inside the platform namespaces', async () => {
			// Ti.UI.iOS and Ti.UI.iPad had to be folded in by hand and were not, so `Ti.UI.iOS.`
			// answered nothing. Through the language service they are namespaces like any other
			const projectRoot = await serverOn('classic-project');
			const uri = uriIn(projectRoot, 'Resources', 'scratch.js');

			for (const [ expression, expected ] of [ [ 'Ti.UI.iOS.', 'createNavigationWindow' ], [ 'Ti.UI.iPad.', 'createSplitWindow' ] ] as const) {
				connection.open(uri, 'javascript', expression);

				const items = await connection.completion(uri, 0, expression.length);

				assert.ok(items?.some(item => item.label === expected), `expected ${expected} after ${expression}`);
			}
		});

		it('should answer for a tag whose type the types do not have, without taking $ down with it', async () => {
			// reading `types[apiName].events` unguarded crashed the whole answer: 42 tags in the
			// 10.1.0 data have an apiName with no matching type
			const projectRoot = await serverOn('alloy-project');
			const view = uriIn(projectRoot, 'app', 'views', 'index.xml');
			const controller = uriIn(projectRoot, 'app', 'controllers', 'index.js');

			connection.open(view, 'xml', '<Alloy><Window id="win"><Annotation id="pin"/><Label id="label"/></Window></Alloy>');
			connection.open(controller, 'javascript', '$.');

			const items = await connection.completion(controller, 0, '$.'.length);

			assert.ok(items?.some(item => item.label === 'pin'), 'expected the id whose type is unknown');
			assert.ok(items?.some(item => item.label === 'label'), 'expected the ids beside it');
		});

		it('should point a definition at a path rather than at a URI with one inside it', async () => {
			// `path.dirname` on a `file://` URI produced targets like `/file:/home/...`, which no
			// editor can open. Core deals in paths, and the URI is built back at the very edge
			const projectRoot = await serverOn('alloy-project');
			const controller = uriIn(projectRoot, 'app', 'controllers', 'index.js');
			connection.open(controller, 'javascript', '$.label.text');

			const found = await connection.definition(controller, 0, 4);

			assert.ok(found?.length, 'expected somewhere to jump to');
			for (const location of found) {
				assert.ok(location.uri.startsWith('file:///'), `${location.uri} should be a file URI`);
				assert.doesNotMatch(location.uri, /file%3A|\/file:/, `${location.uri} carries a URI inside a path`);
			}
		});
	});
});

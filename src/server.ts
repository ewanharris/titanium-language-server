import fs from 'fs-extra';
import path from 'path';
import * as vls from 'vscode-languageserver/node';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';
import { Project } from './project';
import { URI } from 'vscode-uri';
import { Provider } from './languages';
import { JSProvider } from './languages/javascript';
import { TSSProvider } from './languages/tss';
import { XMLProvider } from './languages/view';
import { TiappProvider } from './languages/tiapp';
import { logger } from './logger';

/**
 * The document, project and provider needed to service a request
 */
interface RequestContext {
	textDocument: TextDocument;
	project: Project;
	provider: Provider;
}

export class TiLanguageService {

	connection: vls.Connection;
	documents: vls.TextDocuments<TextDocument>;
	languageProviders: Map<string, Provider>;
	projects: Map<string, Project>;

	private hasWorkspaceFolderCapability = false;

	/**
	 * Maps the language id across the different editors to the one used in the Providers map. Keys
	 * must be lowercase, lookups are case insensitive as the editors do not agree on casing.
	 *
	 * @type {Record<string, string>}
	 * @memberof TiLanguageService
	 */
	languageIdMap: Record<string, string> = {
		'alloy (tss)': 'alloy-tss',
		'alloy (xml)': 'xml',
		'alloy-xml': 'xml',
		typescript: 'javascript',
		javascriptreact: 'javascript',
		typescriptreact: 'javascript'
	};

	constructor (connection = vls.createConnection(vls.ProposedFeatures.all)) {

		this.connection = connection;
		logger.attach(this.connection.console);
		this.documents = new vls.TextDocuments(TextDocument);
		this.languageProviders = new Map();

		this.languageProviders.set('javascript', new JSProvider(this.connection));
		this.languageProviders.set('alloy-tss', new TSSProvider(this.connection));
		this.languageProviders.set('xml', new XMLProvider(this.connection));
		this.languageProviders.set('tiapp', new TiappProvider(this.connection));

		this.projects = new Map();

		this.connection.onInitialize(this.onInitalize.bind(this));

		this.connection.onCodeAction(this.onCodeAction.bind(this));
		this.connection.onCompletion(this.onCompletion.bind(this));
		this.connection.onDefinition(this.onDefinition.bind(this));
		this.connection.onExecuteCommand(this.onExecuteCommand.bind(this));
		this.connection.onHover(this.onHover.bind(this));
	}

	/**
	 * Starts the underlying LanguageServer and TextDocuments listeners
	 *
	 * @memberof TiLanguageService
	 */
	listen(): void {
		this.documents.listen(this.connection);
		this.connection.listen();

	}

	private async onInitalize(params: vls.InitializeParams): Promise<vls.InitializeResult> {
		logger.log('Received onInitialize');

		const { capabilities, workspaceFolders } = params;
		this.hasWorkspaceFolderCapability = !!(
			capabilities.workspace && !!capabilities.workspace.workspaceFolders
		);

		const result: vls.InitializeResult = {
			capabilities: {
				textDocumentSync: vls.TextDocumentSyncKind.Full,
				// Tell the client that this server supports code completion.
				completionProvider: {
					resolveProvider: false,
					triggerCharacters: [ '<', '.', '\'', '"', '/' ]
				},
				definitionProvider: true,
				codeActionProvider: true,
				hoverProvider: true,
				executeCommandProvider: {
					commands: [
						'titanium.insertCodeAction'
					]
				}
			}
		};
		if (this.hasWorkspaceFolderCapability) {
			result.capabilities.workspace = {
				workspaceFolders: {
					supported: true,
					changeNotifications: true
				}
			};

			this.connection.workspace.onDidChangeWorkspaceFolders(async event => {
				for (const removed of event.removed) {
					this.projects.delete(URI.parse(removed.uri).fsPath);
				}
				await this.loadProjects(event.added.map(folder => URI.parse(folder.uri).fsPath));
			});
		}

		if (Array.isArray(workspaceFolders) && workspaceFolders.length > 0) {
			await this.loadProjects(workspaceFolders.map(folder => URI.parse(folder.uri).fsPath));
		} else if (params.rootUri) {
			await this.loadProjects([ URI.parse(params.rootUri).fsPath ]);
		}
		return result;
	}

	/**
	 * Loads the given directories as Projects, only registering the ones that turn out to be valid
	 * Titanium projects so that requests made in unrelated folders are ignored
	 *
	 * @param {string[]} folderPaths - The directories to load
	 * @memberof TiLanguageService
	 */
	private async loadProjects (folderPaths: string[]): Promise<void> {
		for (const folderPath of folderPaths) {
			const project = new Project(folderPath);
			if (await project.load()) {
				this.projects.set(folderPath, project);
			}
		}
	}

	/**
	 * Resolves the textDocument, Project and Provider for a request, returning undefined if any of
	 * them are not available and the request cannot be serviced
	 *
	 * @param {string} uri - The uri of the textDocument associated with the request
	 * @returns {(RequestContext|undefined)} The document, project and provider for the request
	 * @memberof TiLanguageService
	 */
	private resolveRequest (uri: string): RequestContext|undefined {
		const textDocument = this.documents.get(uri);
		if (!textDocument) {
			logger.log(`No open document for ${uri}`);
			return;
		}

		const project = this.getProject(textDocument.uri);
		if (!project) {
			logger.log(`No Titanium project found for ${uri}`);
			return;
		}

		const provider = this.lookupProvider(textDocument.languageId, textDocument.uri);
		if (!provider) {
			logger.log(`No provider for languageId ${textDocument.languageId}`);
			return;
		}

		return { textDocument, project, provider };
	}

	/**
	 * Runs a provider request, logging and swallowing any error so that a failure to provide
	 * completions is reported as "nothing to suggest" rather than as a failed request
	 *
	 * @param {string} name - The name of the request, used for logging
	 * @param {Function} handler - The function to run
	 * @returns {Promise<any>} The result of the handler, or undefined if it threw
	 * @memberof TiLanguageService
	 */
	private async handleRequest<T> (name: string, handler: () => Promise<T|undefined>): Promise<T|undefined> {
		logger.log(`Received ${name}`);
		try {
			return await handler();
		} catch (error) {
			logger.error(`Error handling ${name}: ${error instanceof Error ? error.stack ?? error.message : error}`);
			return;
		}
	}

	private async onCompletion (params: vls.CompletionParams): Promise<vls.CompletionItem[]|undefined> {
		return this.handleRequest('onCompletion', async () => {
			const request = this.resolveRequest(params.textDocument.uri);
			if (!request) {
				return;
			}
			return request.provider.doCompletion(params, request.textDocument, request.project);
		});
	}

	private async onCodeAction (params: vls.CodeActionParams): Promise<vls.Command[]|undefined> {
		return this.handleRequest('onCodeAction', async () => {
			const request = this.resolveRequest(params.textDocument.uri);
			if (!request) {
				return;
			}
			return request.provider.doCodeAction(params, request.textDocument, request.project);
		});
	}

	private async onDefinition (params: vls.DefinitionParams): Promise<vls.Definition | vls.DefinitionLink[]|undefined> {
		return this.handleRequest('onDefinition', async () => {
			const request = this.resolveRequest(params.textDocument.uri);
			if (!request) {
				return;
			}
			return request.provider.doDefinition(params, request.textDocument, request.project);
		});
	}

	private async onExecuteCommand (params: vls.ExecuteCommandParams): Promise<void> {
		await this.handleRequest('onExecuteCommand', async () => {
			if (params.command !== 'titanium.insertCodeAction') {
				return;
			}

			if (!params.arguments?.length) {
				return;
			}

			const [ text, filename ] = params.arguments as string[];

			const contents = await fs.readFile(filename, 'utf-8');
			const textDocument = TextDocument.create(URI.file(filename).toString(), 'unknown', 1, contents);
			// Insert at the end of the file, adding a newline if the file does not already end with
			// one so that the generated block is not appended to the last line
			const position = textDocument.positionAt(contents.length);
			const insertText = contents.length && !contents.endsWith('\n') ? `\n${text}` : text;

			await this.connection.workspace.applyEdit({
				documentChanges: [
					// The version is null as this is an optional versioned edit, the file is not
					// necessarily open in the client and we have no version to assert against
					vls.TextDocumentEdit.create({ uri: textDocument.uri, version: null }, [
						vls.TextEdit.insert(position, insertText)
					])
				]
			});
		});
	}

	private async onHover(params: vls.HoverParams): Promise<vls.Hover|undefined> {
		return this.handleRequest('onHover', async () => {
			const request = this.resolveRequest(params.textDocument.uri);
			if (!request) {
				return;
			}
			return request.provider.doHover(params, request.textDocument, request.project);
		});
	}

	/**
	 * Looks up the correct provider to be used based on the languageId of the textDocument and the
	 * uri
	 *
	 * @param {string} languageId - The languageId of the textDocument associated with the request
	 * @param {string} uri - The uri of the textDocument associated with the request
	 * @returns {(Provider|undefined)}
	 * @memberof TiLanguageService
	 */
	public lookupProvider (languageId: string, uri: string): Provider|undefined {
		if (uri.endsWith('tiapp.xml')) {
			return this.languageProviders.get('tiapp');
		}

		// The editors do not agree on the casing of their language ids, so normalise before looking
		// up the mapping
		const mapped = this.languageIdMap[languageId.toLowerCase()];
		if (mapped) {
			languageId = mapped;
		}

		return this.languageProviders.get(languageId.toLowerCase());
	}

	/**
	* Based on a filePath obtained from TextDocument.uri, obtain the correct Project instance from the
	* Project map
	*
	* @export
	* @param {string} filePath - The TextDocument from a request
	* @param {Map<string, Project>} projects - The Projects map
	* @returns {(Project|undefined)}
	*/
	public getProject (filePath: string): Project|undefined {
		filePath = URI.parse(filePath).fsPath;
		let project;
		let parentDir = filePath;
		const { root } = path.parse(filePath);
		let previousDir;
		while (!project && parentDir !== previousDir) {
			project = this.projects.get(parentDir)
				?? this.projects.get(`${parentDir}${path.sep}`)
				?? this.projects.get(`${parentDir}/`);
			previousDir = parentDir;
			parentDir = path.dirname(parentDir);
			if (previousDir === root) {
				break;
			}
		}
		return project;
	}
}

/* istanbul ignore next: only runs when the server is spawned as a process */
if (require.main === module) {
	const server = new TiLanguageService();
	server.listen();
}

import * as vls from 'vscode-languageserver/node';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';
import { Project } from './project';
import { getProject } from './utils';
import { URI } from 'vscode-uri';
import { Provider } from './languages';
import { JSProvider } from './languages/javascript';
import { TSSProvider } from './languages/tss';
import { XMLProvider } from './languages/view';
import { TiappProvider } from './languages/tiapp';

let hasWorkspaceFolderCapability = false;

class TiLanguageService {

	connection: vls.Connection;
	documents: vls.TextDocuments<TextDocument>;
	languageProviders: Map<string, Provider>;
	projects: Map<string, Project>;

	constructor () {

		this.connection = vls.createConnection(vls.ProposedFeatures.all);
		this.documents = new vls.TextDocuments(TextDocument);
		this.languageProviders = new Map();

		this.languageProviders.set('javascript', new JSProvider(this.connection));
		this.languageProviders.set('alloy-tss', new TSSProvider(this.connection));
		this.languageProviders.set('xml', new XMLProvider(this.connection));
		this.languageProviders.set('tiapp', new TiappProvider(this.connection));

		this.projects = new Map();

		this.connection.onInitialize(this.onInitalize.bind(this));
		this.connection.onCompletion(this.onCompletion.bind(this));
	}

	async onInitalize(params: vls.InitializeParams): Promise<vls.InitializeResult> {
		this.connection.console.log('Received onInitialize');
		this.connection.console.log(JSON.stringify(params));
		const { capabilities, workspaceFolders } = params;
		this.connection.console.log(this.projects.size.toString());
		hasWorkspaceFolderCapability = !!(
			capabilities.workspace && !!capabilities.workspace.workspaceFolders
		);

		const result: vls.InitializeResult = {
			capabilities: {
				textDocumentSync: vls.TextDocumentSyncKind.Full,
				// Tell the client that this server supports code completion.
				completionProvider: {
					resolveProvider: false,
					triggerCharacters: [ '<', '.', '\'', '"', '/' ]
				}
			}
		};
		if (hasWorkspaceFolderCapability) {
			result.capabilities.workspace = {
				workspaceFolders: {
					supported: true
				}
			};
		}

		if (Array.isArray(workspaceFolders) && workspaceFolders.length > 0) {
			for (const folder of workspaceFolders) {
				const folderPath = URI.parse(folder.uri).fsPath;
				const project = new Project(folderPath);
				await project.load();
				this.projects.set(folderPath, project);
			}
		} else if (params.rootUri) {
			const folderPath = URI.parse(params.rootUri).fsPath;
			const project = new Project(folderPath);
			await project.load();
			this.projects.set(folderPath, project);
		}
		return result;
	}

	async onCompletion (params: vls.CompletionParams): Promise<vls.CompletionItem[]|undefined> {
		this.connection.console.log('Received onCompletion');
		this.connection.console.log(JSON.stringify(params));

		const textDocument = this.documents.get(params.textDocument.uri);
		if (!textDocument) {
			console.log('how to sync?');
			return [];
		}
		const project = getProject(textDocument.uri, this.projects);

		if (!project) {
			console.log('No project');
			return;
		}

		const provider = this.lookupProvider(textDocument.languageId, textDocument.uri);

		if (!provider) {
			return;
		}

		return provider.doCompletion(params, textDocument, project);
	}

	listen(): void {
		this.documents.listen(this.connection);
		this.connection.listen();
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
	lookupProvider (languageId: string, uri: string): Provider|undefined {
		if (uri.endsWith('tiapp.xml')) {
			return this.languageProviders.get('tiapp');
		}

		return this.languageProviders.get(languageId);
	}
}

const server = new TiLanguageService();
server.listen();

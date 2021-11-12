import fs from 'fs-extra';
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

	/**
	 * Maps the language id's across the different editors to the one used in the Providers map
	 *
	 * @type {Record<string, string>}
	 * @memberof TiLanguageService
	 */
	languageIdMap: Record<string, string> = {
		'alloy (tss)': 'alloy-tss',
		'alloy (xml)': 'xml'
	}

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

		this.connection.onCodeAction(this.onCodeAction.bind(this));
		this.connection.onCompletion(this.onCompletion.bind(this));
		this.connection.onDefinition(this.onDefinition.bind(this));
		this.connection.onExecuteCommand(this.onExecuteCommand.bind(this));
		this.connection.onHover(this.onHover.bind(this));
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

	async onCodeAction (params: vls.CodeActionParams): Promise<vls.Command[]|undefined> {
		this.connection.console.log('Received onCodeAction');
		this.connection.console.log(JSON.stringify(params));

		const textDocument = this.documents.get(params.textDocument.uri);
		if (!textDocument) {
			console.log('how to sync?');
			return;
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

		return provider.doCodeAction(params, textDocument, project);
	}

	async onDefinition (params: vls.DefinitionParams): Promise<vls.Definition | vls.DefinitionLink[]|undefined> {
		this.connection.console.log('Received onDefinition');
		this.connection.console.log(JSON.stringify(params));

		const textDocument = this.documents.get(params.textDocument.uri);
		if (!textDocument) {
			console.log('how to sync?');
			return;
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

		return provider.doDefinition(params, textDocument, project);
	}

	async onExecuteCommand (params: vls.ExecuteCommandParams): Promise<vls.WorkspaceEdit|undefined> {
		this.connection.console.log('Received onExecuteCommand');
		this.connection.console.log(JSON.stringify(params));

		if (params.command !== 'titanium.insertCodeAction') {
			return;
		}

		if (!params.arguments?.length) {
			return;
		}

		const [ text, filename ] = params.arguments as string[];

		const contents = await fs.readFile(filename, 'utf-8');
		const textDocument = TextDocument.create(filename, 'unknown', 1, contents);

		this.connection.workspace.applyEdit({
			documentChanges: [
				vls.TextDocumentEdit.create({ uri: textDocument.uri, version: textDocument.version }, [
					vls.TextEdit.insert(vls.Position.create(0, 0), text)
				])
			]
		});
	}

	async onHover(params: vls.HoverParams): Promise<vls.Hover|undefined> {
		this.connection.console.log('Received onHover');
		this.connection.console.log(JSON.stringify(params));

		const textDocument = this.documents.get(params.textDocument.uri);
		if (!textDocument) {
			console.log('how to sync?');
			return;
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

		return provider.doHover(params, textDocument, project);
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
	private lookupProvider (languageId: string, uri: string): Provider|undefined {
		if (uri.endsWith('tiapp.xml')) {
			return this.languageProviders.get('tiapp');
		}

		if (this.languageIdMap[languageId]) {
			languageId = this.languageIdMap[languageId];
		}

		return this.languageProviders.get(languageId);
	}
}

const server = new TiLanguageService();
server.listen();

import * as vls from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { logger } from './logger';

/**
 * The Titanium language server.
 *
 * This is currently a skeleton: it establishes a connection, negotiates capabilities and syncs
 * documents. The analysis it will route to lives in core/ and is added separately.
 */
export class TiLanguageService {

	public connection: vls.Connection;
	public documents: vls.TextDocuments<TextDocument>;

	private hasWorkspaceFolderCapability = false;

	constructor (connection = vls.createConnection(vls.ProposedFeatures.all)) {
		this.connection = connection;
		logger.attach(this.connection.console);

		this.documents = new vls.TextDocuments(TextDocument);
		this.connection.onInitialize(this.onInitialize.bind(this));
	}

	/**
	 * Starts the connection and document listeners
	 */
	public listen (): void {
		this.documents.listen(this.connection);
		this.connection.listen();
	}

	private onInitialize (params: vls.InitializeParams): vls.InitializeResult {
		logger.log('Received initialize');

		const { capabilities } = params;
		this.hasWorkspaceFolderCapability = Boolean(capabilities.workspace?.workspaceFolders);

		const result: vls.InitializeResult = {
			capabilities: {
				textDocumentSync: vls.TextDocumentSyncKind.Incremental
			}
		};

		if (this.hasWorkspaceFolderCapability) {
			result.capabilities.workspace = {
				workspaceFolders: { supported: true, changeNotifications: true }
			};
		}

		return result;
	}
}

/* istanbul ignore next: only runs when the server is spawned as a process */
if (require.main === module) {
	new TiLanguageService().listen();
}

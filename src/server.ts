#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import * as vls from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { logger } from './logger.js';

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

/**
 * Whether this module is the entry point of the process, rather than something another module
 * imported.
 *
 * The comparison has to go through realpath. `bin` points here, and npm links a bin into
 * `node_modules/.bin` as a symlink, so `process.argv[1]` is that link while `import.meta.filename`
 * is the file it points at — Node resolves modules through symlinks. Comparing them unresolved
 * silently answers no, and the command starts a process that listens to nothing.
 *
 * @returns {boolean} Whether the server should start itself
 */
function isEntryPoint (): boolean {
	const entry = process.argv[1];
	return Boolean(entry) && realpathSync(entry) === import.meta.filename;
}

if (isEntryPoint()) {
	new TiLanguageService().listen();
}

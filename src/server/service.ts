import * as vls from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { styleDefinitionAt } from '../core/definition.ts';
import { createSourceCache } from '../core/references.ts';
import type { SourceCache } from '../core/references.ts';
import { ProjectRegistry } from '../core/registry.ts';
import { route } from '../core/routing.ts';
import { logger } from '../logger.ts';
import { offsetAt, toLocation, toPath } from './convert.ts';
import { safely } from './guard.ts';

/**
 * The Titanium language server's adapter onto the protocol.
 *
 * Everything here is translation and lifecycle: connect, negotiate, keep track of which projects
 * are open and which documents are being edited, route a request to the analysis that answers it,
 * and turn the answer back into the protocol's terms. The analysis itself is in core/, which knows
 * nothing about any of this.
 */
export class TiLanguageService {

	public connection: vls.Connection;
	public documents: vls.TextDocuments<TextDocument>;

	/** The projects this server answers for */
	public registry = new ProjectRegistry();

	private cache: SourceCache = createSourceCache();
	/** Resolves once the workspace has been scanned, so a request that beats it does not miss */
	private ready: Promise<unknown> = Promise.resolve();
	private hasWorkspaceFolderCapability = false;
	private roots: string[] = [];

	constructor (connection = vls.createConnection(vls.ProposedFeatures.all)) {
		this.connection = connection;
		logger.attach(this.connection.console);

		this.documents = new vls.TextDocuments(TextDocument);

		this.connection.onInitialize(this.onInitialize.bind(this));
		this.connection.onInitialized(this.onInitialized.bind(this));
		this.connection.onDefinition(this.onDefinition.bind(this));

		// an open document is the one thing on disk that is out of date, so the buffer is fed
		// straight to the cache every analysis reads through
		this.documents.onDidChangeContent(change => this.cache.override(toPath(change.document.uri), change.document.getText()));
		this.documents.onDidClose(closed => this.cache.forget(toPath(closed.document.uri)));
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
		this.roots = rootsOf(params);

		const result: vls.InitializeResult = {
			capabilities: {
				textDocumentSync: vls.TextDocumentSyncKind.Incremental,
				definitionProvider: true
			}
		};

		if (this.hasWorkspaceFolderCapability) {
			result.capabilities.workspace = {
				workspaceFolders: { supported: true, changeNotifications: true }
			};
		}

		return result;
	}

	/**
	 * Finds the projects in the folders the client opened.
	 *
	 * Deliberately here rather than in `onInitialize`: reading every folder is slow enough that a
	 * client would be waiting on the handshake for it, and nothing can be asked of the server until
	 * this notification has been sent anyway.
	 */
	private async onInitialized (): Promise<void> {
		// assigned before it is awaited, so a request arriving while the scan is still running
		// waits for it rather than being answered against an empty registry. A client is free to
		// send one the moment it has sent this notification, and does.
		this.ready = safely('registering the workspace', [], () => this.registry.add(this.roots));

		if (this.hasWorkspaceFolderCapability) {
			// declared in the initialize result rather than registered dynamically, so this needs
			// nothing of the client beyond the capability it already reported
			this.connection.workspace.onDidChangeWorkspaceFolders(event => this.onWorkspaceFoldersChanged(event));
		}

		await this.ready;
	}

	/**
	 * Registers the projects in folders that were added and forgets those in folders that were
	 * removed, in that order — a project both a new folder and an old one contain stays
	 *
	 * @param event - The folders added and removed
	 * @returns {Promise<void>} When the registry has caught up
	 */
	private async onWorkspaceFoldersChanged (event: vls.WorkspaceFoldersChangeEvent): Promise<void> {
		this.ready = safely('changing the workspace', undefined, async () => {
			await this.registry.add(event.added.map(folder => toPath(folder.uri)));
			this.registry.remove(event.removed.map(folder => toPath(folder.uri)));
		});

		await this.ready;
	}

	/**
	 * Answers go to definition on a view, with the stylesheet rules that style what is under the
	 * cursor
	 *
	 * @param params - The document and position asked about
	 * @returns {Promise<vls.Location[]|null>} Where to jump to, or nothing
	 */
	private async onDefinition (params: vls.DefinitionParams): Promise<vls.Location[]|null> {
		return safely(`finding a definition in ${params.textDocument.uri}`, null, async () => {
			await this.ready;

			const filePath = toPath(params.textDocument.uri);
			const languageId = this.documents.get(params.textDocument.uri)?.languageId ?? '';

			const routed = await route(this.registry, filePath, languageId);
			if (routed?.kind !== 'xml' || routed.role !== 'view') {
				return null;
			}

			const source = await this.cache.read(filePath);
			const found = await styleDefinitionAt(routed.project, source, offsetAt(source.text, params.position), this.cache);
			if (!found.length) {
				return null;
			}

			return Promise.all(found.map(async location => toLocation((await this.cache.read(location.path)).text, location)));
		});
	}
}

/**
 * The directories the client opened.
 *
 * `workspaceFolders` is what a client that has them sends, and it is null rather than absent on
 * one that does not, so `rootUri` is the fallback. `rootPath` is deprecated and not read: every
 * client that sends it sends `rootUri` too.
 *
 * @param params - The initialize parameters
 * @returns {string[]} Absolute paths, which may be none at all when no folder is open
 */
function rootsOf (params: vls.InitializeParams): string[] {
	if (params.workspaceFolders?.length) {
		return params.workspaceFolders.map(folder => toPath(folder.uri));
	}
	return params.rootUri ? [ toPath(params.rootUri) ] : [];
}

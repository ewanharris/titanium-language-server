import * as vls from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { imagePathsFor } from '../core/assets.ts';
import { styleDefinitionAt } from '../core/definition.ts';
import {} from '../core/references.ts';
import { SourceCache } from '../core/references.ts';
import { Project } from '../core/project.ts';
import { ProjectRegistry } from '../core/registry.ts';
import { ProjectServices } from '../core/typescript/services.ts';
import { AcquiredTypes, ProjectTypes } from '../core/typescript/types.ts';
import type { TypesSource } from '../core/typescript/types.ts';
import { NpmAcquirer } from '../core/typescript/acquire.ts';
import { route } from '../core/routing.ts';
import { viewCompletionsAt } from '../core/view.ts';
import type { ViewCompletion } from '../core/view.ts';
import type { RoutedFile } from '../core/routing.ts';
import type { ProjectService } from '../core/typescript/host.ts';
import { logger } from '../logger.ts';
import { ClientCapabilities } from './capabilities.ts';
import { offsetAt, toCompletionItem, toCompletionKind, toLocation, toMarkup, toPath, toRange } from './convert.ts';
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

	/** One language service per project, warmed when the project is registered */
	public services: ProjectServices;

	/**
	 * What the client can do, negotiated at initialize.
	 *
	 * Starts out assuming nothing, so a request that somehow arrives first is answered carefully
	 * rather than against undefined.
	 */
	public capabilities = new ClientCapabilities({});

	private cache: SourceCache = new SourceCache();
	/** Resolves once the workspace has been scanned, so a request that beats it does not miss */
	private ready: Promise<unknown> = Promise.resolve();
	private roots: string[] = [];

	/**
	 * @param connection - The connection to serve on
	 * @param typesSources - Where `@types/titanium` comes from, in preference order. Defaults to
	 *   the project's own copy, then npm. A test supplies its own rather than reaching the network.
	 */
	constructor (
		connection = vls.createConnection(vls.ProposedFeatures.all),
		typesSources: TypesSource[] = [ new ProjectTypes(), new AcquiredTypes(new NpmAcquirer()) ]
	) {
		this.connection = connection;
		logger.attach(this.connection.console);

		this.documents = new vls.TextDocuments(TextDocument);
		this.services = new ProjectServices({ cache: this.cache, sources: typesSources });

		this.connection.onInitialize(this.onInitialize.bind(this));
		this.connection.onInitialized(this.onInitialized.bind(this));
		this.connection.onDefinition(this.onDefinition.bind(this));
		this.connection.onCompletion(this.onCompletion.bind(this));
		this.connection.onCompletionResolve(this.onCompletionResolve.bind(this));
		this.connection.onHover(this.onHover.bind(this));

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

		this.capabilities = new ClientCapabilities(params.capabilities);
		this.roots = rootsOf(params);

		const result: vls.InitializeResult = {
			capabilities: {
				textDocumentSync: vls.TextDocumentSyncKind.Incremental,
				definitionProvider: true,
				hoverProvider: true,
				completionProvider: {
					// the detail for every entry in a list of several hundred is most of the cost
					// of answering, and a client shows one at a time
					resolveProvider: true,
					// a dot is what asks for members; the quotes and the separator are what asks
					// for a module path, which the language service answers inside a string
					triggerCharacters: [ '.', '\'', '"', '/' ]
				}
			}
		};

		if (this.capabilities.workspaceFolders) {
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
		this.ready = safely('registering the workspace', undefined, () => this.openProjects(this.roots));

		if (this.capabilities.workspaceFolders) {
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
			await this.openProjects(event.added.map(folder => toPath(folder.uri)));

			for (const dropped of this.registry.remove(event.removed.map(folder => toPath(folder.uri)))) {
				this.services.close(dropped);
			}
		});

		await this.ready;
	}

	/**
	 * Registers the projects under the given roots and builds a warmed language service for each.
	 *
	 * The service is built even when no types resolved. It answers nothing then, but a project
	 * without a type package is not an invalid project — every other feature still works, and the
	 * user is told why the JavaScript ones do not.
	 *
	 * @param roots - The directories to scan
	 * @returns {Promise<void>} When every project found has a service
	 */
	private async openProjects (roots: string[]): Promise<void> {
		for (const project of await this.registry.add(roots)) {
			// contained per project: resolving types can reach the network, and one project that
			// cannot be served is not a reason to abandon the others in the same workspace
			const opened = await safely(`opening ${project.filePath}`, undefined, () => this.services.open(project));
			if (!opened) {
				continue;
			}

			// info is logged and a warning is shown: the types trail the SDK on nearly every
			// project, so reporting that as an interruption would train the user to ignore it
			if (opened.report.level === 'warning') {
				this.connection.window.showWarningMessage(opened.report.message);
			}
			logger.log(opened.report.message);
		}
	}

	/**
	 * Answers go to definition, from whichever half of the project the cursor is in.
	 *
	 * A view jumps to the stylesheet rules that style what is under the cursor; a controller or a
	 * classic source file jumps to wherever TypeScript says the symbol is declared — which, for an
	 * id on `$`, is the view element the declaration was generated from.
	 *
	 * @param params - The document and position asked about
	 * @returns {Promise<vls.Location[]|null>} Where to jump to, or nothing
	 */
	private async onDefinition (params: vls.DefinitionParams): Promise<vls.Location[]|null> {
		return safely(`finding a definition in ${params.textDocument.uri}`, null, async () => {
			const routed = await this.routeOf(params.textDocument.uri);

			const script = await this.scriptFor(routed);
			if (script) {
				const found = script.service.definitionsAt(script.path, offsetAt(script.text, params.position));

				// every answer already carries a real file and a source offset: the host maps
				// anything that landed in the generated declaration back to the view, and drops
				// what came from scaffolding the user never wrote
				return found.length
					? Promise.all(found.map(async location => toLocation((await this.cache.read(location.path)).text, location)))
					: null;
			}

			if (routed?.kind !== 'xml' || routed.role !== 'view') {
				return null;
			}

			const source = await this.cache.read(routed.path);
			const found = await styleDefinitionAt(routed.project, source, offsetAt(source.text, params.position), this.cache);
			if (!found.length) {
				return null;
			}

			return Promise.all(found.map(async location => toLocation((await this.cache.read(location.path)).text, location)));
		});
	}

	/**
	 * Answers completion in a controller, a library or a classic source file.
	 *
	 * The entries arrive without their documentation, which is resolved per entry the client
	 * actually shows — see `onCompletionResolve`. Each carries where it was asked for, because
	 * resolving needs the same position again and the protocol gives the server nothing else to
	 * find it by.
	 *
	 * @param params - The document and position asked about
	 * @returns {Promise<vls.CompletionItem[]|null>} What could be written there
	 */
	private async onCompletion (params: vls.CompletionParams): Promise<vls.CompletionItem[]|null> {
		return safely(`completing in ${params.textDocument.uri}`, null, async () => {
			const routed = await this.routeOf(params.textDocument.uri);

			// a view is answered by the analysis rather than by the language service: there is no
			// script to ask, and what belongs at a position in XML is a question about the markup
			if (routed?.kind === 'xml' && routed.role === 'view') {
				return this.viewCompletions(routed.project, routed.path, params.position);
			}

			const script = await this.scriptFor(routed);
			if (!script) {
				return null;
			}

			const offset = offsetAt(script.text, params.position);

			const items = script.service.completionsAt(script.path, offset).map(entry => {
				// no insert forms: TypeScript's entries are names, and the client inserting the
				// label is exactly right for every one of them
				const item = toCompletionItem({ label: entry.name }, this.capabilities.snippets);

				item.kind = toCompletionKind(entry.kind, this.capabilities.completionItemKinds);
				item.data = { uri: params.textDocument.uri, offset };

				return item;
			});

			// merged rather than instead of: a string literal is still somewhere TypeScript may
			// know something, and an image property is the only thing it cannot answer for itself
			return [ ...items, ...await this.imagesAt(script, offset) ];
		});
	}

	/**
	 * What could be written at a position in a view.
	 *
	 * The types come from the project's own service, which is the same `@types/titanium` every
	 * other answer is drawn from — so a view and a controller never disagree about what a Label
	 * has. A project whose types did not resolve answers Alloy's own attributes and no more, which
	 * is a smaller answer rather than an error.
	 *
	 * @param project - The project the view belongs to
	 * @param filePath - The view
	 * @param position - Where in it
	 * @returns {Promise<vls.CompletionItem[]|null>} What belongs there
	 */
	private async viewCompletions (project: Project, filePath: string, position: vls.Position): Promise<vls.CompletionItem[]|null> {
		const service = this.services.get(project);
		if (!service) {
			return null;
		}

		// the buffer when the document is open, which is what makes the answer current rather than
		// one keystroke stale
		const view = await this.cache.read(filePath);

		const found = await viewCompletionsAt({
			project,
			view,
			offset: offsetAt(view.text, position),
			api: service,
			cache: this.cache
		});

		// documentation up front, where a script completion defers it to `onCompletionResolve`. The
		// two are different sizes of problem: TypeScript's list at a bare cursor is the whole scope
		// and its detail dwarfs the names, while this is one element's properties — measured at
		// 6.8KB for a Label and 8.9KB for a Window, a few KB on one message. Deferring would buy
		// that back at the price of re-parsing the view and re-reading its stylesheets per entry
		// the client highlights, and these items carry no position for a resolve to work from
		return found.length ? found.map(completion => this.toViewItem(completion, view.text)) : null;
	}

	/**
	 * One view completion in the protocol's terms.
	 *
	 * The span is sent as an explicit edit wherever core supplied one. A client left to work out
	 * what to replace from its own idea of a word turns accepting `/images/lo` into
	 * `/images//images/logo.png`, and an attribute name half typed as `col` into `colcolor`.
	 *
	 * @param completion - What core answered
	 * @param text - The view, for turning offsets into positions
	 * @returns {vls.CompletionItem} The item to send
	 */
	private toViewItem (completion: ViewCompletion, text: string): vls.CompletionItem {
		const item = toCompletionItem(completion, this.capabilities.snippets);

		item.kind = toCompletionKind(completion.kind, this.capabilities.completionItemKinds);

		if (completion.range) {
			item.textEdit = {
				range: toRange(text, completion.range),
				// the insert form when there is one, so a snippet still replaces the right span
				newText: (this.capabilities.snippets ? completion.insert?.snippet : completion.insert?.plain) ?? completion.label
			};
		}

		return item;
	}

	/**
	 * The image paths that could be written at a position, if it is somewhere one belongs.
	 *
	 * The only completion in this server that is not resolved by the language service, because it
	 * is the only one that cannot be: `@types/titanium` types every image path as `string`, and a
	 * property that already exists cannot be narrowed by declaring it again. What a string literal
	 * means is decided by the property it is written into — which the syntax tree answers, so this
	 * still never matches against the characters before the cursor.
	 *
	 * Each item carries an explicit replacement range. A path is full of slashes and dots, and a
	 * client left to work out what to replace from its own idea of a word would turn accepting a
	 * completion on `/images/lo` into `/images//images/logo.png`.
	 *
	 * @param script - The service, path and text for the file being asked about
	 * @param offset - Where in it
	 * @returns {Promise<vls.CompletionItem[]>} The paths, or none
	 */
	private async imagesAt (script: { service: ProjectService; path: string; text: string }, offset: number): Promise<vls.CompletionItem[]> {
		const literal = script.service.stringLiteralAt(script.path, offset);
		if (!literal) {
			return [];
		}

		// answers nothing for every property that does not take an image, so the decision about
		// what a property means stays in core with the rest of the analysis
		const paths = await imagePathsFor(script.service.project, literal.property, literal.typeExcludesString);
		const range = toRange(script.text, literal.range);

		return paths.map(image => ({
			...toCompletionItem({ label: image }, this.capabilities.snippets),
			kind: vls.CompletionItemKind.File,
			textEdit: { range, newText: image }
		}));
	}

	/**
	 * Fills in the signature and documentation for the one entry a client is showing.
	 *
	 * An item this server cannot place comes back unchanged rather than empty: a client may resolve
	 * something it kept from an earlier list, and an item without its documentation is a better
	 * answer than a failed request.
	 *
	 * @param item - The item to resolve
	 * @returns {Promise<vls.CompletionItem>} The same item, with its detail when there is one
	 */
	private async onCompletionResolve (item: vls.CompletionItem): Promise<vls.CompletionItem> {
		return safely(`resolving the completion ${item.label}`, item, async () => {
			const asked = item.data as { uri?: string; offset?: number }|undefined;
			if (typeof asked?.uri !== 'string' || typeof asked.offset !== 'number') {
				return item;
			}

			const script = await this.scriptFor(await this.routeOf(asked.uri));
			const detail = script?.service.completionDetail(script.path, asked.offset, item.label);
			if (!detail) {
				return item;
			}

			return { ...item, detail: detail.text, documentation: detail.documentation };
		});
	}

	/**
	 * Answers hover with the type TypeScript has for what is under the cursor.
	 *
	 * @param params - The document and position asked about
	 * @returns {Promise<vls.Hover|null>} What to show, or nothing
	 */
	private async onHover (params: vls.HoverParams): Promise<vls.Hover|null> {
		return safely(`hovering in ${params.textDocument.uri}`, null, async () => {
			const script = await this.scriptFor(await this.routeOf(params.textDocument.uri));
			if (!script) {
				return null;
			}

			const info = script.service.quickInfoAt(script.path, offsetAt(script.text, params.position));
			if (!info) {
				return null;
			}

			// the range is always in the document that was asked about: quick info describes the
			// token under the cursor, so its span is in that file, and the mapping for a real file
			// is the identity. Only content generated into the program maps elsewhere, and nothing
			// here ever asks about that
			return {
				contents: toMarkup(info, this.capabilities.hoverMarkdown),
				range: toRange(script.text, info.range)
			};
		});
	}

	/**
	 * What a request is about, once the workspace has been scanned.
	 *
	 * The await is the point rather than a formality: a client may send a request the moment it has
	 * sent `initialized`, and notification handlers are not awaited before the next message is
	 * dispatched, so a handler that skipped this would answer against an empty registry.
	 *
	 * @param uri - The document the request names
	 * @returns {Promise<RoutedFile|undefined>} What it is, when it is in a project at all
	 */
	private async routeOf (uri: string): Promise<RoutedFile|undefined> {
		await this.ready;

		// the language id says what the file is written in and the layout says what it does there;
		// a document the client never opened has no id, and the extension answers instead
		return route(this.registry, toPath(uri), this.documents.get(uri)?.languageId ?? '');
	}

	/**
	 * The language service for a routed file, with the right `$` in scope, and the text its
	 * positions are measured against.
	 *
	 * Answers nothing for everything that is not JavaScript or TypeScript, which is how each
	 * handler tells a file it can answer for from one it cannot.
	 *
	 * @param routed - What the request is about
	 * @returns The service, the path and the text, when the file is a script in an open project
	 */
	private async scriptFor (routed: RoutedFile|undefined): Promise<{ service: ProjectService; path: string; text: string }|undefined> {
		if (routed?.kind !== 'javascript' && routed?.kind !== 'typescript') {
			return;
		}

		// never `services.get`: preparing is what settles which controller's `$` the program holds,
		// and only one may be in scope at a time
		const service = await this.services.prepare(routed.project, routed.path);
		if (!service) {
			return;
		}

		// the buffer when the document is open, which is the whole point of the shared cache:
		// reading disk is wrong by one keystroke
		return { service, path: routed.path, text: (await this.cache.read(routed.path)).text };
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

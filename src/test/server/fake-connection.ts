import type { CompletionItem, CompletionParams, Connection, DefinitionParams, Hover, HoverParams, InitializeParams, InitializeResult, Location, WorkspaceFoldersChangeEvent } from 'vscode-languageserver';

type Handler = (...args: unknown[]) => unknown;

/**
 * A connection that records what the server does with it, so the adapter can be driven without
 * spawning a process.
 *
 * The end-to-end client is what proves the protocol works; this is what makes the branches
 * reachable — a provider that throws, a client with no workspace folders, a document that is
 * closed again. It implements only what the server and `TextDocuments` actually call, and is cast
 * rather than declared as a `Connection`, so the server keeps the real type.
 */
export class FakeConnection {

	public logs: string[] = [];
	public errors: string[] = [];
	/** Messages sent to the user through window/showMessage, as opposed to logged */
	public warnings: string[] = [];

	public console = {
		log: (message: string): number => this.logs.push(message),
		error: (message: string): number => this.errors.push(message),
		info: (message: string): number => this.logs.push(message),
		warn: (message: string): number => this.logs.push(message),
		debug: (message: string): number => this.logs.push(message)
	};

	public window = {
		showWarningMessage: (message: string): number => this.warnings.push(message)
	};

	public workspace = {
		onDidChangeWorkspaceFolders: (handler: Handler) => this.register('workspaceFolders', handler)
	};

	public listening = false;

	private handlers = new Map<string, Handler>();

	public onInitialize = (handler: Handler): unknown => this.register('initialize', handler);
	public onInitialized = (handler: Handler): unknown => this.register('initialized', handler);
	public onDefinition = (handler: Handler): unknown => this.register('definition', handler);
	public onCompletion = (handler: Handler): unknown => this.register('completion', handler);
	public onCompletionResolve = (handler: Handler): unknown => this.register('completionResolve', handler);
	public onHover = (handler: Handler): unknown => this.register('hover', handler);
	public onDidOpenTextDocument = (handler: Handler): unknown => this.register('didOpen', handler);
	public onDidChangeTextDocument = (handler: Handler): unknown => this.register('didChange', handler);
	public onDidCloseTextDocument = (handler: Handler): unknown => this.register('didClose', handler);
	public onWillSaveTextDocument = (handler: Handler): unknown => this.register('willSave', handler);
	public onWillSaveTextDocumentWaitUntil = (handler: Handler): unknown => this.register('willSaveWaitUntil', handler);
	public onDidSaveTextDocument = (handler: Handler): unknown => this.register('didSave', handler);

	public listen = (): void => {
		this.listening = true;
	};

	/**
	 * The fake as the server sees it.
	 *
	 * `Connection` has upwards of forty members, all but a handful of which this server never
	 * touches. Implementing them to satisfy the compiler would be a large fake that says nothing,
	 * so the cast is deliberate — a call the server makes that this does not implement fails the
	 * test loudly rather than quietly.
	 *
	 * @returns {Connection} The fake, typed as a connection
	 */
	public asConnection (): Connection {
		return this as unknown as Connection;
	}

	public async initialize (params: Partial<InitializeParams> = {}): Promise<InitializeResult> {
		const result = await this.call<InitializeResult>('initialize', { capabilities: {}, processId: null, rootUri: null, ...params });
		await this.call('initialized', {});
		return result;
	}

	public async definition (uri: string, line: number, character: number): Promise<Location[]|null> {
		const params: DefinitionParams = { textDocument: { uri }, position: { line, character } };
		return this.call<Location[]|null>('definition', params);
	}

	public async completion (uri: string, line: number, character: number): Promise<CompletionItem[]|null> {
		const params: CompletionParams = { textDocument: { uri }, position: { line, character } };
		return this.call<CompletionItem[]|null>('completion', params);
	}

	public async resolveCompletion (item: CompletionItem): Promise<CompletionItem> {
		return this.call<CompletionItem>('completionResolve', item);
	}

	public async hover (uri: string, line: number, character: number): Promise<Hover|null> {
		const params: HoverParams = { textDocument: { uri }, position: { line, character } };
		return this.call<Hover|null>('hover', params);
	}

	public async changeWorkspaceFolders (event: WorkspaceFoldersChangeEvent): Promise<void> {
		await this.call('workspaceFolders', event);
	}

	public open (uri: string, languageId: string, text: string): void {
		void this.call('didOpen', { textDocument: { uri, languageId, version: 1, text } });
	}

	public change (uri: string, text: string): void {
		void this.call('didChange', { textDocument: { uri, version: 2 }, contentChanges: [ { text } ] });
	}

	public close (uri: string): void {
		void this.call('didClose', { textDocument: { uri } });
	}

	private register (name: string, handler: Handler): unknown {
		this.handlers.set(name, handler);
		return { dispose: (): void => undefined };
	}

	private async call<T> (name: string, ...args: unknown[]): Promise<T> {
		const handler = this.handlers.get(name);
		if (!handler) {
			throw new Error(`Nothing is handling ${name}`);
		}
		return await handler(...args) as T;
	}
}

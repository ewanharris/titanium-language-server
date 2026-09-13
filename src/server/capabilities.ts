import { CompletionItemKind, MarkupKind } from 'vscode-languageserver';
import type { ClientCapabilities as ProtocolCapabilities } from 'vscode-languageserver';

/**
 * What a client that declares no completion item kinds understands.
 *
 * The protocol grew the enumeration after 3.0 and says a client that does not report a value set
 * "only supports the kinds from `Text` to `Reference`". Sending it a later one puts an integer it
 * has no icon for in front of the user, so this is the floor rather than a guess.
 */
const originalKinds: CompletionItemKind[] = Object.values(CompletionItemKind)
	.filter((kind): kind is CompletionItemKind => typeof kind === 'number' && kind <= CompletionItemKind.Reference);

/**
 * What the client on the other end can actually do.
 *
 * Every field here is a question the protocol says to ask and that a server is free to skip, which
 * is how a server ends up working in one editor and quietly breaking in another. The cost is not
 * symmetric either: assuming a capability the client lacks puts something wrong in the user's file
 * or sends a request the client rejects, while assuming its absence only costs a nicety. So each
 * one defaults to unsupported and has to be declared to be believed.
 *
 * This is read once, at initialize. Nothing re-negotiates: the protocol has no notification for a
 * client changing its mind, and a server that tried would be guessing.
 *
 * Held as one object rather than a boolean per question on the adapter, because the answers travel
 * — what a completion inserts depends on `snippets`, and the code that decides is not the code
 * that negotiated. A bag of booleans spread across a class is how one of them gets forgotten at a
 * call site.
 */
export class ClientCapabilities {

	/**
	 * Whether accepting a completion can insert tab stops.
	 *
	 * Without it, `${1}` and `$0` are inserted as the literal characters they are. This is the one
	 * most likely to bite on neovim without a snippet plugin.
	 */
	public readonly snippets: boolean;

	/** Whether the server may ask the client to reveal a document, as extract style wants to */
	public readonly showDocument: boolean;

	/**
	 * Whether code actions may be returned as `CodeAction` literals.
	 *
	 * Without it they have to be `Command`s, which need a handler registered on the client side —
	 * the thing this server is built to avoid.
	 */
	public readonly codeActionLiterals: boolean;

	/** Whether the client tracks workspace folders, and so whether to watch them for changes */
	public readonly workspaceFolders: boolean;

	/**
	 * Whether hover contents may be markdown.
	 *
	 * A signature is worth a code fence, and a client that cannot render one would show the
	 * backticks. The list is ordered by the client's preference, so the question is membership
	 * rather than which came first — this server has only the two forms to choose between.
	 */
	public readonly hoverMarkdown: boolean;

	/**
	 * The completion item kinds the client declared it understands.
	 *
	 * A set rather than a list because every read is a membership test, and never empty: a client
	 * that declares nothing still gets the kinds the protocol says it has always had.
	 */
	public readonly completionItemKinds: ReadonlySet<CompletionItemKind>;

	/**
	 * @param capabilities - What the client declared in its initialize request
	 */
	constructor (capabilities: ProtocolCapabilities) {
		this.snippets = Boolean(capabilities.textDocument?.completion?.completionItem?.snippetSupport);
		this.showDocument = Boolean(capabilities.window?.showDocument?.support);
		// the protocol carries the supported kinds inside this rather than a boolean beside it, so
		// its presence is the answer
		this.codeActionLiterals = Boolean(capabilities.textDocument?.codeAction?.codeActionLiteralSupport);
		this.workspaceFolders = Boolean(capabilities.workspace?.workspaceFolders);
		this.hoverMarkdown = Boolean(capabilities.textDocument?.hover?.contentFormat?.includes(MarkupKind.Markdown));
		this.completionItemKinds = new Set(
			capabilities.textDocument?.completion?.completionItemKind?.valueSet ?? originalKinds
		);
	}
}

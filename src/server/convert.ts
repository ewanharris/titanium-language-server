import { CompletionItem, InsertTextFormat, Location, Position, Range } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import type { CoreLocation } from '../core/definition.ts';

/**
 * The translation between core's vocabulary and the protocol's.
 *
 * Core deals in file system paths and character offsets, because that is what a parser produces
 * and what the file system takes. The protocol deals in URIs and line/character pairs. Keeping the
 * two apart is what lets core be tested without a protocol harness, and this is the seam.
 *
 * Line and character arithmetic goes through `TextDocument` rather than counting newlines here:
 * it is the same implementation the client uses, so a CRLF file and an emoji in a label both land
 * where the editor expects.
 */

/**
 * The file system path a URI names.
 *
 * The drive letter is upper cased on Windows. `fsPath` lower cases it, and everything the platform
 * itself produces — `process.cwd()`, `import.meta.dirname`, a path a user typed — upper cases it,
 * so the two disagree as strings while naming the same file. Every path in the server arrives
 * through here, so normalising once is what makes a path from a URI comparable to one from
 * anywhere else. A UNC path has no drive letter and is left alone.
 *
 * @param uri - The URI, as the client sent it
 * @returns {string} The path
 */
export function toPath (uri: string): string {
	const filePath = URI.parse(uri).fsPath;
	const drive = /^([a-z]):/.exec(filePath);

	return drive ? `${drive[1].toUpperCase()}${filePath.slice(1)}` : filePath;
}

/**
 * The URI for a file system path
 *
 * @param filePath - An absolute path
 * @returns {string} The URI
 */
export function toUri (filePath: string): string {
	return URI.file(filePath).toString();
}

/**
 * The offset a position names in a document
 *
 * @param text - The document's contents
 * @param position - A line and character
 * @returns {number} The character offset
 */
export function offsetAt (text: string, position: Position): number {
	return document(text).offsetAt(position);
}

/**
 * The positions an offset range covers in a document
 *
 * @param text - The document's contents
 * @param range - A span in character offsets
 * @returns {Range} The same span, as positions
 */
export function toRange (text: string, range: { start: number; end: number }): Range {
	const target = document(text);
	return { start: target.positionAt(range.start), end: target.positionAt(range.end) };
}

/**
 * A core answer as a location the client can jump to
 *
 * @param text - The contents of the file being pointed into
 * @param location - Where in it
 * @returns {Location} The location, in the protocol's terms
 */
export function toLocation (text: string, location: CoreLocation): Location {
	return { uri: toUri(location.path), range: toRange(text, location.range) };
}

/**
 * What a completion inserts, in both of the forms a client might take.
 *
 * The two are supplied together or not at all, and that is deliberate: a plain form cannot be
 * derived from a snippet by deleting its tab stops. `backgroundColor="$1"$0` stripped that way
 * gives `backgroundColor=""` with the cursor after the closing quote, where what the user wants is
 * `backgroundColor="` and to keep typing. The useful plain form differs per site, so each site
 * decides its own and the type makes it impossible to offer one without the other.
 */
export interface CompletionInsertion {
	/** What the client shows, and what it inserts when there are no forms below */
	label: string;
	/** Both forms, or neither */
	insert?: { snippet: string; plain: string };
	detail?: string;
	documentation?: string;
}

/**
 * A completion in the protocol's terms, inserting whichever form the client can use.
 *
 * @param completion - The completion, with both insert forms if it has any
 * @param snippets - Whether the client has a snippet engine, from the negotiated capabilities
 * @returns {CompletionItem} The item to send
 */
export function toCompletionItem (completion: CompletionInsertion, snippets: boolean): CompletionItem {
	const { label, insert, detail, documentation } = completion;
	const item: CompletionItem = { label };

	if (detail !== undefined) {
		item.detail = detail;
	}
	if (documentation !== undefined) {
		item.documentation = documentation;
	}

	// nothing to choose between: the client inserts the label, which is what it does with no
	// insertText at all
	if (!insert) {
		return item;
	}

	item.insertText = snippets ? insert.snippet : insert.plain;
	item.insertTextFormat = snippets ? InsertTextFormat.Snippet : InsertTextFormat.PlainText;

	return item;
}

/**
 * A document to do position arithmetic against.
 *
 * The URI and language are never read back, so they say what this is for rather than pretending to
 * describe a real document.
 *
 * @param text - The contents
 * @returns {TextDocument} A document over them
 */
function document (text: string): TextDocument {
	return TextDocument.create('untitled:positions', 'plaintext', 1, text);
}

import { Location, Position, Range } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { CoreLocation } from '../core/definition.js';

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

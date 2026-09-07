import fs from 'node:fs/promises';
import nodePath from 'node:path';
import { parseTss, parseSelector } from './tss.ts';
import type { SelectorKind, TssRange } from './tss.ts';
import { parseXml } from './xml.ts';
import type { XmlRange } from './xml.ts';

/**
 * The cross-reference index: which views name which ids, classes and tags, and which stylesheets
 * define them.
 *
 * Every feature downstream needs the same handful of relationships — go to definition from a
 * `class=` to the rule that styles it, completion of `$.<id>` from the view's ids, a warning that a
 * class is used and never styled. Each of them scanning the project separately is how the previous
 * implementation ended up matching regular expressions across files.
 *
 * This is a pure function of the documents it is given. It holds no lifecycle and reads nothing:
 * what to feed it, and when, is the caller's business. `createSourceCache` is the piece that reads.
 */

export interface SourceFile {
	path: string;
	text: string;
}

/** Somewhere a view names an id, a class or a tag */
export interface ViewUsage {
	kind: SelectorKind;
	name: string;
	file: string;
	range: XmlRange;
}

/** Somewhere a stylesheet defines a rule for one */
export interface StyleDefinition {
	kind: SelectorKind;
	name: string;
	queries: Record<string, string|string[]>;
	file: string;
	range: TssRange;
}


/**
 * The relationships between a set of views and stylesheets.
 *
 * Built once from the documents it is given and then queried. It holds no lifecycle and reads
 * nothing: what to feed it, and when, is the caller's business. `SourceCache` is the piece that
 * reads.
 */
export class ReferenceIndex {

	/** Somewhere a view names an id, a class or a tag */
	public readonly usages: ViewUsage[];

	/** Somewhere a stylesheet defines a rule for one */
	public readonly definitions: StyleDefinition[];

	constructor (sources: { views: SourceFile[]; styles: SourceFile[] }) {
		this.usages = sources.views.flatMap(readView);
		this.definitions = sources.styles.flatMap(readStyle);
	}

	/**
	 * Every stylesheet rule that styles this thing, app.tss included since it is just another file
	 *
	 * @param kind - Whether it is an id, a class or a tag
	 * @param name - Its name
	 * @returns {StyleDefinition[]} The rules that style it
	 * @memberof ReferenceIndex
	 */
	public stylesDefining (kind: SelectorKind, name: string): StyleDefinition[] {
		return this.definitions.filter(definition => definition.kind === kind && definition.name === name);
	}

	/**
	 * Everywhere a view names it
	 *
	 * @param kind - Whether it is an id, a class or a tag
	 * @param name - Its name
	 * @returns {ViewUsage[]} Where it is named
	 * @memberof ReferenceIndex
	 */
	public viewsUsing (kind: SelectorKind, name: string): ViewUsage[] {
		return this.usages.filter(usage => usage.kind === kind && usage.name === name);
	}

	/**
	 * The ids in one view, which is what `$.<id>` completes from
	 *
	 * @param file - The view
	 * @returns {string[]} Its ids, in document order
	 * @memberof ReferenceIndex
	 */
	public idsIn (file: string): string[] {
		return this.usages.filter(usage => usage.file === file && usage.kind === 'id').map(usage => usage.name);
	}
}

/**
 * Everything one view names
 *
 * @param source - The view
 * @returns {ViewUsage[]} Its ids, classes and tags, in document order
 */
function readView (source: SourceFile): ViewUsage[] {
	const usages: ViewUsage[] = [];

	for (const element of parseXml(source.text).elements) {
		if (element.tag) {
			usages.push({ kind: 'tag', name: element.tag, file: source.path, range: element.range });
		}

		for (const attribute of element.attributes) {
			if (!attribute.value || !attribute.valueRange) {
				continue;
			}

			if (attribute.name === 'id') {
				usages.push({ kind: 'id', name: attribute.value, file: source.path, range: attribute.valueRange });
			} else if (attribute.name === 'class') {
				usages.push(...splitClasses(attribute.value, attribute.valueRange, source.path));
			}
		}
	}

	return usages;
}

/**
 * A class attribute holds a whitespace separated list, so each name gets its own range rather than
 * the whole attribute — otherwise go to definition on one class would highlight all of them
 *
 * @param value - The attribute value, without its quotes
 * @param range - Where that value sits in the source
 * @param file - The view's path
 * @returns {ViewUsage[]} One usage per class named
 */
function splitClasses (value: string, range: XmlRange, file: string): ViewUsage[] {
	const usages: ViewUsage[] = [];
	const pattern = /\S+/g;

	for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
		usages.push({
			kind: 'class',
			name: match[0],
			file,
			range: { start: range.start + match.index, end: range.start + match.index + match[0].length }
		});
	}

	return usages;
}

/**
 * Everything one stylesheet defines.
 *
 * A selector Alloy would reject yields nothing rather than a definition nobody could have meant.
 *
 * @param source - The stylesheet
 * @returns {StyleDefinition[]} Its rules, in document order
 */
function readStyle (source: SourceFile): StyleDefinition[] {
	const definitions: StyleDefinition[] = [];

	for (const rule of parseTss(source.text).rules) {
		const selector = parseSelector(rule.selector.text);
		if (!selector) {
			continue;
		}

		definitions.push({
			kind: selector.kind,
			name: selector.name,
			queries: selector.queries,
			file: source.path,
			range: rule.selector.range
		});
	}

	return definitions;
}

/**
 * A cache of file contents, so building the index does not re-read the project on every query.
 *
 * Keyed on the path and invalidated when the file's size or modification time changes. That is
 * enough for files on disk and wrong for the one being typed in: an unsaved edit never changes
 * either. So a buffer supplied through `override` wins outright until it is dropped, which is how
 * the server layer will feed in open documents.
 */
export class SourceCache {

	private entries = new Map<string, CacheEntry>();
	private overrides = new Map<string, string>();
	private versions = new Map<string, number>();
	private readCount = 0;

	/**
	 * How many times a file has actually been read, which is what the cache exists to keep down
	 *
	 * @readonly
	 * @type {number}
	 * @memberof SourceCache
	 */
	public get reads (): number {
		return this.readCount;
	}

	/**
	 * Supplies the editor's buffer for a file, which then wins over whatever is on disk
	 *
	 * @param path - The file
	 * @param text - What the editor has
	 * @memberof SourceCache
	 */
	public override (path: string, text: string): void {
		this.overrides.set(this.key(path), text);
		this.touch(this.key(path));
	}

	/**
	 * Drops an override, so the file is read from disk again
	 *
	 * @param path - The file
	 * @memberof SourceCache
	 */
	public forget (path: string): void {
		if (this.overrides.delete(this.key(path))) {
			this.touch(this.key(path));
		}
	}

	/**
	 * The open buffer for a file, without awaiting, or nothing when it is not open.
	 *
	 * TypeScript's `LanguageServiceHost` reads snapshots synchronously and cannot await `read`, so
	 * this is how the language service host sees the same buffers everything else does. It reads
	 * buffers only and never touches the disk: the host has its own synchronous read for that, and
	 * disk content is identical whoever reads it. Open buffers are the only thing two caches could
	 * disagree about, so they are the only thing kept in one place.
	 *
	 * @param path - The file
	 * @returns {string|undefined} The buffer, if the file is open
	 * @memberof SourceCache
	 */
	public peek (path: string): string|undefined {
		return this.overrides.get(this.key(path));
	}

	/**
	 * A version that moves whenever a file's content may have changed
	 *
	 * @param path - The file
	 * @returns {string} The version
	 * @memberof SourceCache
	 */
	public version (path: string): string {
		// a file nobody has opened has never changed under us, so its version is a constant
		// rather than absent — the host has to hand the service something either way
		return String(this.versions.get(this.key(path)) ?? 0);
	}

	/**
	 * The contents of a file, from the editor's buffer when it has one and from disk otherwise
	 *
	 * @param path - The file
	 * @returns {Promise<SourceFile>} Its contents, empty when there is no such file
	 * @memberof SourceCache
	 */
	public async read (path: string): Promise<SourceFile> {
		const override = this.overrides.get(this.key(path));
		if (override !== undefined) {
			return { path, text: override };
		}

		let stats;
		try {
			stats = await fs.stat(path);
		} catch {
			// a file that is not there reads as empty, which every caller wants over a throw
			return { path, text: '' };
		}

		const cached = this.entries.get(this.key(path));
		if (cached && cached.size === stats.size && cached.modified === stats.mtimeMs) {
			return { path, text: cached.text };
		}

		this.readCount++;
		const text = await fs.readFile(path, 'utf-8');
		this.entries.set(this.key(path), { text, size: stats.size, modified: stats.mtimeMs });

		return { path, text };
	}

	/**
	 * Moves a file's version on, so a language service holding a snapshot of it looks again
	 *
	 * @param path - The file whose content may have changed
	 * @memberof SourceCache
	 */
	private touch (path: string): void {
		this.versions.set(path, (this.versions.get(path) ?? 0) + 1);
	}

	/**
	 * The one spelling of a path this keys on.
	 *
	 * The server hands it paths derived from URIs and core hands it paths built with `path.join`.
	 * On Windows those differ in separator for the same file, so an overlay stored under one is
	 * invisible to a reader using the other — and the overlay is the whole point of the cache.
	 *
	 * @param path - A path from anywhere
	 * @returns {string} The same path in the platform's own form
	 * @memberof SourceCache
	 */
	private key (path: string): string {
		return nodePath.normalize(path);
	}
}

interface CacheEntry {
	text: string;
	size: number;
	modified: number;
}

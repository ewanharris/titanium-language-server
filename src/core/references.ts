import fs from 'node:fs/promises';
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

export interface ReferenceIndex {
	usages: ViewUsage[];
	definitions: StyleDefinition[];
	/** Every stylesheet rule that styles this thing, app.tss included since it is just another file */
	stylesDefining (kind: SelectorKind, name: string): StyleDefinition[];
	/** Everywhere a view names it */
	viewsUsing (kind: SelectorKind, name: string): ViewUsage[];
	/** The ids in one view, which is what `$.<id>` completes from */
	idsIn (file: string): string[];
}

/**
 * Builds the index from parsed views and stylesheets.
 *
 * @param sources - The views and stylesheets to read
 * @returns {ReferenceIndex} The relationships between them
 */
export function buildIndex (sources: { views: SourceFile[]; styles: SourceFile[] }): ReferenceIndex {
	const usages = sources.views.flatMap(readView);
	const definitions = sources.styles.flatMap(readStyle);

	return {
		usages,
		definitions,
		stylesDefining: (kind, name) => definitions.filter(definition => definition.kind === kind && definition.name === name),
		viewsUsing: (kind, name) => usages.filter(usage => usage.kind === kind && usage.name === name),
		idsIn: file => usages.filter(usage => usage.file === file && usage.kind === 'id').map(usage => usage.name)
	};
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
export interface SourceCache {
	read (path: string): Promise<SourceFile>;
	/** Supply the editor's buffer for a file, which then wins over whatever is on disk */
	override (path: string, text: string): void;
	/** Drop an override, so the file is read from disk again */
	forget (path: string): void;
	/**
	 * The open buffer for a file, without awaiting, or nothing when it is not open.
	 *
	 * TypeScript's `LanguageServiceHost` reads snapshots synchronously and cannot await `read`, so
	 * this is how the language service host sees the same buffers everything else does. It reads
	 * buffers only and never touches the disk: the host has its own synchronous read for that, and
	 * disk content is identical whoever reads it. Open buffers are the only thing two caches could
	 * disagree about, so they are the only thing kept in one place.
	 */
	peek (path: string): string|undefined;
	/**
	 * A token that changes whenever a file's content might have.
	 *
	 * `getScriptVersion` serving a value that does not move is how a language service ends up
	 * answering from a stale snapshot forever, so this moves on every override and on dropping
	 * one, without comparing text — an edit that lands back on the same characters is still an
	 * edit, and proving otherwise costs more than re-parsing.
	 */
	version (path: string): string;
	/** How many times a file has actually been read, which is what the cache exists to keep down */
	readonly reads: number;
}

interface CacheEntry {
	text: string;
	size: number;
	modified: number;
}

/**
 * Creates a source cache
 *
 * @returns {SourceCache} The cache
 */
export function createSourceCache (): SourceCache {
	const entries = new Map<string, CacheEntry>();
	const overrides = new Map<string, string>();
	const versions = new Map<string, number>();
	let reads = 0;

	/**
	 * Moves a file's version on, so a language service holding a snapshot of it looks again
	 *
	 * @param path - The file whose content may have changed
	 */
	function touch (path: string): void {
		versions.set(path, (versions.get(path) ?? 0) + 1);
	}

	return {
		get reads (): number {
			return reads;
		},

		override (path: string, text: string): void {
			overrides.set(path, text);
			touch(path);
		},

		forget (path: string): void {
			if (overrides.delete(path)) {
				touch(path);
			}
		},

		peek (path: string): string|undefined {
			return overrides.get(path);
		},

		version (path: string): string {
			// a file nobody has opened has never changed under us, so its version is a constant
			// rather than absent — the host has to hand the service something either way
			return String(versions.get(path) ?? 0);
		},

		async read (path: string): Promise<SourceFile> {
			const override = overrides.get(path);
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

			const cached = entries.get(path);
			if (cached && cached.size === stats.size && cached.modified === stats.mtimeMs) {
				return { path, text: cached.text };
			}

			reads++;
			const text = await fs.readFile(path, 'utf-8');
			entries.set(path, { text, size: stats.size, modified: stats.mtimeMs });

			return { path, text };
		}
	};
}

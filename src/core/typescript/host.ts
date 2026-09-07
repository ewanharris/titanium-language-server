import path from 'node:path';
import ts from 'typescript';
import { Project } from '../project.ts';
import type { SourceCache } from '../references.ts';
import { IdentityMapping } from './mapping.ts';
import type { MappedRange, PositionMap } from './mapping.ts';
import type { TypesLocation } from './types.ts';

/**
 * The TypeScript language service, hosted over a Titanium project.
 *
 * The engine behind every JavaScript and TypeScript answer, for both project types. Two things
 * make it a host rather than a plain `createLanguageService` call.
 *
 * The **overlay**: the editor's buffer wins over what is on disk. A host that reads snapshots from
 * the file system answers about the saved file, so every result is one keystroke stale — which
 * users read as flakiness rather than as a bug. The buffers come from the same `SourceCache` the
 * rest of the analysis reads through: two overlays that can disagree is a defect that only appears
 * mid-edit, so there is only ever one.
 *
 * And **the project decides the paths**. A classic project resolves `require` against `Resources/`
 * and an Alloy one against `app/lib/`. `project.sourcePath()` answers that, and the host asks
 * rather than assuming.
 *
 * Every answer carries a position in a real file. Results are mapped through a `PositionMap`
 * before they leave, so generated content — the `$` declaration built from a view — can never
 * point an editor at a file that does not exist.
 */

export interface QuickInfo {
	/** The signature, as TypeScript renders it */
	text: string;
	/** The JSDoc, which is most of hover's value */
	documentation: string;
	/** The file the answer is about */
	path: string;
	/** Where in that file, in character offsets */
	range: { start: number; end: number };
}

/** One entry in a completion list. Documentation is resolved separately, per entry a client shows */
export interface Completion {
	name: string;
	/** TypeScript's own kind — `method`, `property`, `function` — which a client maps to its icons */
	kind: string;
}

/** What a client asks for once a completion is highlighted */
export interface CompletionDetail {
	/** The signature, as TypeScript renders it */
	text: string;
	documentation: string;
}


export interface ProjectServiceOptions {
	project: Project;
	/** Where open buffers come from, shared with the rest of the analysis */
	cache: SourceCache;
	/** The resolved types, or nothing — in which case every answer here is empty */
	types: TypesLocation|undefined;
}

/** What the service is asked to compile. Titanium is not a browser, but the types lean on DOM lib types */
const compilerOptions: ts.CompilerOptions = {
	allowJs: true,
	// diagnostics are not this issue's business, and turning them on would put red squiggles
	// through every Titanium project that has never seen a type checker
	checkJs: false,
	noEmit: true,
	target: ts.ScriptTarget.ES2020,
	module: ts.ModuleKind.CommonJS,
	moduleResolution: ts.ModuleResolutionKind.Node10,
	allowNonTsExtensions: true,
	// the types are supplied as a root file, so nothing should be pulled in by scanning
	// node_modules as well — that is how a project ends up with two Titanium namespaces
	types: []
};

/**
 * The language service for one project.
 *
 * Built through `create` rather than `new`, because the initial file set comes off the disk while
 * everything the language service asks of its host is synchronous. That set is a starting point
 * rather than a fixed list: a file the editor opens is added when it is first asked about, so a
 * file created after the scan still answers.
 */
export class ProjectService {

	public readonly project: Project;
	public readonly types: TypesLocation|undefined;

	private cache: SourceCache;
	private service: ts.LanguageService;
	private roots: Set<string>;
	/** Generated content the service should see as a file, with the mapping back to its source */
	private virtual = new Map<string, { text: string; version: number; map: PositionMap }>();
	private built = false;

	private constructor (options: ProjectServiceOptions, sourcePath: string, roots: Set<string>) {
		this.project = options.project;
		this.cache = options.cache;
		this.types = options.types;
		this.roots = roots;

		const host: ts.LanguageServiceHost = {
			getScriptFileNames: () => [ ...this.roots ],

			getScriptVersion: fileName => {
				const file = this.ours(fileName);
				const generated = this.virtual.get(file);
				return generated ? `v${generated.version}` : this.cache.version(file);
			},

			getScriptSnapshot: fileName => {
				const file = this.ours(fileName);
				const generated = this.virtual.get(file);
				if (generated) {
					return ts.ScriptSnapshot.fromString(generated.text);
				}

				// the editor's buffer first, and only then the disk: this is the overlay, and it is
				// the whole reason for a custom host
				const open = this.cache.peek(file);
				if (open !== undefined) {
					return ts.ScriptSnapshot.fromString(open);
				}

				const text = ts.sys.readFile(file);
				return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
			},

			getCurrentDirectory: () => this.project.filePath,
			getCompilationSettings: () => ({
				...compilerOptions,
				// a bare `require('lib/http')` resolves against Resources for a classic project and
				// app/lib for an Alloy one
				baseUrl: sourcePath
			}),
			getDefaultLibFileName: settings => ts.getDefaultLibFilePath(settings),

			useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,

			fileExists: fileName => this.virtual.has(this.ours(fileName)) || this.cache.peek(this.ours(fileName)) !== undefined || ts.sys.fileExists(fileName),
			readFile: (fileName, encoding) => this.virtual.get(this.ours(fileName))?.text ?? this.cache.peek(this.ours(fileName)) ?? ts.sys.readFile(fileName, encoding),
			readDirectory: ts.sys.readDirectory,
			directoryExists: ts.sys.directoryExists,
			getDirectories: ts.sys.getDirectories,
			realpath: ts.sys.realpath
		};

		this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
	}

	/**
	 * Builds the language service for a project
	 *
	 * @param options - The project, the shared cache and the resolved types
	 * @returns {Promise<ProjectService>} The service
	 * @memberof ProjectService
	 */
	public static async create (options: ProjectServiceOptions): Promise<ProjectService> {
		const sourcePath = await options.project.sourcePath();
		const roots = new Set(await initialFiles(options.project));

		if (options.types) {
			roots.add(options.types.entry);
		}

		return new ProjectService(options, sourcePath, roots);
	}

	/**
	 * Whether the program has been built, so the cold parse is not paid on the first keystroke
	 *
	 * @readonly
	 * @type {boolean}
	 * @memberof ProjectService
	 */
	public get warmed (): boolean {
		return this.built;
	}

	/**
	 * Builds the program now rather than on the first request
	 *
	 * @memberof ProjectService
	 */
	public warm (): void {
		// nothing to parse without the types, and building the program anyway would spend the
		// cold parse to learn only that
		if (!this.types) {
			return;
		}
		this.service.getProgram();
		this.built = true;
	}

	/**
	 * Hover at a position, or nothing when there is nothing to say
	 *
	 * @param filePath - The file asked about
	 * @param offset - Where in it
	 * @returns {QuickInfo|undefined} What to show
	 * @memberof ProjectService
	 */
	public quickInfoAt (filePath: string, offset: number): QuickInfo|undefined {
		if (!this.canAnswerAbout(filePath)) {
			return;
		}

		const info = this.service.getQuickInfoAtPosition(this.ours(filePath), offset);
		if (!info) {
			return;
		}

		const mapped = this.mappingFor(filePath).range({ start: info.textSpan.start, end: info.textSpan.start + info.textSpan.length });
		if (!mapped) {
			// the answer describes generated scaffolding rather than anything the user wrote,
			// so there is nowhere honest to point
			return;
		}

		return {
			text: ts.displayPartsToString(info.displayParts),
			documentation: ts.displayPartsToString(info.documentation),
			path: mapped.path,
			range: mapped.range
		};
	}

	/**
	 * What could be written at a position
	 *
	 * @param filePath - The file asked about
	 * @param offset - Where in it
	 * @returns {Completion[]} The entries, without their documentation
	 * @memberof ProjectService
	 */
	public completionsAt (filePath: string, offset: number): Completion[] {
		if (!this.canAnswerAbout(filePath)) {
			return [];
		}

		const completions = this.service.getCompletionsAtPosition(this.ours(filePath), offset, undefined);

		// entries carry no position, so nothing here needs mapping — the list is what could be
		// written, not where anything is
		return (completions?.entries ?? []).map(entry => ({ name: entry.name, kind: entry.kind as string }));
	}

	/**
	 * The signature and JSDoc for one entry, which a client asks for only when it shows it
	 *
	 * @param filePath - The file asked about
	 * @param offset - Where in it
	 * @param name - The entry
	 * @returns {CompletionDetail|undefined} Its detail
	 * @memberof ProjectService
	 */
	public completionDetail (filePath: string, offset: number, name: string): CompletionDetail|undefined {
		if (!this.canAnswerAbout(filePath)) {
			return;
		}

		const details = this.service.getCompletionEntryDetails(this.ours(filePath), offset, name, undefined, undefined, undefined, undefined);
		if (!details) {
			return;
		}

		return {
			text: ts.displayPartsToString(details.displayParts),
			documentation: ts.displayPartsToString(details.documentation)
		};
	}

	/**
	 * Where what is at a position is declared, mapped back to real files
	 *
	 * @param filePath - The file asked about
	 * @param offset - Where in it
	 * @returns {MappedRange[]} Where to jump to
	 * @memberof ProjectService
	 */
	public definitionsAt (filePath: string, offset: number): MappedRange[] {
		if (!this.canAnswerAbout(filePath)) {
			return [];
		}

		const found = this.service.getDefinitionAtPosition(this.ours(filePath), offset) ?? [];
		const mapped: MappedRange[] = [];

		for (const definition of found) {
			const range = this.mappingFor(definition.fileName).range({
				start: definition.textSpan.start,
				end: definition.textSpan.start + definition.textSpan.length
			});

			// a definition that lands in generated scaffolding rather than in anything the user
			// wrote has nowhere honest to point, so it is dropped rather than guessed at
			if (range) {
				mapped.push(range);
			}
		}

		return mapped;
	}

	/**
	 * Supplies content the service should read as a file, along with the mapping back to what it
	 * was generated from. Called again for the same path, it replaces what was there.
	 *
	 * @param filePath - The path the content stands at
	 * @param text - The content
	 * @param map - How its positions map back to source
	 * @memberof ProjectService
	 */
	public setGenerated (filePath: string, text: string, map: PositionMap): void {
		// the version has to move or the service serves what it parsed the first time, which
		// is how a regenerated declaration ends up describing the previous version of a view
		const file = this.ours(filePath);
		const version = (this.virtual.get(file)?.version ?? 0) + 1;
		this.virtual.set(file, { text, version, map });
		this.roots.add(file);
	}

	/**
	 * Drops generated content, so the service stops seeing it
	 *
	 * @param filePath - The path it stood at
	 * @memberof ProjectService
	 */
	public dropGenerated (filePath: string): void {
		this.virtual.delete(this.ours(filePath));
		this.roots.delete(this.ours(filePath));
	}

	/**
	 * Releases the parsed program
	 *
	 * @memberof ProjectService
	 */
	public dispose (): void {
		this.service.dispose();
	}

	/**
	 * A file name in the form this class keys its own maps on.
	 *
	 * TypeScript normalises paths its own way and hands them back that way — forward slashes, even
	 * on Windows — while the cache and the generated content are keyed on the path the caller
	 * built with `path.join`. Without this every lookup misses on Windows, and a buffer that only
	 * exists in the overlay is invisible: the file falls through to disk, is not there, and the
	 * service answers nothing.
	 *
	 * @param fileName - A path from anywhere
	 * @returns {string} The same path in the platform's own form
	 * @memberof ProjectService
	 */
	private ours (fileName: string): string {
		return path.normalize(fileName);
	}

	/**
	 * Whether the service can answer about a file at all.
	 *
	 * Asking the program about a file it does not have throws rather than answering nothing, and an
	 * editor showing "request failed" on every keystroke is worse than one showing nothing. A file
	 * the editor opened after the workspace scan is added here rather than being turned away, so a
	 * file created since the scan still answers.
	 *
	 * @param filePath - The file being asked about
	 * @returns {boolean} Whether to go on
	 * @memberof ProjectService
	 */
	private canAnswerAbout (filePath: string): boolean {
		if (!this.types) {
			return false;
		}

		this.roots.add(this.ours(filePath));

		return Boolean(this.service.getProgram()?.getSourceFile(this.ours(filePath)));
	}

	/**
	 * The mapping for a file the service knows about
	 *
	 * @param fileName - The file
	 * @returns {PositionMap} Its mapping, which is the identity for a real file
	 * @memberof ProjectService
	 */
	private mappingFor (fileName: string): PositionMap {
		return this.virtual.get(this.ours(fileName))?.map ?? new IdentityMapping(this.ours(fileName));
	}
}

/**
 * The files the project starts with.
 *
 * Its own sources rather than everything under the root: `node_modules` and `build/` are large,
 * uninteresting, and would be parsed on every warm.
 *
 * @param project - The project to scan
 * @returns {Promise<string[]>} Absolute paths
 */
async function initialFiles (project: Project): Promise<string[]> {
	const [ lib, controllers, models ] = await Promise.all([
		project.libFiles(),
		project.controllers(),
		// a model is a JavaScript file the controller's `Alloy.createModel` answers from
		project.models()
	]);

	const files = [ ...lib, ...controllers, ...models ];

	// alloy.js runs before every controller, so what it puts on Alloy.Globals is in scope for all
	// of them
	if (await project.type() === 'alloy') {
		files.push(path.join(project.filePath, 'app', 'alloy.js'));
	}

	return files;
}

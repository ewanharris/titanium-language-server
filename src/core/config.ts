import path from 'node:path';
import { Project } from './project.ts';
import type { SourceCache } from './references.ts';

/**
 * An Alloy project's `app/config.json`, as much of it as `Alloy.CFG` is made of.
 *
 * Alloy builds `Alloy.CFG` by merging `global` with the section for the build's environment
 * (`env:development`, `env:test`, `env:production`) and its platform (`os:ios`, `os:android`,
 * `os:windows`). Neither is known while someone is editing a controller, and picking one would be
 * a guess that silently hides keys. So the union is what this answers: a key any section declares
 * is a key the user can legitimately write, and offering it is right whichever build runs.
 *
 * Where two sections declare the same key, the later one in merge order wins. That only decides
 * the *type* shown, never whether the key is offered, so the cost of the arbitrary part is small.
 *
 * `dependencies` is deliberately not part of it. It is the widget manifest — Alloy reads it to
 * decide what to bundle — and it never reaches `Alloy.CFG`, so putting it there would offer a
 * member that does not exist at run time.
 *
 * Read through the shared `SourceCache`, so an open buffer wins over the disk.
 */

/** The sections Alloy merges into CFG, in the order it merges them */
const MERGED = [ /^global$/, /^os:/, /^env:/ ];

export interface AlloyConfiguration {
	/** The merged keys, with nested objects left nested because that is how they are written */
	values: Record<string, unknown>;
	/** The widgets the project depends on, by name */
	dependencies: string[];
}

/** A theme a build could apply */
export interface AlloyTheme {
	name: string;
	/** Whether it depends on which environment or platform is being built */
	conditional: boolean;
}

/**
 * The configuration of an Alloy project, or nothing when there is none to read.
 *
 * Never throws. Nothing is the answer for a classic project, for a file being typed, and for a
 * file that parses to something other than an object — a broken `config.json` must not take the
 * rest of the generated declaration down with it, because the user is most likely editing it.
 *
 * @param project - The project to read
 * @param cache - Where open buffers come from, shared with the rest of the analysis
 * @returns {Promise<AlloyConfiguration|undefined>} The configuration, when there is one
 */
export async function readAlloyConfig (project: Project, cache: SourceCache): Promise<AlloyConfiguration|undefined> {
	if (await project.type() !== 'alloy') {
		return;
	}

	const parsed = await readConfigFile(project, cache);
	if (!parsed) {
		return;
	}

	const values: Record<string, unknown> = {};

	for (const pattern of MERGED) {
		for (const [ section, contents ] of Object.entries(parsed)) {
			// a section that is not an object is hand written nonsense rather than configuration,
			// and spreading a string would put its characters on CFG by index
			if (pattern.test(section) && isObject(contents)) {
				Object.assign(values, contents);
			}
		}
	}

	const dependencies = isObject(parsed.dependencies) ? Object.keys(parsed.dependencies) : [];

	return { values, dependencies };
}

/**
 * The themes a build of an Alloy project could apply, from `theme` at the top level of
 * `config.json`, in `global` or in any environment or platform section.
 *
 * One theme named only at the top level or in `global` applies to every build. Anything else
 * depends on which environment or platform is being built, which an editor cannot know, so each
 * theme named is one that may apply. Never throws, and answers none where there is no
 * configuration to read.
 *
 * @param project - The project to read
 * @param cache - Where open buffers come from
 * @returns {Promise<AlloyTheme[]>} The themes
 */
export async function readThemes (project: Project, cache: SourceCache): Promise<AlloyTheme[]> {
	if (await project.type() !== 'alloy') {
		return [];
	}

	const parsed = await readConfigFile(project, cache);
	return parsed ? themesIn(parsed) : [];
}

/**
 * `app/config.json`, parsed, when it is an object
 *
 * @param project - The project
 * @param cache - Where open buffers come from
 * @returns {Promise<Record<string, unknown>|undefined>} The parsed file, or nothing
 */
async function readConfigFile (project: Project, cache: SourceCache): Promise<Record<string, unknown>|undefined> {
	const { text } = await cache.read(path.join(project.filePath, 'app', 'config.json'));

	try {
		const parsed: unknown = JSON.parse(text);
		return isObject(parsed) ? parsed : undefined;
	} catch {
		return;
	}
}

/**
 * The themes `config.json` names, as `parseConfig` in Alloy's `compilerUtils.js` reads them: a
 * `theme` at the top level, then in `global`, then in the sections for the build's environment and
 * platform, each overriding the one before
 *
 * @param parsed - The parsed configuration
 * @returns {AlloyTheme[]} Each theme named, and whether it depends on the build
 */
function themesIn (parsed: Record<string, unknown>): AlloyTheme[] {
	const unconditional = new Set<string>();
	const conditional = new Set<string>();

	const read = (section: unknown, into: Set<string>): void => {
		if (isObject(section) && typeof section.theme === 'string' && section.theme) {
			into.add(section.theme);
		}
	};

	read(parsed, unconditional);
	read(parsed.global, unconditional);
	for (const [ section, contents ] of Object.entries(parsed)) {
		if (/^(?:env|os|dist):/.test(section)) {
			read(contents, conditional);
		}
	}

	// a section for one build naming a different theme means the global one does not reach that
	// build, so only a single theme named for every build and overridden by none is certain
	const names = new Set([ ...unconditional, ...conditional ]);
	const certain = names.size === 1 && unconditional.size === 1;

	return [ ...names ].map(name => ({ name, conditional: !certain }));
}

/**
 * Whether a parsed value is a plain object, as opposed to an array, a primitive or null
 *
 * @param value - The value to test
 * @returns {boolean} Whether it can be read as a section
 */
function isObject (value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

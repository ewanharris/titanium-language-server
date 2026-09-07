import fs from 'node:fs/promises';
import path from 'node:path';
import { pathExists } from '../fs.ts';
import { Project } from '../project.ts';
import { selectTypesVersion } from './versions.ts';
import type { TypesAcquirer } from './acquire.ts';

/**
 * Where a project's Titanium types come from.
 *
 * An ordered list of sources rather than a hardcoded path, because there is already more than one
 * — the project's own copy, then npm — and there is likely to be a third: types published in the
 * SDK itself are being pursued upstream, and would slot in between the two without anything else
 * changing. Each source either answers or declines, and the first answer wins.
 *
 * Nothing is bundled with this server. Shipping a third-party type package inside a language
 * server is the unusual move: VS Code's automatic type acquisition fetches `@types` into a cache
 * rather than shipping them, and TypeScript bundles only its own `lib.d.ts`. When nothing
 * resolves, the features that need types answer nothing and the user is told which `sdk-version`
 * could not be satisfied — a wrong-version answer given confidently is worse than no answer.
 */

export interface TypesLocation {
	/** The package directory */
	packagePath: string;
	/** The entry `.d.ts` the language service loads */
	entry: string;
	version: string|undefined;
	/** Which source answered, so a message can say where the types came from */
	source: string;
}

/**
 * What to tell the user about how this resolved.
 *
 * Two levels rather than a single log line, because the cases genuinely differ. The types trail
 * the SDK even on a supported major — SDK 13.4.1.GA against types 13.3.0 — so nearly every project
 * falls back a little and a message about it would be noise. Crossing a major, or resolving
 * nothing at all, changes what the editor can tell the user and is worth interrupting for.
 */
export interface TypesReport {
	level: 'info'|'warning';
	message: string;
}

export interface TypesResolution {
	location: TypesLocation|undefined;
	report: TypesReport;
}

/** A place types might come from. Answering `undefined` means "not here", and the next source runs */
export interface TypesSource {
	readonly name: string;
	locate (project: Project): Promise<TypesResolution|undefined>;
}

/**
 * The types the project has installed itself.
 *
 * Always preferred, and never reported as a fallback whatever version it is: the project compiles
 * against this copy, so answering from anything else would describe a different program than the
 * one being built.
 *
 * @returns {TypesSource} The source
 */
export function projectTypes (): TypesSource {
	return {
		name: 'the project',
		async locate (project: Project): Promise<TypesResolution|undefined> {
			const packagePath = path.join(project.filePath, 'node_modules', '@types', 'titanium');

			const location = await describe(packagePath, 'the project');
			if (!location) {
				return;
			}

			return {
				location,
				report: {
					level: 'info',
					message: `Using @types/titanium ${location.version ?? 'of unknown version'} from the project's own node_modules`
				}
			};
		}
	};
}

/**
 * Types fetched from npm, keyed to the tiapp's `sdk-version`
 *
 * @param acquirer - How to reach npm, which a test replaces
 * @returns {TypesSource} The source
 */
export function acquiredTypes (acquirer: TypesAcquirer): TypesSource {
	return {
		name: 'npm',
		async locate (project: Project): Promise<TypesResolution|undefined> {
			const sdkVersion = project.sdkVersion();
			const selection = selectTypesVersion(sdkVersion, await acquirer.versions());
			if (!selection.version) {
				// nothing published at or below this SDK, or the registry could not be reached;
				// either way this source has no answer and the next one gets a turn
				return;
			}

			const packagePath = await acquirer.install(selection.version);
			if (!packagePath) {
				return;
			}

			const location = await describe(packagePath, 'npm');
			if (!location) {
				return;
			}

			// the acquirer was asked for an exact version, so trust that over a missing or odd
			// package.json in what it fetched
			location.version = selection.version;

			return {
				location,
				report: selection.kind === 'older-major'
					? {
						level: 'warning',
						message: `No @types/titanium is published for Titanium SDK ${sdkVersion}, so ${selection.version} is being used instead. `
							+ 'Members added since then will not be offered. Installing @types/titanium in the project will override this.'
					}
					: {
						level: 'info',
						message: `Using @types/titanium ${selection.version} for Titanium SDK ${sdkVersion}`
					}
			};
		}
	};
}

/**
 * Walks the sources in order and takes the first answer.
 *
 * @param project - The project to resolve for
 * @param sources - Where to look, in preference order
 * @returns {Promise<TypesResolution>} What was found, or a report saying why nothing was
 */
export async function resolveTypes (project: Project, sources: TypesSource[]): Promise<TypesResolution> {
	for (const source of sources) {
		const resolved = await source.locate(project);
		if (resolved?.location) {
			return resolved;
		}
	}

	const sdkVersion = project.isValid ? project.sdkVersion() : 'unknown';

	return {
		location: undefined,
		report: {
			level: 'warning',
			message: `No @types/titanium could be resolved for Titanium SDK ${sdkVersion}, so JavaScript and TypeScript features are unavailable in ${project.filePath}. `
				+ 'Running `npm install --save-dev @types/titanium` in the project will fix it.'
		}
	};
}

/**
 * Reads a package directory into a location.
 *
 * The entry comes from the package's own `types` or `typings` field rather than being assumed to
 * be `index.d.ts` — that is what it is for `@types/titanium` today, and reading the manifest costs
 * nothing and does not depend on it staying that way.
 *
 * @param packagePath - The package directory
 * @param source - Which source found it
 * @returns {Promise<TypesLocation|undefined>} The location, or nothing when there is no usable package there
 */
async function describe (packagePath: string, source: string): Promise<TypesLocation|undefined> {
	if (!await pathExists(packagePath)) {
		return;
	}

	let manifest: { version?: string; types?: string; typings?: string } = {};
	try {
		manifest = JSON.parse(await fs.readFile(path.join(packagePath, 'package.json'), 'utf-8'));
	} catch {
		// a package with no readable manifest still has types if index.d.ts is there
	}

	const entry = path.join(packagePath, manifest.types ?? manifest.typings ?? 'index.d.ts');
	if (!await pathExists(entry)) {
		return;
	}

	return { packagePath, entry, version: manifest.version, source };
}

import fs from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';

/**
 * The native and CommonJS modules installed in a modules directory.
 *
 * Read by hand rather than through `ti module list`, which looks like the obvious source and is not
 * one a language server can run. Before it lists anything it extracts every zip shaped like a
 * module — `^.+-.+?-.+?\.zip$`, which `my-app-backup.zip` matches — from the directory above each
 * modules directory it searches, and deletes the zip. For a project that directory is the project
 * root. A completion must not install or delete anything.
 *
 * What is read follows the CLI's own detection in `util/timodule.js`, so a module offered here is
 * one the build would find: a module is a `<platform>/<name>/<version>/manifest`, and its id,
 * version and platform come from the manifest rather than from the directories it sits in.
 */

export interface InstalledModule {
	/** The manifest's `moduleid`, which is what a tiapp.xml `<module>` names */
	id: string;
	version: string;
	/** As the CLI reports it, so `iphone` and `ipad` read as `ios` */
	platform: string;
	/** The version directory */
	path: string;
}

/** The CLI's pattern for operating system directories, kept exactly — including its precedence */
const OS_NAMES = /^osx|win32|linux$/;

/** The CLI's default `cli.ignoreDirs` */
const IGNORED = /^(.svn|.git|.hg|.?[Cc][Vv][Ss]|.bzr)$/;

/** The platform names the CLI rewrites */
const PLATFORM_ALIASES: Record<string, string> = { ipad: 'ios', iphone: 'ios' };

/**
 * Every module installed under a modules directory.
 *
 * A stray file is skipped at every level: a platform, a module and a version are all directories,
 * and a version only counts when it has a manifest.
 *
 * @param directory - A modules directory: a project's `modules`, or one under the Titanium home
 * @returns {Promise<InstalledModule[]>} Each installed version, by id, platform and version
 */
export async function readModules (directory: string): Promise<InstalledModule[]> {
	const found: InstalledModule[] = [];

	for (const platform of await directoriesIn(directory)) {
		if (OS_NAMES.test(platform) || IGNORED.test(platform)) {
			continue;
		}

		for (const name of await directoriesIn(path.join(directory, platform))) {
			if (IGNORED.test(name)) {
				continue;
			}

			for (const version of await directoriesIn(path.join(directory, platform, name))) {
				const module = IGNORED.test(version) ? undefined : await readModule(path.join(directory, platform, name, version));
				if (module) {
					found.push(module);
				}
			}
		}
	}

	return found.sort((a, b) => a.id.localeCompare(b.id) || a.platform.localeCompare(b.platform) || compareVersions(a.version, b.version));
}

/**
 * One installed version of a module, when its manifest says enough to be one
 *
 * @param versionPath - The version directory
 * @returns {Promise<InstalledModule|undefined>} The module, or nothing for one the CLI would skip
 */
async function readModule (versionPath: string): Promise<InstalledModule|undefined> {
	let contents;
	try {
		contents = await fs.readFile(path.join(versionPath, 'manifest'), 'utf-8');
	} catch {
		return;
	}

	const manifest = readManifest(contents);
	const version = manifest.version ?? path.basename(versionPath);
	const platform = manifest.platform?.toLowerCase();

	// the CLI drops a module whose manifest names no platform, and one whose version it cannot
	// read. One without a moduleid it keeps, under `undefined`, where nothing can name it
	if (!manifest.moduleid || !platform || !isVersion(version)) {
		return;
	}

	return { id: manifest.moduleid, version, platform: PLATFORM_ALIASES[platform] ?? platform, path: versionPath };
}

/**
 * A module manifest's fields.
 *
 * The CLI's reading, which is looser than it looks: the key is everything before the first colon,
 * untrimmed, and the value everything after it, trimmed — which is also what makes a Windows line
 * ending harmless.
 *
 * @param contents - The manifest
 * @returns {Record<string, string>} Its fields
 */
function readManifest (contents: string): Record<string, string|undefined> {
	const fields: Record<string, string> = {};

	for (const line of contents.split('\n')) {
		const colon = line.indexOf(':');
		if (line.charAt(0) !== '#' && colon !== -1) {
			fields[line.slice(0, colon)] = line.slice(colon + 1).trim();
		}
	}

	return fields;
}

/**
 * Whether the CLI would read something as a version: `semver.valid` of it padded or cut to three
 * parts, which is `version.isValid` in the CLI's `util/version.js`
 *
 * @param version - The version, from the manifest or the directory name
 * @returns {boolean} Whether it is one
 */
function isVersion (version: string): boolean {
	return semver.valid(toThreeParts(version)) !== null;
}

/**
 * Orders two versions as semver does, which is what a person reading a list expects: `10.0.0`
 * after `9.0.0`, and a release after its own prereleases.
 *
 * Each is read as the CLI reads it, padded or cut to three parts before its prerelease, so `9`
 * is `9.0.0` and `1.0.0.1` is `1.0.0`. What is not a version at all goes after every version.
 *
 * @param a - One version
 * @param b - The other
 * @returns {number} Negative, zero or positive, as `sort` wants
 */
export function compareVersions (a: string, b: string): number {
	const left = semver.valid(toThreeParts(a, true));
	const right = semver.valid(toThreeParts(b, true));

	if (left && right) {
		return semver.compare(left, right);
	}
	if (left || right) {
		return left ? -1 : 1;
	}
	return a.localeCompare(b, undefined, { numeric: true });
}

/**
 * A version padded or cut to three dotted parts, as the CLI's `version.format(v, 3, 3)` makes it.
 *
 * The CLI splits the whole version on its dots, so a prerelease with a dot in it is cut too:
 * `1.0.0-beta.2` is `1.0.0-beta` to its validity check. Ordering keeps the prerelease whole and
 * pads only the part before it, so that `beta.2` still comes after `beta`.
 *
 * @param version - The version
 * @param keepPrerelease - Whether to pad the part before the prerelease rather than the whole
 * @returns {string} The version in three parts
 */
function toThreeParts (version: string, keepPrerelease = false): string {
	const trimmed = version.trim();
	const tail = keepPrerelease ? /[-+].*$/.exec(trimmed)?.[0] ?? '' : '';
	const parts = trimmed.slice(0, trimmed.length - tail.length).split('.');

	while (parts.length < 3) {
		parts.push('0');
	}
	return parts.slice(0, 3).join('.') + tail;
}

/**
 * The directories directly inside one, by name, a link to a directory among them.
 *
 * The CLI stats each entry, which follows a link, so a module linked in while it is being developed
 * is installed to the build. A link to nothing is not a directory.
 *
 * @param directory - Where to look
 * @returns {Promise<string[]>} The names, or nothing for a directory that cannot be read
 */
async function directoriesIn (directory: string): Promise<string[]> {
	let entries;
	try {
		entries = await fs.readdir(directory, { withFileTypes: true });
	} catch {
		return [];
	}

	const names: string[] = [];
	for (const entry of entries) {
		if (entry.isDirectory() || (entry.isSymbolicLink() && await isDirectory(path.join(directory, entry.name)))) {
			names.push(entry.name);
		}
	}
	return names;
}

/**
 * Whether a path is a directory once any link is followed
 *
 * @param target - The path
 * @returns {Promise<boolean>} Whether it is
 */
async function isDirectory (target: string): Promise<boolean> {
	try {
		return (await fs.stat(target)).isDirectory();
	} catch {
		return false;
	}
}

import fs from 'node:fs/promises';
import path from 'node:path';

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
 * Whether the CLI would read something as a version: padded to three parts, then semver.
 *
 * @param version - The version, from the manifest or the directory name
 * @returns {boolean} Whether it is one
 */
function isVersion (version: string): boolean {
	const parts = version.split('.');
	while (parts.length < 3) {
		parts.push('0');
	}

	return /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(parts.slice(0, 3).join('.'));
}

/**
 * Orders two versions as semver does, which is what a person reading a list expects.
 *
 * The parts before a prerelease are compared by value — `10.0.0` after `9.0.0`, where comparing
 * them as strings puts it first — and a missing one counts as zero. A release comes after its own
 * prereleases, which compare identifier by identifier, numbers by value and below words. A leading
 * `v` and build metadata say nothing about the order.
 *
 * @param a - One version
 * @param b - The other
 * @returns {number} Negative, zero or positive, as `sort` wants
 */
export function compareVersions (a: string, b: string): number {
	const left = splitVersion(a);
	const right = splitVersion(b);

	for (let index = 0; index < Math.max(left.core.length, right.core.length); index++) {
		const order = compareIdentifiers(left.core[index] ?? '0', right.core[index] ?? '0');
		if (order) {
			return order;
		}
	}

	// a release is newer than any prerelease of it
	if (!left.prerelease.length || !right.prerelease.length) {
		return right.prerelease.length - left.prerelease.length;
	}

	for (let index = 0; index < Math.min(left.prerelease.length, right.prerelease.length); index++) {
		const order = compareIdentifiers(left.prerelease[index], right.prerelease[index]);
		if (order) {
			return order;
		}
	}

	// the one with more identifiers, when the rest are equal: beta.1 after beta
	return left.prerelease.length - right.prerelease.length;
}

/**
 * A version's dotted parts, before and after its prerelease
 *
 * @param version - The version
 * @returns The parts of each
 */
function splitVersion (version: string): { core: string[]; prerelease: string[] } {
	const withoutBuild = version.trim().replace(/^v/, '').split('+')[0];
	const dash = withoutBuild.indexOf('-');
	const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
	const prerelease = dash === -1 ? '' : withoutBuild.slice(dash + 1);

	return { core: core.split('.'), prerelease: prerelease ? prerelease.split('.') : [] };
}

/**
 * Two parts of a version: by value when both are numbers, a number before a word, and words as text
 *
 * @param a - One part
 * @param b - The other
 * @returns {number} Negative, zero or positive
 */
function compareIdentifiers (a: string, b: string): number {
	const numeric = (part: string): boolean => /^\d+$/.test(part);

	if (numeric(a) && numeric(b)) {
		return Number(a) - Number(b);
	}
	if (numeric(a) !== numeric(b)) {
		return numeric(a) ? -1 : 1;
	}
	return a.localeCompare(b);
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

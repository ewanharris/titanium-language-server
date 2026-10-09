import path from 'node:path';
import fs from 'node:fs/promises';
import { Project } from './project.ts';
import { logger } from '../logger.ts';

/**
 * The projects the server knows about.
 *
 * A workspace folder is not a project. It is often a parent of one — a repository holding the app
 * beside its server, or a monorepo — so each folder is scanned one level down as well as itself.
 * One level rather than a walk: a deep scan of a large repository is paid for on every folder
 * change, and a Titanium project nested more deeply than that is rare enough to open directly.
 *
 * What is on disk changes under an open workspace — `ti create` makes a project, an edit changes
 * the sdk-version every lookup is keyed off, a half saved tiapp.xml is fixed — so `refresh` looks
 * again, and the server calls it before answering each request. Rather than watching: that needs
 * a capability not every client has, and checking costs a directory read per folder and a `stat`
 * per candidate, with a tiapp.xml read again only when its time or size moved.
 */
export class ProjectRegistry {

	/** Projects by their root, with the folders that found each one and the tiapp.xml it was read from */
	private registered = new Map<string, { project: Project; roots: Set<string>; stamp: string }>();

	/** Directories looked at and turned away, with the tiapp.xml they were turned away for */
	private rejected = new Map<string, string>();

	/** The folders scanned, which `refresh` scans again */
	private roots = new Set<string>();

	/**
	 * Every project currently registered
	 *
	 * @readonly
	 * @type {Project[]}
	 * @memberof ProjectRegistry
	 */
	public get projects (): Project[] {
		return [ ...this.registered.values() ].map(entry => entry.project);
	}

	/**
	 * Registers the Titanium projects at or one level below each of the given roots.
	 *
	 * A directory that is not a project, or is one we could not read, is skipped rather than
	 * registered — every lookup downstream is keyed off the SDK version, so a project without one
	 * has nothing to offer and would only fail later.
	 *
	 * @param roots - Directories to scan, typically the workspace folders
	 * @returns {Promise<Project[]>} The projects this call added, which excludes any already known
	 * @memberof ProjectRegistry
	 */
	public async add (roots: string[]): Promise<Project[]> {
		const added: Project[] = [];

		for (const root of roots) {
			this.roots.add(root);

			for (const candidate of await this.candidates(root)) {
				const existing = this.registered.get(candidate);
				if (existing) {
					existing.roots.add(root);
					continue;
				}

				const project = await this.admit(candidate, new Set([ root ]), await stampOf(candidate));
				if (project) {
					added.push(project);
				}
			}
		}

		return added;
	}

	/**
	 * Looks at every folder again, and brings the registry up to date with what is on disk now.
	 *
	 * A project whose tiapp.xml changed is dropped and read again rather than patched in place: its
	 * SDK version is what everything built for it was chosen by, so a caller holding anything per
	 * project — a language service, the types it resolved — gets the old one in `dropped` and the
	 * new one in `added`, and rebuilds. One whose tiapp.xml stopped declaring an SDK, or is gone
	 * along with its directory, is dropped alone. A directory turned away before is read again only
	 * when its tiapp.xml has moved since.
	 *
	 * @returns The projects this call added and the ones it dropped
	 * @memberof ProjectRegistry
	 */
	public async refresh (): Promise<{ added: Project[]; dropped: Project[] }> {
		const found = new Map<string, Set<string>>();
		for (const root of this.roots) {
			for (const candidate of await this.candidates(root)) {
				found.set(candidate, (found.get(candidate) ?? new Set()).add(root));
			}
		}

		const dropped: Project[] = [];
		for (const [ candidate, entry ] of this.registered) {
			if (found.has(candidate) && await stampOf(candidate) === entry.stamp) {
				continue;
			}
			this.registered.delete(candidate);
			dropped.push(entry.project);
			logger.log(found.has(candidate) ? `tiapp.xml changed at ${candidate}, reading it again` : `Removed project at ${candidate}`);
		}

		const added: Project[] = [];
		for (const [ candidate, roots ] of found) {
			if (this.registered.has(candidate)) {
				continue;
			}

			const stamp = await stampOf(candidate);
			if (this.rejected.get(candidate) === stamp) {
				continue;
			}

			const project = await this.admit(candidate, roots, stamp);
			if (project) {
				added.push(project);
			}
		}

		return { added, dropped };
	}

	/**
	 * Forgets the projects the given roots brought in.
	 *
	 * A project two folders both found survives the removal of one of them, which is what a
	 * workspace holding both a project and its parent looks like.
	 *
	 * @param roots - The directories being removed, typically workspace folders
	 * @returns {Project[]} The projects that are now gone, so a caller holding anything per project
	 *   — a language service and its parsed program, say — can let it go
	 * @memberof ProjectRegistry
	 */
	public remove (roots: string[]): Project[] {
		const dropped: Project[] = [];

		for (const root of roots) {
			this.roots.delete(root);

			for (const [ candidate, entry ] of this.registered) {
				entry.roots.delete(root);
				if (!entry.roots.size) {
					this.registered.delete(candidate);
					dropped.push(entry.project);
					logger.log(`Removed project at ${candidate}`);
				}
			}
		}

		return dropped;
	}

	/**
	 * The project a file belongs to.
	 *
	 * The innermost wins, so an example app inside a project answers as itself rather than as its
	 * host.
	 *
	 * @param filePath - An absolute path to a file
	 * @returns {Project|undefined} The project containing it, if one does
	 * @memberof ProjectRegistry
	 */
	public projectFor (filePath: string): Project|undefined {
		let best: Project|undefined;

		for (const { project } of this.registered.values()) {
			if (!contains(project.filePath, filePath)) {
				continue;
			}
			if (!best || project.filePath.length > best.filePath.length) {
				best = project;
			}
		}

		return best;
	}

	/**
	 * Reads a directory as a project, and registers it when it is one.
	 *
	 * The stamp is taken before the read rather than after, so an edit landing between the two
	 * leaves the stamp stale and the next refresh reads the file again, rather than the other way
	 * round, which would keep the old answer for good.
	 *
	 * @param candidate - The directory
	 * @param roots - The folders that found it
	 * @param stamp - Its tiapp.xml, as `stampOf` saw it before reading
	 * @returns {Promise<Project|undefined>} The project, when it is one
	 * @memberof ProjectRegistry
	 */
	private async admit (candidate: string, roots: Set<string>, stamp: string): Promise<Project|undefined> {
		const project = new Project(candidate);
		if (!await project.load()) {
			this.rejected.set(candidate, stamp);
			return;
		}

		this.rejected.delete(candidate);
		this.registered.set(candidate, { project, roots, stamp });
		logger.log(`Registered ${await project.type()} project at ${candidate}`);
		return project;
	}

	/**
	 * The directories to consider for one root: the root itself, then its immediate children.
	 *
	 * A root that cannot be read yields nothing. A workspace folder can name a directory that does
	 * not exist — it was deleted, or lives on a drive that is not mounted — and that is not an
	 * error, it is just a folder with no projects in it.
	 *
	 * @param root - The directory to scan
	 * @returns {Promise<string[]>} Absolute paths, the root first
	 * @memberof ProjectRegistry
	 */
	private async candidates (root: string): Promise<string[]> {
		const found = [ root ];

		try {
			for (const entry of await fs.readdir(root, { withFileTypes: true })) {
				if (entry.isDirectory()) {
					found.push(path.join(root, entry.name));
				}
			}
		} catch {
			return [];
		}

		return found;
	}
}

/**
 * What a directory's tiapp.xml looks like from outside: its modification time and size, or that it
 * is not there. Enough to tell whether it needs reading again without reading it.
 *
 * @param directory - The candidate directory
 * @returns {Promise<string>} A value that changes when the file does
 */
async function stampOf (directory: string): Promise<string> {
	try {
		const stat = await fs.stat(path.join(directory, 'tiapp.xml'));
		return `${stat.mtimeMs}:${stat.size}`;
	} catch {
		return 'missing';
	}
}

/**
 * Whether a path sits inside a directory.
 *
 * Compared as paths rather than as strings: `/a/project-two` starts with `/a/project` and is not
 * in it.
 *
 * @param directory - The containing directory
 * @param filePath - The path to test
 * @returns {boolean} Whether the file is the directory or is under it
 */
function contains (directory: string, filePath: string): boolean {
	const relative = path.relative(directory, filePath);
	return !relative.startsWith('..') && !path.isAbsolute(relative);
}

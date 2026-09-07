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
 * Validity is decided once, when a directory is registered. That is deliberately the weakest
 * option: `ti create` inside an open workspace, or an edit to sdk-version, is not noticed until
 * the server restarts. #32 covers making it live.
 */
export class ProjectRegistry {

	/** Projects by their root, with the folders that found each one */
	private registered = new Map<string, { project: Project; roots: Set<string> }>();

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
			for (const candidate of await this.candidates(root)) {
				const existing = this.registered.get(candidate);
				if (existing) {
					existing.roots.add(root);
					continue;
				}

				const project = new Project(candidate);
				if (!await project.load()) {
					continue;
				}

				this.registered.set(candidate, { project, roots: new Set([ root ]) });
				added.push(project);
				logger.log(`Registered ${await project.type()} project at ${candidate}`);
			}
		}

		return added;
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

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Whether a path exists.
 *
 * Node has no direct equivalent of fs-extra's pathExists, but access() is the same thing once the
 * rejection is turned into a boolean.
 *
 * @param target - The path to test
 * @returns {Promise<boolean>} Whether it exists
 */
export async function pathExists (target: string): Promise<boolean> {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}

/**
 * Recursively collects the files under a directory whose extension matches one of those given.
 *
 * A missing directory yields an empty list rather than throwing — callers only care about the files
 * that are there, and a project legitimately might not have an app/lib or a Resources/images.
 *
 * @param directory - The directory to walk
 * @param extensions - Extensions to keep, including the leading dot
 * @returns {Promise<string[]>} Absolute paths, sorted
 */
export async function findFiles (directory: string, extensions: string[]): Promise<string[]> {
	let entries;
	try {
		entries = await fs.readdir(directory, { recursive: true, withFileTypes: true });
	} catch {
		return [];
	}

	const files: string[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !extensions.includes(path.extname(entry.name))) {
			continue;
		}
		// parentPath replaced path in Node 20.12; fall back so Node 20.1 to 20.11 still work
		const parent = entry.parentPath ?? (entry as unknown as { path: string }).path;
		files.push(path.join(parent, entry.name));
	}

	return files.sort();
}

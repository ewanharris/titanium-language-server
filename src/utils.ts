import fs from 'fs-extra';
import path from 'path';
import xml2js from 'xml2js';
import klaw from 'klaw';

/**
 * Determines the type of application project
 *
 * @export
 * @param {string} projectDirectory - The path to the project directory
 * @returns {(Promise<'alloy' | 'classic'>)}
 */
export async function determineAppProjectType (projectDirectory: string): Promise<'alloy' | 'classic'> {
	if (await fs.pathExists(path.join(projectDirectory, 'app'))) {
		return 'alloy';
	} else {
		return 'classic';
	}
}

/**
 * From a project directory path, obtain the app name
 *
 * @export
 * @param {string} projectDirectory - The path to the project directory
 * @returns {Promise<string>}
 */
export async function getAppName (projectDirectory: string): Promise<string> {
	const tiappPath = path.join(projectDirectory, 'tiapp.xml');
	const fileData = await fs.readFile(tiappPath, 'utf-8');
	const result = await parseXmlString(fileData) as { 'ti:app': { name: string[] }};
	return result['ti:app'].name[0];
}

/**
 * Parses an XML string into a JSON object using xml2js
 *
 * @export
 * @template T
 * @param {string} xmlString - The string to parse
 * @returns {Promise<T>}
 */
export function parseXmlString<T>(xmlString: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const parser = new xml2js.Parser();
		parser.parseString(xmlString, (err: Error|null, result: T) => {
			if (!err) {
				return resolve(result);
			} else {
				return reject(err);
			}
		});
	});
}

/**
 * Recursively read a directory and collect the files whose extensions match the provided list
 *
 * @export
 * @param {string} directory - The directory to walk
 * @param {string[]} extensions - The list of extensions to check against
 * @returns {Promise<string[]>}
 */
export async function filterFiles (directory: string, extensions: string[]): Promise<string[]> {
	const files: string[] = [];

	// klaw throws an ENOENT when walking a directory that does not exist, but callers only care
	// about the files that are there, so treat a missing directory as an empty one
	if (!await fs.pathExists(directory)) {
		return files;
	}

	for await (const file of klaw(directory)) {

		if (file.stats.isFile() && extensions.includes(path.extname(file.path))) {
			files.push(file.path);
		}
	}

	return files;
}

/**
 * Returns recursive keys from given object
 *
 * @param {Object} obj 	object to get keys of
 * @returns {Array}
 */
export function getAllKeys (obj: Record<string, unknown>): string[] {
	if (typeof obj !== 'object') {
		return [];
	}
	const result = [];
	for (const [ key, value ] of Object.entries(obj)) {
		result.push(key);
		if (typeof value === 'object' && value !== null) {
			for (const val of getAllKeys(value as Record<string, unknown>)) {
				result.push(key + '.' + val);
			}
		}
	}
	return result;
}

/**
 * Convert to unix path
 *
 * @param {String} p 	path
 * @returns {String}
 */
export function toUnixPath (p: string): string { // https://github.com/anodynos/upath
	const double = /\/\//;
	p = p.replace(/\\/g, '/');
	while (p.match(double)) {
		p = p.replace(double, '/');
	}
	return p;
}

/**
 * Returns string with capitalized first letter
 *
 * @param {String} s - string.
 * @returns {String}
 */
export function  capitalizeFirstLetter (s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

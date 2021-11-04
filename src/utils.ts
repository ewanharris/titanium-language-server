import fs from 'fs-extra';
import path from 'path';
import xml2js from 'xml2js';
import { Project } from './project';
import { URI } from 'vscode-uri';
import { Position, Range } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
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
		parser.parseString(xmlString, (err: Error, result: T) => {
			if (!err) {
				return resolve(result);
			} else {
				return reject(err);
			}
		});
	});
}

export function getProject (filePath: string, projects: Map<string, Project>): Project|undefined {
	filePath = URI.parse(filePath).fsPath;
	let project;
	let parentDir = filePath;
	const { root } = path.parse(filePath);
	while (!project && parentDir !== root) {
		if (projects.has(parentDir) || projects.has(`${parentDir}/`)) {
			project = projects.get(parentDir) ?? projects.get(`${parentDir}/`);
		}
		parentDir = path.dirname(parentDir);
	}
	return project;
}

export async function filterFiles (directory: string, extensions: string[]): Promise<string[]> {
	const files: string[] = [];

	for await (const file of klaw(directory)) {

		if (extensions.includes(path.extname(file.path))) {
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

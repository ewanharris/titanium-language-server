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
	console.log(projects.keys());
	while (!project && parentDir !== root) {
		if (projects.has(parentDir) || projects.has(`${parentDir}/`)) {
			project = projects.get(parentDir) ?? projects.get(`${parentDir}/`);
		}
		parentDir = path.dirname(parentDir);
	}
	return project;
}

export function getWordRangeAtPosition (textDocument: TextDocument, position: Position, regexp: RegExp): Range|undefined {

	const lines = textDocument.getText().split(/\r?\n/);

	const wordAtText = getWordAtText(
		position.character + 1,
		regexp,
		lines[position.line],
		0
	);

	if (wordAtText) {
		return Range.create(position.line, wordAtText.startColumn - 1, position.line, wordAtText.endColumn - 1);
	}
	return undefined;
}

const _defaultConfig = {
	maxLen: 1000,
	windowSize: 15,
	timeBudget: 150
};

interface WordAtPosition {
	word: string,
	startColumn: number;
	endColumn: number;
}

function getWordAtText(column: number, wordDefinition: RegExp, text: string, textOffset: number, config = _defaultConfig): WordAtPosition | null {

	if (text.length > config.maxLen) {
		// don't throw strings that long at the regexp
		// but use a sub-string in which a word must occur
		let start = column - config.maxLen / 2;
		if (start < 0) {
			start = 0;
		} else {
			textOffset += start;
		}
		text = text.substring(start, column + config.maxLen / 2);
		return getWordAtText(column, wordDefinition, text, textOffset, config);
	}

	const t1 = Date.now();
	const pos = column - 1 - textOffset;

	let prevRegexIndex = -1;
	let match: RegExpMatchArray | null = null;

	for (let i = 1; ; i++) {
		// check time budget
		if (Date.now() - t1 >= config.timeBudget) {
			break;
		}

		// reset the index at which the regexp should start matching, also know where it
		// should stop so that subsequent search don't repeat previous searches
		const regexIndex = pos - config.windowSize * i;
		wordDefinition.lastIndex = Math.max(0, regexIndex);
		const thisMatch = _findRegexMatchEnclosingPosition(wordDefinition, text, pos, prevRegexIndex);

		if (!thisMatch && match) {
			// stop: we have something
			break;
		}

		match = thisMatch;

		// stop: searched at start
		if (regexIndex <= 0) {
			break;
		}
		prevRegexIndex = regexIndex;
	}

	if (match) {
		const result = {
			word: match[0],
			startColumn: textOffset + 1 + match.index!,
			endColumn: textOffset + 1 + match.index! + match[0].length
		};
		wordDefinition.lastIndex = 0;
		return result;
	}

	return null;
}

function _findRegexMatchEnclosingPosition(wordDefinition: RegExp, text: string, pos: number, stopPos: number): RegExpMatchArray | null {
	let match: RegExpMatchArray | null;
	while (match = wordDefinition.exec(text)) {
		const matchIndex = match.index || 0;
		if (matchIndex <= pos && wordDefinition.lastIndex >= pos) {
			return match;
		} else if (stopPos > 0 && matchIndex > stopPos) {
			return null;
		}
	}
	return null;
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

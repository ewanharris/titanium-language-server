import { Project, ProjectType } from '../project';
import * as vls from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CompletionsData, CompletionsFormat, loadCompletions } from 'titanium-editor-commons/completions';
import path from 'path';
import fs from 'fs-extra';
import { filterFiles, getAllKeys, parseXmlString, toUnixPath } from '../utils';
import klaw from 'klaw';
import { URI } from 'vscode-uri';

interface Definition {
	regExp: RegExp;
	files (project: Project, document: TextDocument, value: string): Promise<string[]>;
	projectType?: ProjectType;
}

interface Location extends Definition {
	definitionRegExp (text: string): RegExp;
}

interface CodeAction extends Definition {
	title (filename: string): string;
	insertText (text: string): string;
}

interface CompletionItemData {
	label: string;
	kind: vls.CompletionItemKind,
	deprecated?: boolean;
	insertText?: string;
	insertTextFormat?: vls.InsertTextFormat;
}

/**
 * The base class for all language providers to extend from
 *
 * @export
 * @abstract
 * @class Provider
 */
export abstract class Provider {

	public CompletionsFormat: CompletionsFormat;
	public completionsMap: Map<string, CompletionsData>;
	public connection: vls.Connection;
	/**
	 * The CodeActions to be used via the doCodeActions function
	 *
	 * @type {CodeAction[]}
	 * @memberof Provider
	 */
	public codeActions: CodeAction[] = [];
	/**
	 * The Definitions to be used via the doDefinition function
	 *
	 * @type {Definition[]}
	 * @memberof Provider
	 */
	public definitions: Definition[] = [];
	/**
	 * The Locations to be used via the doDefinition function
	 *
	 * @type {Definition[]}
	 * @memberof Provider
	 */
	public locations: Location[] = [];

	/**
	 * Creates an instance of Provider.
	 *
	 * @param {Connection} connection - The language server connection
	 * @memberof Provider
	 */
	constructor(connection: vls.Connection) {
		this.CompletionsFormat = CompletionsFormat.v3;
		this.completionsMap = new Map();
		this.connection = connection;
	}

	/**
	 * Loads the completions file for an version. This does not generate the completions file
	 * @param {string} sdk - The sdk version to generate for
	 * @returns {CompletionsData} - The completions data
	 */
	public async loadCompletions (sdk: string): Promise<CompletionsData> {
		let completions = this.completionsMap.get(sdk);
		if (completions) {
			return completions;
		}

		completions = await loadCompletions(sdk, this.CompletionsFormat);
		this.completionsMap.set(sdk, completions);
		return completions;
	}

	/**
	 * The function that will provide the completions for a request, this should be implemented by
	 * all language providers that will want to provide completions
	 *
	 * @abstract
	 * @param {CompletionParams} params - The parameters associated with the completion request
	 * @param {TextDocument} textDocument - The open file that is associated with the request
	 * @param {Project} project - The project instance that is associated with the request
	 * @returns {Promise<CompletionItem[]>}
	 * @memberof Provider
	 */
	abstract doCompletion (params: vls.CompletionParams, textDocument: TextDocument, project: Project): Promise<vls.CompletionItem[]|undefined>;

	/**
	 * Provides CodeActions based on the request. Each language that wants to provide these should
	 * implement a codeActions array with the relevant CodeAction objects
	 *
	 * @param {vls.DefinitionParams} params - The parameters for the request
	 * @param {TextDocument} textDocument - The textDocument for the request
	 * @param {Project} project - The Project instance that is associated with the request
	 * @returns {(Promise<vls.Command[]|undefined>)}
	 * @memberof Provider
	 */
	async doCodeAction (params: vls.CodeActionParams, textDocument: TextDocument, project: Project): Promise<vls.Command[]|undefined> {
		// TODO: handle i18n insertion
		const codeActions: vls.Command[] = [];
		const { range } = params;
		const linePrefix = textDocument.getText(vls.Range.create(range.end.line, 0, range.end.line, range.end.character));
		const line = textDocument.getText(vls.Range.create(range.start.line, 0, range.start.line, vls.uinteger.MAX_VALUE));

		const regExp = /['"\s]/g;
		let startIndex = 0;
		let endIndex = range.end.character;

		for (let matches = regExp.exec(line); matches !== null; matches = regExp.exec(line)) {
			if (matches.index < range.start.character) {
				startIndex = matches.index;
			} else if (matches.index > range.end.character) {
				endIndex = matches.index;
				break;
			}
		}

		const value = (startIndex !== undefined && endIndex !== undefined) ? linePrefix.substring(startIndex + 1, endIndex) : '';

		for (const codeAction of this.codeActions) {
			if (!codeAction.regExp.test(linePrefix)) {
				continue;
			}
			const suggestionFiles = await codeAction.files(project, textDocument, value);
			const index = suggestionFiles.indexOf(path.join(project.filePath, 'app', 'styles', 'app.tss'));
			if (index >= 0) {
				suggestionFiles.splice(index, 1);
			}

			const insertText = codeAction.insertText(value);
			for (const file of suggestionFiles) {
				codeActions.push({
					title: codeAction.title(path.basename(file)),
					command: 'titanium.insertCodeAction',
					arguments: [ insertText, file ]
				});
			}
		}
		return codeActions;
	}

	/**
	 * Provides Definition or DefinitionLinks based on the request. Each language that wants to
	 * provide these should implement a definitions array with the relevant Definition objects
	 * and/or a locations array with the relevant Location objects
	 *
	 * @param {vls.DefinitionParams} params - The parameters for the request
	 * @param {TextDocument} textDocument - The textDocument for the request
	 * @param {Project} project - The Project instance that is associated with the request
	 * @returns {(Promise<vls.Definition|vls.DefinitionLink[]|undefined>)}
	 * @memberof Provider
	 */
	async doDefinition (params: vls.DefinitionParams, textDocument: TextDocument, project: Project): Promise<vls.Definition|vls.DefinitionLink[]|undefined> {
		const { position } = params;

		const line = textDocument.getText(vls.Range.create(position.line, 0, position.line, vls.uinteger.MAX_VALUE));
		const linePrefix = textDocument.getText(vls.Range.create(position.line, 0, position.line, position.character));
		const projectType = await project.type();

		const regExp = /['"\s]/g;
		let startIndex = 0;
		let endIndex = position.character;

		for (let matches = regExp.exec(line); matches !== null; matches = regExp.exec(line)) {
			if (matches.index < position.character) {
				startIndex = matches.index;
			} else if (matches.index > position.character) {
				endIndex = matches.index;
				break;
			}
		}

		const value = (startIndex !== undefined && endIndex !== undefined) ? line.substring(startIndex + 1, endIndex) : '';

		const suggestions = [];

		for (const definition of this.definitions) {
			if (!definition.regExp.test(linePrefix)) {
				continue;
			}

			if (definition.projectType && definition.projectType !== projectType) {
				continue;
			}

			const files = await definition.files(project, textDocument, value);
			for (const file of files) {
				console.log(file);
				const link: vls.DefinitionLink = {
					originSelectionRange: vls.Range.create(position.line, startIndex, position.line, endIndex),
					targetRange: vls.Range.create(0, 0, 0, 0),
					targetUri: URI.file(file).fsPath,
					targetSelectionRange: vls.Range.create(0, 0, 0, 0),
				};
				suggestions.push(link);
			}
		}

		if (suggestions.length) {
			return suggestions;
		}

		for (const location of this.locations) {
			if (!location.regExp.test(linePrefix)) {
				continue;
			}
			const suggestionFiles = await location.files(project, textDocument, value);
			const definitionRegExp = location.definitionRegExp(value);
			return await this.getReferences<vls.Location>(suggestionFiles, definitionRegExp, (file: string, range: vls.Range) => {
				return vls.Location.create(URI.file(file).fsPath, range);
			});
		}
	}

	/**
	 * Provides Hover definitions for the languages, currently only handles displaying a preview of
	 * an image
	 *
	 * @param {vls.HoverParams} params - The parameters for the request
	 * @param {TextDocument} textDocument - The textDocument for the request
	 * @param {Project} project - The Project instance that is associated with the request
	 * @returns {(Promise<vls.Hover|undefined>)}
	 * @memberof Provider
	 */
	async doHover (params: vls.HoverParams, textDocument: TextDocument, project: Project): Promise<vls.Hover|undefined> {
		const { position } = params;

		const line = textDocument.getText(vls.Range.create(position.line, 0, position.line, vls.uinteger.MAX_VALUE));
		const linePrefix = textDocument.getText(vls.Range.create(position.line, 0, position.line, position.character));

		const regExp = /['"]/g;
		let startIndex = 0;
		let endIndex = position.character;

		for (let matches = regExp.exec(line); matches !== null; matches = regExp.exec(line)) {
			if (matches.index < position.character) {
				startIndex = matches.index;
			} else if (matches.index > position.character) {
				endIndex = matches.index;
				break;
			}
		}

		const value = (startIndex && endIndex) ? line.substring(startIndex + 1, endIndex) : null;

		if (!value || value.length === 0) {
			return;
		}

		if (/image\s*[=:]\s*["'][\s0-9a-zA-Z-_^./]*$/.test(linePrefix)) {
			const { name, ext } = path.parse(value);
			const dir = path.join(project.filePath, 'app', 'assets');
			// eslint-disable-next-line security/detect-non-literal-regexp
			const fileNameRegExp = new RegExp(`${name}.*${ext}$`);
			const files = (await filterFiles(dir, [ ext ])).filter(file => fileNameRegExp.test(file));
			let imageFile;
			let imageString = 'Image not found';
			if (files.length > 0) {
				imageFile = files[0];
				imageString = `![${imageFile}](${imageFile}|height=100)`;
			}

			return {
				contents: imageString
			};
		}
	}

	// Common completions methods and their RegExp's

	public alloyConfigCompletionsRegexp = /Alloy\.CFG\.([-a-zA-Z0-9-_/]*)[,]?$/;
	public async alloyConfigCompletions (project: Project): Promise<vls.CompletionItem[]> {
		const cfgPath = path.join(project.filePath, 'app', 'config.json');
		const completions: vls.CompletionItem[] = [];
		if (!await fs.pathExists(cfgPath)) {
			return completions;
		}
		const document = await fs.readFile(cfgPath, 'utf-8');
		const cfgObj = JSON.parse(document);
		const deconstructedConfig = {};

		for (const [ key, value ] of Object.entries(cfgObj)) {
			if (key === 'global' || key.startsWith('os:') || key.startsWith('env:')) {
				// Ignore and traverse
				Object.assign(deconstructedConfig, value);
			}
		}

		const allKeys = getAllKeys(deconstructedConfig);
		for (const key of allKeys) {
			completions.push({
				label: key,
				kind: vls.CompletionItemKind.Value
			});
		}
		return completions;
	}

	public i18nCompletionsRegex =  /(L\(|(?:hinttext|title|text)id\s*[:=]\s*)["'](\w*["']?)$/;
	public async i18nCompletions (project: Project): Promise<vls.CompletionItem[]> {
		// TODO: sync the config over from the extension?
		const defaultLang = 'en';
		const i18nPath = await project.i18nPath();
		const completions: vls.CompletionItem[] = [];
		if (!i18nPath || !await fs.pathExists(i18nPath)) {
			return completions;
		}

		const i18nStringPath = path.join(i18nPath, defaultLang, 'strings.xml');

		if (!await fs.pathExists(i18nStringPath)) {
			return completions;
		}

		const contents = await fs.readFile(i18nStringPath, 'utf-8');
		const result = await parseXmlString(contents) as { resources: { string: { $: { name: string }; _: string }[] } };
		if (result && result.resources && result.resources.string) {
			for (const value of result.resources.string) {
				completions.push({
					label: value.$.name,
					kind: vls.CompletionItemKind.Reference,
					detail: value._
				});
			}
		}
		return completions;
	}

	public imageCompletionsRegex = /image\s*[:=]\s*["']([\w\s\\/\-_():.]*)['"]?$/;
	public async imageCompletions (project: Project): Promise<vls.CompletionItem[]> {
		const rootPath = await project.type() === 'alloy' ? path.join(project.filePath, 'app', 'assets') : project.filePath;
		const completions: vls.CompletionItem[] = [];
		// limit search to these sub-directories
		const paths = [ 'images', 'iphone', 'android' ].map(subdir => path.join(rootPath, subdir));
		paths.push(rootPath);
		for (const imgPath of paths) {

			if (!await fs.pathExists(imgPath)) {
				continue;
			}
			const images: ImageAutoComplete[] = [];
			for await (const file of klaw(imgPath)) {

				if (!file.stats.isFile()) {
					continue;
				}

				let prefix: string|undefined;
				let scale: string|undefined;
				let suffix: string|undefined;
				// test whether image is includes scaling factor (for iOS)
				let matches = file.path.match(/(^[\w\s\\/\-_():]+)(@[\w~]+)(.\w+$)/);
				if (matches && matches.length === 4) {
					prefix = matches[1];
					scale = matches[2];
					suffix = matches[3];
				} else {
					matches = file.path.match(/(^[\w\s/\\\-_():]+)(.\w+$)/);
					if (matches && matches.length === 3) {
						prefix = matches[1];
						scale = '@1x';
						suffix = matches[2];
					}
				}

				if (prefix && suffix && scale) {
					const image = images.find(img => (img.prefix === prefix && img.suffix === suffix));
					if (image) {
						image.scales.push(scale);
					} else {
						images.push({
							prefix,
							suffix,
							file: file.path,
							scales: [ scale ]
						});
					}
				}
			}

			for (const image of images) {
				let scales;
				if (!(image.scales.length === 1 && image.scales[0] === '@1x')) {
					scales = image.scales.join(', ');
				}
				// TODO: Is it possible to preview the image like the atom plugin? We do this elsewhere right now
				completions.push({
					label: toUnixPath(`${image.prefix}${image.suffix}`.replace(rootPath, '')).replace(/^\/(iphone|android|windows)/, ''),
					kind: vls.CompletionItemKind.File,
					// range,
					detail: scales
				});
			}
		}
		return completions;
	}

	/**
	 * Returns matching definitions from given files
	 *
	 * @param {Array} files files to search
	 * @param {RegExp} regExp search pattern
	 * @param {Function} callback function to return item to add to definitions array
	 *
	 * @returns {Promise<Array>}
	*/
	public async getReferences<T> (files: string[]|string, regExp: RegExp, callback: (file: string, range: vls.Range) => T): Promise<T[]> {
		const definitions = [];
		if (!Array.isArray(files)) {
			files = [ files ];
		}
		for (const file of files) {
			if (!await fs.pathExists(file)) {
				continue;
			}

			const contents = await fs.readFile(file, 'utf-8');
			const document = TextDocument.create(file, 'unknown', 1, contents);
			const documentText = document.getText();
			if (documentText.length > 0) {
				let match;
				while (match = regExp.exec(documentText)) {
					const position = document.positionAt(match.index);
					definitions.push(callback(file, vls.Range.create(position.line, position.character, position.line, 0)));
				}
			}
		}
		return definitions;
	}

	createCompletionItem(data: CompletionItemData): vls.CompletionItem {
		const item: vls.CompletionItem = {
			label: data.label,
			kind: data.kind
		};

		if (data.deprecated) {
			item.tags = [ vls.CompletionItemTag.Deprecated ];
		}

		if (data.insertText) {
			item.insertText = data.insertText;
		}

		if (data.insertTextFormat) {
			item.insertTextFormat = data.insertTextFormat;
		}

		return item;
	}
}

interface ImageAutoComplete {
	prefix: string;
	suffix: string;
	file: string;
	scales: string[]
}

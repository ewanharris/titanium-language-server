import { Project, ProjectType } from '../../project';
import { CompletionParams, CompletionItem, Range, CompletionItemKind, InsertTextFormat } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Provider } from '..';
import { filterFiles } from '../../utils';
import path from 'path';
import fs from 'fs-extra';
import { getTargetPath } from '../../related';
import { URI } from 'vscode-uri';

export class JSProvider extends Provider {

	public definitions = [
		{ // require (/lib) name
			regExp: /require\(["']([-a-zA-Z0-9-_/]*)$/,
			async files (project: Project, document: TextDocument, value: string): Promise<string[]> {
				const projectType = await project.type();
				if (projectType === 'alloy') {
					return [ path.join(project.filePath, 'app', 'lib', `${value}.js`) ];
				} else {
					return [ path.join(project.filePath, 'Resources', `${value}.js`) ];
				}
			}
		},
		{ // ES6 import from (/lib) name
			regExp: /import\s*\(?(?:[{-\w-_/[\]*,\s}]*)?['"]?([-\w-_/]*)\)?/,
			async files (project: Project, document: TextDocument, value: string): Promise<string[]> {
				const projectType = await project.type();
				if (projectType === 'alloy') {
					return [ path.join(project.filePath, 'app', 'lib', `${value}.js`) ];
				} else {
					return [ path.join(project.filePath, 'Resources', `${value}.js`) ];
				}
			}
		},
		{ // controller name
			regExp: /Alloy\.createController\(["']([-a-zA-Z0-9-_/]*)$/,
			async files (project: Project, document: TextDocument, value: string): Promise<string[]> {
				return [ path.join(project.filePath, 'app', 'controllers', `${value}.js`) ];
			},
			projectType: 'alloy' as ProjectType
		},
		{ // collection / model name (instance)
			regExp: /Alloy\.(Collections|Models).instance\(["']([-a-zA-Z0-9-_/]*)$/,
			async files (project: Project, document: TextDocument, value: string): Promise<string[]> {
				return [ path.join(project.filePath, 'app', 'models', `${value}.js`) ];
			},
			projectType: 'alloy' as ProjectType
		},
		{ // collection / model name (create)
			regExp: /Alloy\.create(Collection|Model)\(["']([-a-zA-Z0-9-_/]*)$/,
			async files (project: Project, document: TextDocument, value: string): Promise<string[]> {
				return [ path.join(project.filePath, 'app', 'models', `${value}.js`) ];
			},
			projectType: 'alloy' as ProjectType
		},
		{ // widget name
			regExp: /Alloy\.createWidget\(["']([-a-zA-Z0-9-_/.]*)$/,
			async files (project: Project, document: TextDocument, value: string): Promise<string[]> {
				return [ path.join(project.filePath, 'app', 'widgets', value, 'controllers', 'widget.js') ];
			},
			projectType: 'alloy' as ProjectType
		},
		{ // controller name
			regExp: /Widget\.createController\(["']([-a-zA-Z0-9-_/]*)$/,
			async files (project: Project, document: TextDocument, value: string): Promise<string[]> {
				const dir = path.dirname(document.uri);
				return [ path.join(dir, `${value}.js`) ];
			},
			projectType: 'alloy' as ProjectType
		},
		{ // collection / model name (instance)
			regExp: /Widget\.(Collections|Models).instance\(["']([-a-zA-Z0-9-_/]*)$/,
			async files (project: Project, document: TextDocument, value: string): Promise<string[]> {
				const dir = path.dirname(document.uri);
				return [ path.resolve(dir, `../models/${value}.js`) ];
			},
			projectType: 'alloy' as ProjectType
		},
		{ // collection / model name (create)
			regExp: /Widget\.create(Collection|Model)\(["']([-a-zA-Z0-9-_/]*)$/,
			async files (project: Project, document: TextDocument, value: string): Promise<string[]> {
				const dir = path.dirname(document.uri);
				return [ path.resolve(dir, `../models/${value}.js`) ];
			},
			projectType: 'alloy' as ProjectType
		}
	]

	async doCompletion (params: CompletionParams, textDocument: TextDocument, project: Project): Promise<CompletionItem[]|undefined> {
		const linePrefix = textDocument.getText(Range.create(params.position.line, 0, params.position.line, params.position.character));
		const projectType = await project.type();

		if (/\s*(?:Ti|Titanium)\.?\S+/i.test(linePrefix)) {
			return this.titaniumApiCompletions(linePrefix, project);
		} else if (/(?:require\(["']?([^'");]*)["']?\)?$|import\s*\(?(?:[{-\w-_/[\]*,\s}]*)?['"]+([-\w-_/]*)\)?)/.test(linePrefix)) {
			const matches = linePrefix.match(/(?:require\(["']?([^'");]*)["']?\)?$|import\s*\(?(?:[{-\w-_/[\]*,\s}]*)?['"]+([-\w-_/]*)\)?)/);
			if (!matches) {
				return [];
			}
			const requestedModule = matches[1] ?? matches[2];
			if (requestedModule === undefined) {
				return [];
			}

			const folderName = projectType === 'alloy' ? 'app/lib' : 'Resources';

			return this.getFileCompletions(folderName, project, requestedModule);
		}

		// Don't continue on with any of the alloy specific suggestions
		if (projectType !== 'alloy') {
			return;
		}

		if (/\$\.([-a-zA-Z0-9-_]*)$/.test(linePrefix)) {
			return this.idCompletions(project, textDocument);
		} else if (/\$\.([-a-zA-Z0-9-_]*).([-a-zA-Z0-9-_]*)$/.test(linePrefix)) {
			return this.methodAndPropertyCompletions(linePrefix, textDocument, project);
		} else if (/Alloy\.(createController|Controllers\.instance)\(["']([-a-zA-Z0-9-_/]*["']?\)?)$/.test(linePrefix)) {
			return this.getFileCompletions('app/controllers', project);
		// Alloy.createModel('')
		} else if (/Alloy\.(createModel|Models\.instance|createCollection|Collections\.instance)\(["']([-a-zA-Z0-9-_/]*)$/.test(linePrefix)) {
			return this.getFileCompletions('app/models', project);
		// Alloy.createWidget('')
		} else if (/Alloy\.(createWidget|Widgets\.instance)\(["']([-a-zA-Z0-9-_/.]*)$/.test(linePrefix)) {
			return this.widgetCompletions(project);
		} else if (/(?:Alloy)\.?(?!.*CFG)\S+/.test(linePrefix)) {
			return this.alloyApiCompletions(linePrefix, project);
		} else if (this.alloyConfigCompletionsRegexp.test(linePrefix)) {
			return this.alloyConfigCompletions(project);
		} else if (this.i18nCompletionsRegex.test(linePrefix)) {
			return this.i18nCompletions(project);
		} else if (this.imageCompletionsRegex.test(linePrefix)) {
			return this.imageCompletions(project);
		} else if (/\$\.([-a-zA-Z0-9-_]*)\.(add|remove)EventListener\(["']([-a-zA-Z0-9-_/]*)$/.test(linePrefix)) {
			return this.getEventNameCompletions(linePrefix, project, textDocument);
		}
	}

	/**
	 * Provides id completions for $.<text>
	 *
	 * @private
	 * @param {Project} project - The associated project
	 * @param {TextDocument} textDocument - The associated textDocument
	 * @returns {Promise<CompletionItem[]>}
	 * @memberof JSProvider
	 */
	private async idCompletions(project: Project, textDocument: TextDocument): Promise<CompletionItem[]> {
		const completions: CompletionItem[] = [];
		const filename = URI.parse(textDocument.uri);
		const relatedFile = await getTargetPath(project, 'xml', filename.fsPath);
		if (!relatedFile) {
			return completions;
		}
		const fileName = relatedFile.split('/').pop();

		const document = await fs.readFile(relatedFile, 'utf-8');
		const regex = /id="(.+?)"/g;
		const ids: string[] = [];
		for (let matches = regex.exec(document); matches !== null; matches = regex.exec(document)) {
			const id = matches[1];
			if (!ids.includes(id)) {
				completions.push({
					label: id,
					kind: CompletionItemKind.Reference,
					detail: fileName
				});
				ids.push(id);
			}
		}
		return completions;
	}

	/**
	 * Provides completions for the general Titanium namespace
	 *
	 * @private
	 * @param {string} linePrefix - The text between the cursor and the start of the line
	 * @param {Project} project - The associated project
	 * @returns {Promise<CompletionItem[]>}
	 * @memberof JSProvider
	 */
	private async titaniumApiCompletions (linePrefix: string, project: Project): Promise<CompletionItem[]> {
		const completionsData = await this.loadCompletions(project.sdkVersion());
		const { types } = completionsData.titanium;
		const completions: CompletionItem[] = [];
		let apiName: string|undefined;
		let attribute: string|undefined;

		const parts = linePrefix.split('.').filter(part => part.length);
		const last = parts.pop();

		// Check if the part we're completing is namespace (e.g.. Ti.Ap -> Ti.API or Ti.App) or a property/function on a namespace (e.g Ti.API.lo -> Ti.API.log)
		if (last && /^(?:[a-z]\w+)|(?:[A-Z]+_)+/.test(last)) {
			apiName = parts.join('.');
			attribute = last;
		} else {
			apiName = [ ...parts, last ].join('.');
		}

		// suggest class completion
		if (!attribute || attribute.length === 0) {
			for (const key of Object.keys(types)) {
				if (key.indexOf(apiName) === 0 && key.indexOf('_') === -1) {
					const replaceSections = key.split('.');
					completions.push({
						label: key,
						kind: CompletionItemKind.Class,
						insertText: replaceSections[replaceSections.length - 1]
					});
				}
			}
		}

		// if type exists suggest function and properties
		const apiObj = types[apiName];
		if (apiObj) {
			for (const func of apiObj.functions) {
				if ((!attribute || func.toLowerCase().includes(attribute.toLowerCase()))) {
					completions.push(this.createCompletionItem({
						label: func.replace('|deprecated', ''),
						kind: CompletionItemKind.Method,
						deprecated: func.includes('|deprecated')
					}));
				}
			}
			for (const property of apiObj.properties) {
				if ((!attribute || property.toLowerCase().includes(attribute.toLowerCase()))) {
					completions.push(this.createCompletionItem({
						label: property.replace('|deprecated', ''),
						kind: CompletionItemKind.Property,
						deprecated: property.includes('|deprecated')
					}));
				}
			}
		}
		return completions;
	}

	/**
	 * Generates completions based on a file directory, used for require/import and Alloy.create*
	 *
	 * @private
	 * @param {string} directory - The directory to read from
	 * @param {Project} project - The associated project
	 * @param {string} [moduleName] - The name of the module
	 * @returns {Promise<CompletionItem[]>}
	 * @memberof JSProvider
	 */
	private async getFileCompletions(directory: string, project: Project, moduleName?: string): Promise<CompletionItem[]> {
		const completions: CompletionItem[] = [];
		const filesPath = path.join(project.filePath, directory);

		if (!await fs.pathExists(filesPath)) {
			return completions;
		}

		const files = await filterFiles(filesPath, [ '.js', '.ts' ]);

		for (const file of files) {
			const relativePath = path.relative(filesPath, file);
			const value = `/${path.posix.format(path.parse(relativePath)).replace(path.extname(relativePath), '')}`;
			completions.push({
				label: value,
				kind: CompletionItemKind.Reference,
				insertText: moduleName?.startsWith('/') ? value.replace('/', '') : value
			});
		}
		return completions;
	}

	/**
	 * Generates completions for an event name.
	 *
	 * @param {string} linePrefix - The text between the cursor and start of the line.
	 * @param {Project} project - The associated project instance.
	 * @param {TextDocument} textDocument - The associated TextDocument.
	 * @returns {Promise<CompletionItem[]>}
	 */
	public async getEventNameCompletions (linePrefix: string, project: Project, textDocument: TextDocument): Promise<CompletionItem[]> {
		const { alloy, titanium } = await this.loadCompletions(project.sdkVersion());
		const { tags } = alloy;
		const { types } = titanium;
		const matches = /\$\.([-a-zA-Z0-9-_]*)\.(add|remove)EventListener\(["']([-a-zA-Z0-9-_/]*)$/.exec(linePrefix);
		const completions: CompletionItem[] = [];

		if (!matches) {
			return completions;
		}
		const id = matches[1];
		const filename = URI.parse(textDocument.uri);
		const relatedFile = await getTargetPath(project, 'xml', filename.fsPath);
		if (!relatedFile) {
			return completions;
		}
		const contents = await fs.readFile(relatedFile, 'utf8');
		const document = TextDocument.create(URI.parse(relatedFile).fsPath, 'xml', 1, contents);
		let tagName;
		// eslint-disable-next-line security/detect-non-literal-regexp
		const regex = new RegExp(`id=["']${id}["']`, 'g');
		const ids = regex.exec(document.getText());
		if (ids) {
			const position = document.positionAt(ids.index);
			const closestId = document.getText(Range.create(position.line, 0, position.line, position.character)).match(/<([a-zA-Z][-a-zA-Z]*)(?:\s|$)/);
			if (closestId) {
				tagName = closestId[1];
			}
		}

		if (tagName && tags[tagName]) {
			const { apiName } = tags[tagName];
			const tagObj = types[apiName];
			for (const event of tagObj.events) {
				completions.push({
					label: event,
					kind: CompletionItemKind.Event,
					detail: apiName
				});
			}
		}
		return completions;
	}

	public async methodAndPropertyCompletions (linePrefix: string, textDocument: TextDocument, project: Project): Promise<CompletionItem[]> {
		const { alloy, titanium } = await this.loadCompletions(project.sdkVersion());
		const { tags } = alloy;
		const { types } = titanium;

		const matches = linePrefix.match(/\$\.([-a-zA-Z0-9-_]*)\.?$/);

		if (!matches) {
			return [];
		}

		const id = matches[1];

		const completions: CompletionItem[] = [];
		const filename = URI.parse(textDocument.uri);
		const relatedFile = await getTargetPath(project, 'xml', filename.fsPath);

		if (!relatedFile) {
			return completions;
		}

		const contents = await fs.readFile(relatedFile, 'utf-8');
		const document = TextDocument.create(relatedFile, 'xml', 1, contents);
		let tagName;
		// eslint-disable-next-line security/detect-non-literal-regexp
		const regex = new RegExp(`id=["']${id}["']`, 'g');
		const ids = regex.exec(document.getText());
		if (ids) {
			const position = document.positionAt(ids.index);
			const closestId = document.getText(Range.create(position.line, 0, position.line, position.character)).match(/<([a-zA-Z][-a-zA-Z]*)(?:\s|$)/);
			if (closestId) {
				tagName = closestId[1];
			}
		}

		if (tagName && tags[tagName]) {
			const { apiName } = tags[tagName];
			const tagObj = types[apiName];
			if (tagObj) {
				for (const value of tagObj.functions) {
					completions.push({
						label: value,
						kind: CompletionItemKind.Method,
						insertText: `${value}($1)$0`,
						insertTextFormat: InsertTextFormat.Snippet
					});
				}

				for (const value of tagObj.properties) {
					completions.push({
						label: value,
						kind: CompletionItemKind.Property,
						insertText: `${value} = $1$0`,
						insertTextFormat: InsertTextFormat.Snippet
					});
				}
			}
		}
		return completions;
	}

	private async widgetCompletions (project: Project): Promise<CompletionItem[]> {
		const completions = [];
		const alloyConfigPath = path.join(project.filePath, 'app', 'config.json');
		const configContents = await fs.readFile(alloyConfigPath, 'utf-8');
		const configObj = JSON.parse(configContents);
		const dependencies = configObj.dependencies || {};
		for (const widgetName of Object.keys(dependencies)) {
			completions.push({
				label: widgetName,
				kind: CompletionItemKind.Reference
			});
		}
		return completions;
	}

	private async alloyApiCompletions(linePrefix: string, project: Project): Promise<CompletionItem[]> {
		const { alloy } = await this.loadCompletions(project.sdkVersion());
		const { types } = alloy;
		const matches = linePrefix.match(/(Alloy\.(?:(?:[A-Z]\w*)\.?)*)([a-z]\w*)*$/);
		const completions: CompletionItem[] = [];

		let apiName: string|undefined;
		let attribute: string|undefined;
		if (matches && matches.length === 3) {
			apiName = matches[1];
			if (apiName.lastIndexOf('.') === apiName.length - 1) {
				apiName = apiName.substr(0, apiName.length - 1);
			}
			attribute = matches[2];
		}

		if (!apiName) {
			return completions;
		}

		// suggest class completion
		if (!attribute || attribute.length === 0) {
			for (const key of Object.keys(types)) {
				if (key.indexOf(apiName) === 0 && key.indexOf('_') === -1) {
					const replaceSections = key.split('.');
					completions.push({
						label: key,
						kind: CompletionItemKind.Interface,
						insertText: replaceSections[replaceSections.length - 1]
					});
				}
			}
		}

		// if type exists suggest function and properties
		const apiObj = types[apiName];
		if (apiObj) {
			for (const func of apiObj.functions) {
				if ((!attribute || func.toLowerCase().includes(attribute.toLowerCase()))) {
					completions.push(this.createCompletionItem({
						label: func.replace('|deprecated', ''),
						kind: CompletionItemKind.Method,
						deprecated: func.includes('|deprecated')
					}));
				}
			}
			for (const property of apiObj.properties) {
				if ((!attribute || property.toLowerCase().includes(attribute.toLowerCase()))) {
					completions.push(this.createCompletionItem({
						label: property.replace('|deprecated', ''),
						kind: CompletionItemKind.Interface,
						deprecated: property.includes('|deprecated')
					}));
				}
			}
		}

		return completions;
	}
}

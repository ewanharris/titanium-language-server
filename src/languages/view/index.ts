import { Project } from '../../project';
import { CompletionItem, CompletionItemKind, CompletionParams, InsertTextFormat, Position, Range, uinteger } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Provider } from '..';
import { capitalizeFirstLetter, toUnixPath } from '../../utils';
import path from 'path';
import fs from 'fs-extra';
import { getTargetPath } from '../../related';

async function getRelatedFiles(project: Project, fileType: string, textDocument: TextDocument): Promise<string[]> {
	const relatedFiles: string[] = [];
	if (fileType === 'tss') {
		relatedFiles.push(path.join(project.filePath, 'app', 'styles', 'app.tss'));
	}
	const relatedFile = await getTargetPath(project, fileType, textDocument.uri);
	if (relatedFile) {
		relatedFiles.push(relatedFile);
	}
	return relatedFiles;
}

export class XMLProvider extends Provider {

	classRegExp = /class=["'][\s0-9a-zA-Z-_^]*$/;
	handlerRegExp = /on(.*?)=["'][A-Za-z]*$/;
	i18nRegExp = /[:\s=,>)("]L\(["'][\w0-9_-]*/;
	idRegExp = /id=["'][\s0-9a-zA-Z-_^]*$/;
	tagRegExp = /<[A-Z][A-Za-z]*$/;

	public codeActions = [
		{
			regExp: this.classRegExp,
			title: (fileName: string): string => `Generate style for class (${fileName})`,
			insertText: (text: string): string => `\n".${text}": {\n}\n`,
			async files (project: Project, textDocument: TextDocument): Promise<string[]> {
				return getRelatedFiles(project, 'tss', textDocument);
			}
		},
		{
			regExp: this.idRegExp,
			title: (fileName: string): string => `Generate style for id (${fileName})`,
			insertText: (text: string): string => `\n"#${text}": {\n}\n`,
			async files (project: Project, textDocument: TextDocument): Promise<string[]> {
				return getRelatedFiles(project, 'tss', textDocument);
			}
		}
	];

	public definitions = [
		{ // widget
			regExp: /<Widget[\s0-9a-zA-Z-_^='"]*src=["']/,
			async files (project: Project, document: TextDocument, text: string): Promise<string[]> {
				return [ path.join(project.filePath, 'app', 'widgets', text, 'controllers', 'widget.js') ];
			}
		},
		{ // require
			regExp: /<Require[\s0-9a-zA-Z-_^='"]*src=["']/,
			async files (project: Project, document: TextDocument, text: string): Promise<string[]> {
				return [ path.join(project.filePath, 'app', 'controllers', `${text}.js`) ];
			}
		},
		{ // custom tags
			regExp: /<\w+[\s0-9a-zA-Z-_^='"]*module=["']/,
			async files (project: Project, document: TextDocument, text: string): Promise<string[]> {
				return [ path.join(project.filePath, 'app', 'lib', `${text}.js`) ];
			}
		}
	];

	public locations = [
		{ // class
			regExp: this.classRegExp,
			async files (project: Project, textDocument: TextDocument): Promise<string[]> {
				return getRelatedFiles(project, 'tss', textDocument);
			},
			definitionRegExp (text: string): RegExp {
				// eslint-disable-next-line security/detect-non-literal-regexp
				return new RegExp(`["']\\.${text}["'[]`, 'g');
			}
		},
		{ // id
			regExp:	this.idRegExp,
			async files (project: Project, textDocument: TextDocument): Promise<string[]> {
				return getRelatedFiles(project, 'tss', textDocument);
			},
			definitionRegExp (text: string): RegExp {
				// eslint-disable-next-line security/detect-non-literal-regexp
				return new RegExp(`["']#${text}["'[]`, 'g');
			},
		},
		{ // tag
			regExp: this.tagRegExp,
			async files (project: Project, textDocument: TextDocument): Promise<string[]> {
				return getRelatedFiles(project, 'tss', textDocument);
			},
			definitionRegExp (text: string): RegExp {
				// eslint-disable-next-line security/detect-non-literal-regexp
				return new RegExp(`["']${text}`, 'g');
			}
		},
		{ // handler
			regExp: this.handlerRegExp,
			async files (project: Project, textDocument: TextDocument): Promise<string[]> {
				return getRelatedFiles(project, 'js', textDocument);
			},
			definitionRegExp (text: string): RegExp {
				// eslint-disable-next-line security/detect-non-literal-regexp
				return new RegExp(`(?:function ${text}\\s*?\\(|(?:var|let|const)\\s*?${text}\\s*?=\\s*?\\()`);
			}
		},
		{ // i18n
			regExp: this.i18nRegExp,
			definitionRegExp(text: string): RegExp {
				// Strip the brackets if they're included
				if (text.includes('(')) {
					const matches = /\(["'](\S+)["']\)/.exec(text);
					text = matches?.[1] as string;

				}
				// eslint-disable-next-line security/detect-non-literal-regexp
				return new RegExp(`name=["']${text}["']>.*</`, 'g');
			},
			async files(project: Project): Promise<string[]> {
				const i18nPath = await project.i18nPath();
				if (!i18nPath) {
					return [];
				}
				return [ path.join(i18nPath, 'en', 'strings.xml') ];
			}
		}
	];

	async doCompletion (params: CompletionParams, textDocument: TextDocument, project: Project): Promise<CompletionItem[]|undefined> {
		if (await project.type() !== 'alloy') {
			return;
		}

		const { position } = params;

		const linePrefix = textDocument.getText(Range.create(position.line, 0, position.line, position.character));
		const line = textDocument.getText(Range.create(position.line, 0, position.line, uinteger.MAX_VALUE));

		if (/^\s*<\/?\w*$/.test(linePrefix)) {
			return this.tagNameCompletions(line, linePrefix, position, project);
			// attribute <View _ or <View backg_
		} else if (/^\s*<\w+[\s+\w*="()']*\s+\w*[/]?[>]?$/.test(linePrefix)) {
			return this.attributeNameCompletions(linePrefix, project);
			// attribute value <View backgroundColor="_"
		} else if (/^\s*<\w+\s+([\s+\w*="()']*\w*="[\w('./]*"?)*[/]?[>]?$/.test(linePrefix)) {
			const completions: CompletionItem[] = [];

			// Try the specific value look ups first, then fallback to general property lookup
			if (this.alloyConfigCompletionsRegexp.test(linePrefix)) {
				completions.push(...await this.alloyConfigCompletions(project));
			} else if (this.i18nCompletionsRegex.test(linePrefix)) {
				completions.push(...await this.i18nCompletions(project));
			} else if (this.imageCompletionsRegex.test(linePrefix)) {
				completions.push(...await this.imageCompletions(project));
			}

			if (!completions.length) {
				completions.push(...await this.attributeValueCompletions(linePrefix, project, textDocument, position));
			}

			return completions;
		}
	}

	async tagNameCompletions(line: string, linePrefix: string, position: Position, project: Project): Promise<CompletionItem[]> {
		const { alloy } = await this.loadCompletions(project.sdkVersion());
		const { tags } = alloy;
		const completions: CompletionItem[] = [];

		const prefix = linePrefix.match(/<\/?(\w+)>?/)?.[1];
		// eslint-disable-next-line security/detect-non-literal-regexp
		const isClosing = new RegExp(`</${prefix || ''}`).test(linePrefix);
		// eslint-disable-next-line security/detect-non-literal-regexp
		const useSnippet = new RegExp(`^\\s*</?${prefix || ''}\\s*>?\\s*$`).test(line);

		for (const tag in tags) {
			if (!prefix || tag.toLowerCase().includes(prefix.toLowerCase())) {
				const completionItem: CompletionItem = {
					label: tag,
					kind: CompletionItemKind.Class,
					detail: tags[tag].apiName
				};
				if (useSnippet) {
					completionItem.insertText = isClosing ? `${tag}>` : `${tag}$1>$2</${tag}>`;
					completionItem.insertTextFormat = InsertTextFormat.Snippet;
				}
				completions.push(completionItem);
			}
		}
		return completions;
	}

	async attributeNameCompletions(linePrefix: string, project: Project): Promise<CompletionItem[]> {
		const { alloy, titanium } = await this.loadCompletions(project.sdkVersion());
		const { tags } = alloy;
		const { types } = titanium;
		const completions: CompletionItem[] = [];
		let tagName: string|undefined;
		const matches = linePrefix.match(/<([a-zA-Z][-a-zA-Z]*)(?:\s|$)/);
		if (matches) {
			tagName = matches[1];
		}

		if (!tagName) {
			return completions;
		}

		const attributes: string[] = linePrefix.match((/\s+([a-zA-Z]*)\s*=?\s*/g)) || [];
		const completingAttribute = attributes[attributes.length - 1]?.trim();

		const tagAttributes = [ 'id', 'class', 'platform', 'bindId', ...await this.getTagAttributes(tagName, project) ];
		let apiName = tagName;
		if (tags[tagName] && tags[tagName].apiName) {
			apiName = tags[tagName].apiName;
		}
		let events: string[] = [];
		if (types[apiName]) {
			events = types[apiName].events;
		}

		//
		// Class properties
		//
		for (const attribute of tagAttributes) {
			if (attributes.includes(attribute)) {
				continue;
			}

			if (!completingAttribute || attribute.toLowerCase().includes(completingAttribute.toLowerCase())) {
				completions.push({
					label: attribute,
					insertText: `${attribute}="$1"$0`,
					insertTextFormat: InsertTextFormat.Snippet,
					kind: CompletionItemKind.Property
				});
			}
		}

		//
		// Event names - matches 'on' + event name
		//
		for (const event of events) {
			const attribute = `on${capitalizeFirstLetter(event)}`;

			if (attributes.includes(attribute)) {
				continue;
			}

			if (!completingAttribute || attribute.toLowerCase().includes(completingAttribute.toLowerCase())) {
				completions.push({
					label: attribute,
					kind: CompletionItemKind.Event,
					insertText: `${attribute}="$1"$0`,
					insertTextFormat: InsertTextFormat.Snippet,
				});
			}
		}

		return completions;
	}

	private async attributeValueCompletions(linePrefix: string, project: Project, document: TextDocument, position: Position) {
		let values;
		let tag;
		const matches = linePrefix.match(/<([a-zA-Z][-a-zA-Z]*)(?:\s|$)/);
		if (matches) {
			tag = matches[1];
		}
		const attribute = this.getPreviousAttribute(linePrefix, position);
		const completions: CompletionItem[] = [];

		//
		// Related and global TSS
		//
		if (attribute === 'id' || attribute === 'class') {
			const relatedFile = await getTargetPath(project, 'tss', document.uri);
			const appTss = path.join(project.filePath, 'app', 'styles', 'app.tss');

			const files = [];
			// FIXME: This function should be refactored, it's weird that it mutates the completions array
			async function getCompletions (file: string): Promise<void> {
				const doc = await fs.readFile(file, 'utf-8');
				if (doc.length) {
					let regex = /["'](#)([a-z0-9_]+)[[\]=a-z0-9_]*["']\s*:\s*{/ig;
					if (attribute === 'class') {
						regex = /["'](\.)([a-z0-9_]+)[[\]=a-z0-9_]*["']\s*:\s*{/ig;
					}
					values = [];
					for (let mtchs = regex.exec(doc); mtchs !== null; mtchs = regex.exec(doc)) {
						values.push(mtchs[2]);
					}
					const fileName = path.parse(file).name;
					for (const value of values) {
						// if (!prefix || utils.matches(value, prefix)) {
						completions.push({
							label: value,
							kind: CompletionItemKind.Reference,
							detail: fileName
						});
						// }
					}
				}
			}

			for (const file of [ relatedFile, appTss ]) {
				if (!file) {
					continue;
				}
				files.push(getCompletions(file));
			}

			await Promise.all(files);
			return completions;

		} else if (attribute === 'src') {

			//
			// Require src attribute
			//
			if (tag === 'Require') {
				const relatedControllerFile = await getTargetPath(project, 'js', document.uri);
				const controllerPath = path.join(project.filePath, 'app', 'controllers');
				for (const file of await project.controllers()) {
					if (relatedControllerFile === file) {
						continue;
					}
					const value = toUnixPath(file.replace(controllerPath, '').split('.')[0]);
					completions.push({
						label: value,
						kind: CompletionItemKind.Reference
					});
				}
				return completions;
			//
			// Widget src attribute
			//
			} else if (tag === 'Widget') {
				const alloyConfigPath = path.join(project.filePath, 'app', 'config.json');
				const doc = await fs.readFile(alloyConfigPath, 'utf-8');
				const configObj = JSON.parse(doc);
				for (const widgetName of Object.keys(configObj.dependencies)) {
					completions.push({
						label: widgetName,
						kind: CompletionItemKind.Reference
					});
				}
				return completions;
			}
		} else if (attribute === 'module') {
			const createFunction = `create${tag}`;
			const libDirectory = path.join(project.filePath, 'app', 'lib');

			for (const file of await project.libFiles()) {
				const document = await fs.readFile(file, 'utf-8');
				if (document.includes(createFunction)) {
					const value = toUnixPath(file.replace(libDirectory, '').split('.')[0]);
					completions.push({
						label: value,
						kind: CompletionItemKind.Reference,
						detail: path.basename(file)
					});
				}
			}
		}

		//
		// Attribute values for prefix
		//
		if (completions.length === 0 && attribute) {
			values = await this.getAttributeValues(attribute, project);
			for (let value of values) {
				value = value.replace(/["']/g, '');
				// if (!prefix || utils.matches(value, prefix)) {
				completions.push({
					label: value,
					kind: CompletionItemKind.Value
				});
				// }
			}
		}

		return completions;
	}

	/**
	 * Get tag attributes
	 *
	 * @param {String} tag tag name
	 * @param {Project} project - The Titanium project instance

	 * @returns {Array}
	 */
	public async getTagAttributes (tag: string, project: Project): Promise<string[]> {
		const { alloy, titanium } = await this.loadCompletions(project.sdkVersion());
		const { tags } = alloy;
		const { types } = titanium;
		const apiName = tags[tag]?.apiName;
		const type = types[apiName];
		if (type) {
			return type.properties;
		}
		return [];
	}

	/**
	 * Get previous attribute
	 *
	 * @param {String} linePrefix line prefix text
	 * @param {Position} position caret position
	 *
	 * @returns {String}
	 */
	public getPreviousAttribute (linePrefix: string, position: Position): string|undefined {
		// Remove everything until the opening quote
		let quoteIndex = position.character - 1;
		while (linePrefix[quoteIndex] && !([ '"', '\'' ].includes(linePrefix[quoteIndex]))) {
			quoteIndex--;
		}
		linePrefix = linePrefix.substring(0, quoteIndex);
		const matches = [ ...linePrefix.matchAll(/\s+([a-zA-Z]*)\s*=\s*/g) ];
		if (matches.length) {
			const last = matches.length - 1;
			return matches[last][1];
		}
	}

	/**
	 * Get attribute values
	 *
	 * @param {String} attributeName attribute name
	 *@param {Project} project - The Titanium project instance

	 * @returns {Array}
	 */
	public async getAttributeValues (attributeName: string, project: Project): Promise<string[]> {
		const { titanium } = await this.loadCompletions(project.sdkVersion());
		const { properties } = titanium;
		const attribute = properties[attributeName];
		if (attribute) {
			return attribute.values;
		}
		return [];
	}
}

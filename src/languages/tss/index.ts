import { Project } from '../../project';
import { CompletionParams, CompletionItem, Range, CompletionItemKind, InsertTextFormat, Position, uinteger } from 'vscode-languageserver/node';
import { Tag } from 'titanium-editor-commons/completions';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { Provider } from '..';
import { getTargetPath } from '../../related';
import fs from 'fs-extra';
import path from 'path';

export class TSSProvider extends Provider {

	public locations = [
		{ // id
			regExp: /["']#[A-Za-z0-9_=[\]]+/,
			definitionRegExp (text: string): RegExp {
				// eslint-disable-next-line security/detect-non-literal-regexp
				return new RegExp(`id=["']${text.replace('#', '')}`, 'g');
			},
			async files (project: Project, document: TextDocument): Promise<string[]> {
				const relatedFile = await getTargetPath(project, 'xml', document.uri);
				if (relatedFile) {
					return [ relatedFile ];
				}
				return [ ];
			}
		},
		{ // class
			regExp: /["']\.[A-Za-z0-9_=[\]]+/,
			definitionRegExp (text: string): RegExp {
				// eslint-disable-next-line security/detect-non-literal-regexp
				return new RegExp(`class=["']${text.replace('.', '')}`, 'g');
			},
			async files (project: Project, document: TextDocument): Promise<string[]> {
				const relatedFile = await getTargetPath(project, 'xml', document.uri);
				if (relatedFile) {
					return [ relatedFile ];
				}
				return [ ];
			}
		}
	];

	async doCompletion (params: CompletionParams, textDocument: TextDocument, project: Project): Promise<CompletionItem[]|undefined> {
		const projectType = await project.type();
		const { position } = params;

		if (projectType !== 'alloy') {
			return;
		}

		const linePrefix = textDocument.getText(Range.create(position.line, 0, position.line, position.character));
		if (/\s*\w+\s*:\s*\w*[(]?["'.]?\w*["'.]?[,]?$/.test(linePrefix)) {
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
				completions.push(...await this.propertyValueCompletions(linePrefix, project));
			}

			return completions;

		} else if (/^\s*\w*$/.test(linePrefix)) {
			return this.propertyNameCompletions(linePrefix, position, textDocument, project);
			// class or id - ".foo_ or "#foo
		} else if (/^\s*['"][.#]\w*?["']?$/.test(linePrefix)) {
			return this.classOrIdCompletions(linePrefix, textDocument, project);
			// tag - "Wind_ or "_
		} else if (/^\s*['"]\w*["']?$/.test(linePrefix)) {
			return this.tagCompletions(linePrefix, project);
		}
	}

	/**
	 * Returns completions for when declaring an style for an Alloy tag
	 *
	 * @private
	 * @param {string} linePrefix - The content between the cursor and the start of the line
	 * @param {Project} project - The associated project
	 * @returns {(Promise<CompletionItem[]|undefined>)}
	 * @memberof TSSProvider
	 */
	private async tagCompletions(linePrefix: string, project: Project): Promise<CompletionItem[]> {
		const { alloy } = await this.loadCompletions(project.sdkVersion());
		const completions: CompletionItem[] = [];
		const [ , quote, prefix ] =  /(['"])(\w*)['"]?$/.exec(linePrefix) || [];
		for (const [ key, value ] of Object.entries(alloy.tags) as [ string, Tag ][]) {
			if (!prefix || key.toLowerCase().includes(prefix.toLowerCase())) {
				completions.push({
					label: key,
					kind: CompletionItemKind.Class,
					detail: value.apiName,
					insertText: `${key}${quote}: {\n\t\${1}\t\n}`,
					insertTextFormat: InsertTextFormat.Snippet
				});
			}
		}
		return completions;
	}

	/**
	 * Returns completions for when declaring a style for Alloy class or id's
	 *
	 * @private
	 * @param {string} linePrefix - The content between the cursor and the start of the line
	 * @param {TextDocument} textDocument - The associated textDocument
	 * @param {Project} project - The associated project
	 * @returns {Promise<CompletionItem[]>}
	 * @memberof TSSProvider
	 */
	private async classOrIdCompletions(linePrefix: string, textDocument: TextDocument, project: Project): Promise<CompletionItem[]> {
		const completions: CompletionItem[] = [];
		const values: string[] = [];
		const relatedFile = await getTargetPath(project, 'xml', textDocument.uri);
		if (!relatedFile) {
			return completions;
		}
		const fileName = path.basename(relatedFile);
		const quote = /'/.test(linePrefix) ? '\'' : '"';
		const file = await fs.readFile(relatedFile, 'utf-8');
		// '.foo' is a class selector and '#foo' is an id selector, so look up the matching
		// attribute in the related view
		let regex = /class="(.*?)"/g;
		if (/^\s*['"]#\w*["']?$/.test(linePrefix)) {
			regex = /id="(.*?)"/g;
		}

		const prefix = /(\w+)/.exec(linePrefix)?.[0] ?? undefined;
		for (let matches = regex.exec(file); matches !== null; matches = regex.exec(file)) {
			for (const value of matches[1].split(' ')) {
				if (value && value.length > 0 && !values.includes(value) && (!prefix || value.toLowerCase().includes(prefix.toLowerCase()))) {
					completions.push({
						label: value,
						kind: CompletionItemKind.Reference,
						detail: `${fileName}`,
						insertText: `${value}${quote}: {\n\t\${1}\t\n}`,
						insertTextFormat: InsertTextFormat.Snippet
					});
					values.push(value);
				}
			}
		}
		return completions;
	}

	/**
	 * Returns the property values when writing tss styles
	 *
	 * @private
	 * @param {string} linePrefix - The content between the cursor and the start of the line
	 * @param {Project} project - The associated project
	 * @returns {Promise<CompletionItem[]>}
	 * @memberof TSSProvider
	 */
	private async propertyValueCompletions (linePrefix: string, project: Project): Promise<CompletionItem[]> {
		const { titanium } = await this.loadCompletions(project.sdkVersion());
		const prefix = linePrefix.split(':')[1].trim();

		const { properties } = titanium;

		const completions: CompletionItem[] = [];

		let property;
		const matches = /^\s*(\S+)\s*:/.exec(linePrefix);
		if (matches && matches.length >= 2) {
			property = matches[1];
		}

		if (!property || !properties[property]) {
			return completions;
		}

		const { values } = properties[property];
		if (!values) {
			return completions;
		}

		for (const value of values) {
			if (!prefix || value.toLowerCase().includes(prefix.toLowerCase())) {
				completions.push({
					label: value,
					// range,
					kind: CompletionItemKind.Value
				});
			}
		}

		return completions;
	}

	/**
	 * Returns the property names when writing tss styles
	 *
	 * @private
	 * @param {string} linePrefix - The content between the cursor and the start of the line
	 * @param {Position} position - The position of the cursor
	 * @param {TextDocument} document - The associated textDocument
	 * @param {Project} project - The associated project
	 * @returns {Promise<CompletionItem[]>}
	 * @memberof TSSProvider
	 */
	private async propertyNameCompletions (linePrefix: string, position: Position, document: TextDocument, project: Project): Promise<CompletionItem[]> {
		const parentObjName = this.getParentObjectName(position, document);
		const prefix = /(\w+)/.exec(linePrefix)?.[0] ?? undefined;

		const { titanium } = await this.loadCompletions(project.sdkVersion());
		const { properties, types } = titanium;
		const innerProperties: { [key: string]: unknown } = {};
		const completions: CompletionItem[] = [];

		if (!parentObjName) {
			return completions;
		}

		// Lookup the property data
		const propertyData = properties[parentObjName];
		if (propertyData) {
			const propertyType = propertyData.type;
			const typeData = types[propertyType];
			if (typeData && typeData.properties && typeData.properties.length) {
				for (const property of typeData.properties) {
					innerProperties[property] = {};
				}
			}
		}

		const candidateProperties = Object.keys(innerProperties).length === 0 ? properties : innerProperties;
		for (const property in candidateProperties) {
			if (!prefix || property.toLowerCase().includes(prefix.toLowerCase())) {

				//
				// Object types
				//
				const jsObjectTypes = [ 'Font' ];
				if (jsObjectTypes.indexOf(properties[property].type) > -1) {
					completions.push({
						label: property,
						kind: CompletionItemKind.Property,
						insertText: `${property}: {\n\t\${1}\t\n}`,
						insertTextFormat: InsertTextFormat.Snippet
					});

					//
					// Value types
					//
				} else {
					completions.push({
						label: property,
						kind: CompletionItemKind.Property,
						insertText: `${property}: `
					});
				}
			}
		}
		return completions;
	}

	/**
	 * Get parent object name
	 *
	 * @param {Position} position caret position
	 * @param {TextDocument} document active text document
	 *
	 * @returns {String}
	 */
	public getParentObjectName (position: Position, document: TextDocument): string|undefined {
		let lineNumber = position.line;
		while (lineNumber >= 0) {
			const line = document.getText(Range.create(lineNumber, 0, lineNumber, uinteger.MAX_VALUE));
			const regexResult = /^\s*(\S+)\s*:\s*\{/.exec(line);
			const propertyName = regexResult ? regexResult[1] : undefined;

			const parentNameIndex = (regexResult ? regexResult.index : undefined) || -1;
			if (parentNameIndex < line.lastIndexOf('}')) {
				return;
			}
			if (propertyName) {
				return propertyName.replace(/["#.]/g, '');
			}
			lineNumber--;
		}
	}
}

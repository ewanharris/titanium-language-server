import { Project } from '../../project';
import { CompletionParams, CompletionItem, Range, CompletionItemKind } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Provider } from '..';
import { filterFiles } from '../../utils';
import path from 'path';
import fs from 'fs-extra';
import { getTargetPath } from '../../related';
import { URI } from 'vscode-uri';

export class JSProvider extends Provider {

	async doCompletion (params: CompletionParams, textDocument: TextDocument, project: Project): Promise<CompletionItem[]> {
		const completions: CompletionItem[] = [];
		const linePrefix = textDocument.getText(Range.create(params.position.line, 0, params.position.line, params.position.character));

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
			return this.getFileCompletions('lib', project, requestedModule);
		}

		// Don't continue on with any of the alloy specific suggestions
		if (await project.type() !== 'alloy') {
			return completions;
		}

		if (/\$\.([-a-zA-Z0-9-_]*)$/.test(linePrefix)) {
			return this.idCompletions(project, textDocument);
		}

		return completions;
	}

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

	private async titaniumApiCompletions (linePrefix: string, project: Project): Promise<CompletionItem[]> {
		const completionsData = await this.loadCompletions(project.sdkVersion());
		const { types } = completionsData.titanium;
		const matches = linePrefix.match(/(Ti\.(?:(?:[A-Z]\w*|iOS|iPad)\.?)*)([a-z]\w*)*$/);
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

		if (attribute && ('iOS'.indexOf(attribute) === 0 || 'iPad'.indexOf(attribute) === 0)) {
			apiName += '.' + attribute;
			attribute = undefined;
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
				if ((!attribute || func.toLowerCase() === attribute.toLowerCase()) && func.indexOf('deprecated') === -1) {
					completions.push({
						label: func,
						kind: CompletionItemKind.Method
					});
				}
			}
			for (const property of apiObj.properties) {
				if ((!attribute || property.toLowerCase() === attribute.toLowerCase()) && property.indexOf('deprecated') === -1) {
					completions.push({
						label: property,
						kind: CompletionItemKind.Property
					});
				}
			}
		}
		return completions;
	}

	private async getFileCompletions(directory: string, project: Project, moduleName?: string): Promise<CompletionItem[]> {
		const completions: CompletionItem[] = [];
		const filesPath = path.join(project.filePath, 'app', directory);

		if (!await fs.pathExists(filesPath)) {
			return completions;
		}

		const files = await filterFiles(filesPath, [ '.js', '.ts' ]);

		for (const file of files) {
			const relativePath = path.relative(filesPath, file);
			const value = `/${path.posix.format(path.parse(relativePath)).replace(path.extname(relativePath), '')}`;
			const completionItem: CompletionItem = {
				label: value,
				kind: CompletionItemKind.Reference,
				insertText: moduleName?.startsWith('/') ? value.replace('/', '') : value
			};
			completions.push(completionItem);
		}
		return completions;
	}
}

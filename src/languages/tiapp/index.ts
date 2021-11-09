import { CustomRequests, TitaniumSDK } from '../../index';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CompletionItem, CompletionItemKind, CompletionParams, Definition, DefinitionLink, Range } from 'vscode-languageserver/node';
import { Provider } from '..';
import { Project } from '../../project';

export class TiappProvider extends Provider {

	public async doCompletion(params: CompletionParams, textDocument: TextDocument, project: Project): Promise<CompletionItem[]> {
		const linePrefix = textDocument.getText(Range.create(params.position.line, 0, params.position.line, params.position.character));
		const completions: CompletionItem[] = [];
		const matches = /<([a-zA-Z][-a-zA-Z]*)(.*?)>(.*|$)/.exec(linePrefix);

		const tag = matches?.[1];

		if (tag === 'sdk-version') {
			const sdks = await this.connection.sendRequest<TitaniumSDK[]>(CustomRequests.InstalledSdks.method);

			const sdkVer = /<sdk-version>([^<]*)<?/.exec(linePrefix);
			if (!sdkVer) {
				return completions;
			}
			const sdkVersion = sdkVer?.[1];
			for (const sdk of sdks) {
				if (sdkVersion && !sdk.fullversion?.includes(sdkVersion)) {
					continue;
				}
				completions.push({
					label: sdk.fullversion || sdk.version,
					kind: CompletionItemKind.Value,
					insertText: sdk.fullversion?.replace(sdkVersion, '')
				});
			}
		} else if (tag === 'module') {
			const modules = await project.locallyInstalledModules();

			if (modules?.length) {
				for (const module of modules) {
					completions.push({
						label: module.name,
						kind: CompletionItemKind.Module,
						detail: module.platforms.join(',')
					});
				}
			}
		}

		return completions;
	}
}

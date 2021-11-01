import { Project } from '../project';
import { CompletionParams, CompletionItem, TextDocuments } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CompletionsData, CompletionsFormat, loadCompletions } from 'titanium-editor-commons/completions';

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

	/**
	 * Creates an instance of Provider.
	 * @memberof Provider
	 */
	constructor() {
		this.CompletionsFormat = CompletionsFormat.v3;
		this.completionsMap = new Map();
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
	abstract doCompletion (params: CompletionParams, textDocument: TextDocument, project: Project): Promise<CompletionItem[]>;
}

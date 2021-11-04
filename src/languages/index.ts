import { Project } from '../project';
import { CompletionParams, CompletionItem, CompletionItemKind, Range } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CompletionsData, CompletionsFormat, loadCompletions } from 'titanium-editor-commons/completions';
import path from 'path';
import fs from 'fs-extra';
import { getAllKeys, parseXmlString, toUnixPath } from '../utils';
import klaw from 'klaw';

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
	abstract doCompletion (params: CompletionParams, textDocument: TextDocument, project: Project): Promise<CompletionItem[]|undefined>;

	// Common completions methods and their RegExp's

	public alloyConfigCompletionsRegexp = /Alloy\.CFG\.([-a-zA-Z0-9-_/]*)[,]?$/
	public async alloyConfigCompletions (project: Project): Promise<CompletionItem[]> {
		const cfgPath = path.join(project.filePath, 'app', 'config.json');
		const completions: CompletionItem[] = [];
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
				kind: CompletionItemKind.Value
			});
		}
		return completions;
	}

	public i18nCompletionsRegex =  /(L\(|(?:hinttext|title|text)id\s*[:=]\s*)["'](\w*["']?)$/
	public async i18nCompletions (project: Project): Promise<CompletionItem[]> {
		// TODO: sync the config over from the extension?
		const defaultLang = 'en';
		const i18nPath = await project.i18nPath();
		const completions: CompletionItem[] = [];
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
					kind: CompletionItemKind.Reference,
					detail: value._
				});
			}
		}
		return completions;
	}

	public imageCompletionsRegex = /image\s*[:=]\s*["']([\w\s\\/\-_():.]*)['"]?$/
	public async imageCompletions (project: Project, range?: Range): Promise<CompletionItem[]> {
		const rootPath = await project.type() === 'alloy' ? path.join(project.filePath, 'app', 'assets') : project.filePath;
		const completions: CompletionItem[] = [];
		// limit search to these sub-directories
		const paths = [ 'images', 'iphone', 'android' ];
		for (const name of paths) {

			const imgPath = path.join(rootPath, name);
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
					kind: CompletionItemKind.File,
					// range,
					detail: scales
				});
			}
		}
		return completions;
	}
}

interface ImageAutoComplete {
	prefix: string;
	suffix: string;
	file: string;
	scales: string[]
}

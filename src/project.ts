import path from 'path';
import fs from 'fs-extra';
import { filterFiles, parseXmlString } from './utils';
import { logger } from './logger';

export type ProjectType = 'alloy' | 'classic';
type ModulePlatform = 'android' | 'iphone' | 'commonjs';

interface TiApp {
	'ti:app': TiAppData
}

interface TiAppData {
	[ key: string ]: string|string[]
}

interface Module {
	name: string,
	platforms: ModulePlatform[]
}

export class Project {

	public filePath: string;

	private tiapp: TiAppData;
	private _type?: ProjectType;
	private _isValid = false;

	constructor(filePath: string) {
		this.filePath = filePath;
		this.tiapp = {};
	}

	/**
	 * Whether the directory this Project points at is a Titanium project that we were able to read.
	 * A Project that is not valid should not be registered with the server, as the providers rely on
	 * data from the tiapp.xml to do their work.
	 *
	 * @readonly
	 * @type {boolean}
	 * @memberof Project
	 */
	public get isValid (): boolean {
		return this._isValid;
	}

	/**
	 * Reads and parses the projects tiapp.xml.
	 *
	 * @returns {Promise<boolean>} - Whether the project is a valid Titanium project
	 * @memberof Project
	 */
	public async load(): Promise<boolean> {
		this._isValid = false;
		const tiappFile = path.join(this.filePath, 'tiapp.xml');
		if (!await fs.pathExists(tiappFile)) {
			logger.log(`No tiapp.xml found at ${tiappFile}, ignoring ${this.filePath}`);
			return this._isValid;
		}

		try {
			const fileData = await fs.readFile(tiappFile, 'utf-8');
			const json = await parseXmlString<TiApp>(fileData);

			if (json && json['ti:app']) {
				this.tiapp = json['ti:app'];
				// A tiapp.xml without an sdk-version is not something we can provide completions
				// for, as every completion lookup is keyed off the SDK version
				this._isValid = Array.isArray(this.tiapp['sdk-version']) && this.tiapp['sdk-version'].length > 0;
				if (!this._isValid) {
					logger.log(`No sdk-version found in ${tiappFile}, ignoring ${this.filePath}`);
				}
			}
		} catch (error) {
			logger.error(`Failed to parse ${tiappFile}: ${error instanceof Error ? error.message : error}`);
		}

		return this._isValid;
	}

	/**
	 * The SDK version declared in the tiapp.xml
	 *
	 * @returns {string}
	 * @memberof Project
	 */
	public sdkVersion (): string {
		const sdkVersion = this.tiapp['sdk-version'];
		if (!Array.isArray(sdkVersion) || !sdkVersion.length) {
			throw new Error(`No sdk-version is set in ${path.join(this.filePath, 'tiapp.xml')}`);
		}
		return sdkVersion[0];
	}

	async type(): Promise<'alloy' | 'classic'> {
		if (this._type) {
			return this._type;
		}

		const config = path.join(this.filePath, 'app', 'config.json');
		if (await fs.pathExists(config)) {
			return this._type = 'alloy';
		} else {
			return this._type = 'classic';
		}
	}

	async i18nPath (): Promise<string|undefined> {
		if (await this.type() === 'alloy') {
			return path.join(this.filePath, 'app', 'i18n');
		} else {
			return path.join(this.filePath, 'i18n');
		}
	}

	async libFiles (): Promise<string[]> {
		const libDirectory = path.join(this.filePath, 'app', 'lib');
		return filterFiles(libDirectory, [ '.js', '.ts' ]);
	}

	// Alloy project related helpers

	async controllers(): Promise<string[]> {
		if (await this.type() !== 'alloy') {
			return [];
		}

		const controllersPath = path.join(this.filePath, 'app', 'controllers');
		return filterFiles(controllersPath, [ '.js', '.ts' ]);
	}

	async styles(): Promise<string[]> {
		if (await this.type() !== 'alloy') {
			return [];
		}

		const stylesPath = path.join(this.filePath, 'app', 'styles');
		return filterFiles(stylesPath, [ '.tss' ]);
	}

	async views(): Promise<string[]> {
		if (await this.type() !== 'alloy') {
			return [];
		}

		const viewsPath = path.join(this.filePath, 'app', 'views');
		return filterFiles(viewsPath, [ '.xml' ]);
	}

	/**
	 * Returns all modules locally installed in the projects modules directory
	 *
	 * @returns {(Promise<Module[]|undefined>)}
	 * @memberof Project
	 */
	async locallyInstalledModules (): Promise<Module[]|undefined> {
		const modulesPath = path.join(this.filePath, 'modules');
		const moduleMap: { [ key: string ]: ModulePlatform[] } = {};
		if (!await fs.pathExists(modulesPath)) {
			return;
		}

		for (const platform of await fs.readdir(modulesPath, { withFileTypes: true })) {

			if (!platform.isDirectory()) {
				continue;
			}

			const platformPath = path.join(modulesPath, platform.name);
			for (const name of await fs.readdir(platformPath, { withFileTypes: true })) {
				if (!name.isDirectory()) {
					continue;
				}
				if (!moduleMap[name.name]) {
					moduleMap[name.name] = [];
				}

				moduleMap[name.name].push(platform.name as ModulePlatform);
			}
		}

		const modules: Module[] = [];

		for (const [ name, platforms ] of Object.entries(moduleMap)) {
			modules.push({
				name,
				platforms
			});
		}

		return modules;
	}
}

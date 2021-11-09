import path from 'path';
import fs from 'fs-extra';
import { filterFiles, parseXmlString } from './utils';

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

	constructor(filePath: string) {
		this.filePath = filePath;
		this.tiapp = {};
	}

	public async load(): Promise<void> {
		const tiappFile = path.join(this.filePath, 'tiapp.xml');
		if (!await fs.pathExists(tiappFile)) {
			console.log('no exist');
			return;
		}

		try {
			const fileData = await fs.readFile(tiappFile, 'utf-8');
			const json = await parseXmlString<TiApp>(fileData);

			if (json && json['ti:app']) {
				this.tiapp = json['ti:app'];
			}
		} catch (error) {
			// handle? Respond back to the client?
			console.log(error);
		}
	}

	public sdkVersion (): string {
		return this.tiapp['sdk-version'][0];
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

	async modules(): Promise<Module[]> {
		const modules: Module[] = [];
		for (const module of this.tiapp.modules[0]) {
			// modules.push({
			// 	name: module._,

			// });
		}

		return modules;
	}

	/**
	 * Returns all modules locally installed in the projecs modules directory
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
				if (!platform.isDirectory()) {
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

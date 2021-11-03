import path from 'path';
import fs from 'fs-extra';
import { parseXmlString } from './utils';

interface TiApp {
	'ti:app': TiAppData
}

interface TiAppData {
	[ key: string ]: string|string[]
}

export class Project {

	public filePath: string;

	private tiapp: TiAppData;
	private _type?: 'alloy' | 'classic';

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
}

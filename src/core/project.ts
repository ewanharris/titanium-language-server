import path from 'node:path';
import fs from 'node:fs/promises';
import { findFiles, pathExists } from './fs.ts';
import { parseXml } from './xml.ts';
import { logger } from '../logger.ts';

export type ProjectType = 'alloy' | 'classic';

type ModulePlatform = 'android' | 'iphone' | 'commonjs';

export interface Module {
	name: string;
	platforms: ModulePlatform[];
}

/**
 * A Titanium project on disk, of either kind.
 *
 * Classic and Alloy differ in where their sources, assets and translations live, so every path
 * this exposes is derived from the project type rather than assumed. Only the Alloy-specific
 * collections are gated on type; everything else answers for both.
 */
export class Project {

	public filePath: string;

	private sdk: string|undefined;
	private projectType: ProjectType|undefined;
	private valid = false;

	constructor (filePath: string) {
		this.filePath = filePath;
	}

	/**
	 * Whether this directory is a Titanium project we could read.
	 *
	 * An invalid project should not be registered with the server: every completion lookup is keyed
	 * off the SDK version, so there is nothing to offer without one.
	 *
	 * @readonly
	 * @type {boolean}
	 * @memberof Project
	 */
	public get isValid (): boolean {
		return this.valid;
	}

	/**
	 * Reads and parses the project's tiapp.xml
	 *
	 * @returns {Promise<boolean>} Whether this is a valid Titanium project
	 * @memberof Project
	 */
	public async load (): Promise<boolean> {
		this.valid = false;
		this.sdk = undefined;

		const tiapp = path.join(this.filePath, 'tiapp.xml');
		if (!await pathExists(tiapp)) {
			logger.log(`No tiapp.xml found at ${tiapp}, ignoring ${this.filePath}`);
			return this.valid;
		}

		try {
			this.sdk = readSdkVersion(await fs.readFile(tiapp, 'utf-8'));
		} catch (error) {
			logger.error(`Failed to parse ${tiapp}: ${error instanceof Error ? error.message : error}`);
			return this.valid;
		}

		if (!this.sdk) {
			logger.log(`No sdk-version found in ${tiapp}, ignoring ${this.filePath}`);
			return this.valid;
		}

		this.valid = true;
		return this.valid;
	}

	/**
	 * The SDK version declared in the tiapp.xml
	 *
	 * @returns {string} The version, as written
	 * @memberof Project
	 */
	public sdkVersion (): string {
		if (!this.sdk) {
			throw new Error(`No sdk-version is set in ${path.join(this.filePath, 'tiapp.xml')}`);
		}
		return this.sdk;
	}

	/**
	 * Whether this is an Alloy or a classic project.
	 *
	 * app/config.json is what Alloy itself looks for, so it is what decides here too.
	 *
	 * @returns {Promise<ProjectType>} The project type
	 * @memberof Project
	 */
	public async type (): Promise<ProjectType> {
		if (this.projectType) {
			return this.projectType;
		}

		const config = path.join(this.filePath, 'app', 'config.json');
		this.projectType = await pathExists(config) ? 'alloy' : 'classic';
		return this.projectType;
	}

	/**
	 * The directory holding translations
	 *
	 * @returns {Promise<string>} app/i18n for Alloy, i18n at the root for classic
	 * @memberof Project
	 */
	public async i18nPath (): Promise<string> {
		return await this.type() === 'alloy'
			? path.join(this.filePath, 'app', 'i18n')
			: path.join(this.filePath, 'i18n');
	}

	/**
	 * The root that image references resolve against.
	 *
	 * Alloy compiles app/assets/* into Resources/*, so Resources is what app/assets becomes and is
	 * the classic equivalent. A classic project has no <project>/assets directory, which is where
	 * both the previous implementation and vscode-titanium looked — a bug that went unnoticed
	 * because vscode-titanium registers no provider on classic paths.
	 *
	 * @returns {Promise<string>} app/assets for Alloy, Resources for classic
	 * @memberof Project
	 */
	public async assetPath (): Promise<string> {
		return await this.type() === 'alloy'
			? path.join(this.filePath, 'app', 'assets')
			: path.join(this.filePath, 'Resources');
	}

	/**
	 * The root that `require` resolves module paths against
	 *
	 * @returns {Promise<string>} app/lib for Alloy, Resources for classic
	 * @memberof Project
	 */
	public async sourcePath (): Promise<string> {
		return await this.type() === 'alloy'
			? path.join(this.filePath, 'app', 'lib')
			: path.join(this.filePath, 'Resources');
	}

	/**
	 * Every file a `require` in this project could resolve to
	 *
	 * @returns {Promise<string[]>} Absolute paths, sorted
	 * @memberof Project
	 */
	public async libFiles (): Promise<string[]> {
		return findFiles(await this.sourcePath(), [ '.js', '.ts' ]);
	}

	/**
	 * The project's Alloy controllers, or nothing for a classic project
	 *
	 * @returns {Promise<string[]>} Absolute paths, sorted
	 * @memberof Project
	 */
	public async controllers (): Promise<string[]> {
		return this.alloyFiles('controllers', [ '.js', '.ts' ]);
	}

	/**
	 * The project's Alloy styles, or nothing for a classic project
	 *
	 * @returns {Promise<string[]>} Absolute paths, sorted
	 * @memberof Project
	 */
	public async styles (): Promise<string[]> {
		return this.alloyFiles('styles', [ '.tss' ]);
	}

	/**
	 * The project's Alloy views, or nothing for a classic project
	 *
	 * @returns {Promise<string[]>} Absolute paths, sorted
	 * @memberof Project
	 */
	public async views (): Promise<string[]> {
		return this.alloyFiles('views', [ '.xml' ]);
	}

	/**
	 * The modules installed into the project's own modules directory, as opposed to globally
	 *
	 * @returns {Promise<Module[]>} Each module and the platforms it is installed for, by name
	 * @memberof Project
	 */
	public async locallyInstalledModules (): Promise<Module[]> {
		const modulesPath = path.join(this.filePath, 'modules');

		let platforms;
		try {
			platforms = await fs.readdir(modulesPath, { withFileTypes: true });
		} catch {
			return [];
		}

		const byName = new Map<string, ModulePlatform[]>();

		for (const platform of platforms) {
			if (!platform.isDirectory()) {
				continue;
			}

			const platformPath = path.join(modulesPath, platform.name);
			for (const module of await fs.readdir(platformPath, { withFileTypes: true })) {
				// a loose file alongside the module directories is not a module
				if (!module.isDirectory()) {
					continue;
				}
				const existing = byName.get(module.name) ?? [];
				existing.push(platform.name as ModulePlatform);
				byName.set(module.name, existing);
			}
		}

		return [ ...byName ]
			.map(([ name, modulePlatforms ]) => ({ name, platforms: modulePlatforms }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * Files from one of the Alloy source directories, which a classic project does not have
	 *
	 * @param directory - The directory under app/
	 * @param extensions - Extensions to keep, including the leading dot
	 * @returns {Promise<string[]>} Absolute paths, sorted, or empty for a classic project
	 * @memberof Project
	 */
	private async alloyFiles (directory: string, extensions: string[]): Promise<string[]> {
		if (await this.type() !== 'alloy') {
			return [];
		}
		return findFiles(path.join(this.filePath, 'app', directory), extensions);
	}
}

/**
 * Reads the sdk-version out of a tiapp.xml.
 *
 * Read with the view parser, which recovers rather than throwing, so a tiapp.xml saved half way
 * through an edit still yields its version instead of taking the whole project down.
 *
 * @param contents - The tiapp.xml contents
 * @returns {string|undefined} The declared SDK version, if there is one
 */
function readSdkVersion (contents: string): string|undefined {
	const version = parseXml(contents).elements.find(element => element.tag === 'sdk-version')?.text;
	return version ? version : undefined;
}

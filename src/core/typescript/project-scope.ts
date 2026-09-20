import path from 'node:path';
import { readAlloyConfig } from '../config.ts';
import { readTranslations, translationKeys } from '../i18n.ts';
import { Project, namesUnder } from '../project.ts';
import type { SourceCache } from '../references.ts';
import { generateProjectDeclaration } from './project-declaration.ts';
import type { ProjectFacts } from './project-declaration.ts';
import type { AlloyFacts } from './alloy-declaration.ts';
import { ProjectService } from './host.ts';
import { IdentityMapping } from './mapping.ts';

/**
 * Keeps the project's own declaration in scope, and current.
 *
 * The counterpart of `ViewDeclarations`, and deliberately the simpler of the two: where the `$`
 * declaration swaps as the cursor moves between controllers, this one is the same for every file
 * in the project and never swaps. What it does have to do is notice when the project changed
 * underneath it — a key added to `config.json`, a string added to a `strings.xml` — because those
 * are files the user edits while writing the code that reads them.
 *
 * Staleness is decided by the versions of the files it read, which `SourceCache` already tracks
 * because they move whenever a buffer is replaced. That makes the common case — a request where
 * nothing relevant changed — a handful of map lookups rather than a re-read of the configuration
 * and every translation file, which is what it costs to do this on each keystroke.
 *
 * What that does not catch is a controller or a widget appearing on disk without passing through
 * the editor. Nothing in this server watches the file system — the registry, the type resolution
 * and the language service's own file set are all settled when a project is opened — so this is
 * the same limitation everywhere rather than a new one, and a file created outside the editor
 * needs the workspace reopened either way.
 */

export interface ProjectDeclarationOptions {
	/** The project to describe */
	project: Project;
	/** The service to install the declaration into */
	service: ProjectService;
	/** Where open buffers come from, shared with the rest of the analysis */
	cache: SourceCache;
}

/** What is installed, and what it was built from */
interface Installed {
	/** The generated text, compared so an unchanged rebuild does not bump the script version */
	text: string;
	/** The version of each file that was read, in the order they were read */
	versions: string;
}

export class ProjectDeclaration {

	private project: Project;
	private service: ProjectService;
	private cache: SourceCache;
	private installed: Installed|undefined;

	constructor (options: ProjectDeclarationOptions) {
		this.project = options.project;
		this.service = options.service;
		this.cache = options.cache;
	}

	/**
	 * Where the declaration stands.
	 *
	 * At the project root rather than under `app/`, because a classic project has no `app/` and
	 * the declaration is not Alloy's — `L` is a Titanium global and classic has translations too.
	 * A path, not a file: nothing is written into a user's project.
	 *
	 * @readonly
	 * @type {string}
	 * @memberof ProjectDeclaration
	 */
	public get filePath (): string {
		return path.join(this.project.filePath, '.titanium-project.d.ts');
	}

	/**
	 * Builds the declaration if it is missing or out of date, and installs it.
	 *
	 * Answers quickly and does nothing at all in the common case, because it is called before
	 * every request rather than once.
	 *
	 * @returns {Promise<void>} When what is in scope describes the project as it now is
	 * @memberof ProjectDeclaration
	 */
	public async ensure (): Promise<void> {
		const { facts, versions } = await this.read();

		// the files it was built from are all unchanged, so the declaration would be identical and
		// rebuilding would only bump the script version and make TypeScript parse it again
		if (this.installed && this.installed.versions === versions) {
			return;
		}

		const text = generateProjectDeclaration(facts);

		// a project with nothing to declare installs nothing rather than an empty file, and one
		// that had something and now has none has it taken back out
		if (!text) {
			this.service.dropGenerated(this.filePath);
			this.installed = undefined;
			return;
		}

		if (this.installed?.text !== text) {
			this.service.setGenerated(this.filePath, text, new IdentityMapping(this.filePath));
		}

		this.installed = { text, versions };
	}

	/**
	 * Reads what the project says about itself, and the versions of the files that said it.
	 *
	 * The versions travel with the facts rather than being recomputed, so that what is compared
	 * against next time is exactly what this build saw.
	 *
	 * @returns The facts and a signature of the files behind them
	 * @memberof ProjectDeclaration
	 */
	private async read (): Promise<{ facts: ProjectFacts; versions: string }> {
		const translations = await readTranslations(this.project, this.cache);

		const read = [
			path.join(this.project.filePath, 'app', 'config.json'),
			...new Set(translations.map(translation => translation.path))
		];

		const facts: ProjectFacts = {
			translationKeys: translationKeys(translations),
			alloy: await this.alloyFacts()
		};

		return { facts, versions: read.map(file => `${file}@${this.cache.version(file)}`).join('\n') };
	}

	/**
	 * What Alloy adds, or nothing at all for a classic project.
	 *
	 * The absence is the project type: nothing downstream asks which kind of project this is,
	 * because a classic one simply has no Alloy facts to answer with.
	 *
	 * @returns {Promise<AlloyFacts|undefined>} The facts, for an Alloy project
	 * @memberof ProjectDeclaration
	 */
	private async alloyFacts (): Promise<AlloyFacts|undefined> {
		if (await this.project.type() !== 'alloy') {
			return;
		}

		// a config.json that is being typed, or is not JSON at the moment, reads as no keys rather
		// than as no project: the file is what decided this is an Alloy project in the first place
		const config = await readAlloyConfig(this.project, this.cache) ?? { values: {}, dependencies: [] };

		return {
			config,
			controllers: namesUnder(path.join(this.project.filePath, 'app', 'controllers'), await this.project.controllers()),
			models: namesUnder(path.join(this.project.filePath, 'app', 'models'), await this.project.models()),
			widgets: await this.project.widgets()
		};
	}
}

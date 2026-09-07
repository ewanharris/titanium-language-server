import { Project } from '../project.ts';
import type { SourceCache } from '../references.ts';
import { ProjectService } from './host.ts';
import { resolveTypes } from './types.ts';
import type { TypesReport, TypesSource } from './types.ts';

/**
 * The language services the server holds, one per registered project.
 *
 * A service owns a parsed program, which is the expensive thing here — 623 ms of cold parse for
 * the Titanium types. So it is built once when a project is registered and kept, rather than being
 * rebuilt per request, and it is disposed when the project goes away rather than being left to
 * hold a program for a folder nobody has open.
 *
 * Every service reads through one shared `SourceCache`. That is deliberate: the cache is where
 * open buffers live, and a second one would be a second source of truth that disagrees in the
 * middle of an edit.
 */

export interface ProjectServicesOptions {
	/** Where open buffers come from, shared with the rest of the analysis */
	cache: SourceCache;
	/** Where types come from, in preference order */
	sources: TypesSource[];
}

/** What opening a project produced, and what to tell the user about how its types resolved */
export interface OpenedService {
	service: ProjectService;
	report: TypesReport;
}

export class ProjectServices {

	private cache: SourceCache;
	private sources: TypesSource[];
	private opened = new Map<string, OpenedService>();

	constructor (options: ProjectServicesOptions) {
		this.cache = options.cache;
		this.sources = options.sources;
	}

	/**
	 * Builds and warms the service for a project, or answers the one already built.
	 *
	 * Warmed here rather than on the first request, because the cold parse landing on a keystroke
	 * is the difference between a server that feels slow and one that does not.
	 *
	 * @param project - The project to open
	 * @returns {Promise<OpenedService>} The service, and how its types resolved
	 * @memberof ProjectServices
	 */
	public async open (project: Project): Promise<OpenedService> {
		// resolution can shell out to npm, so an already open project answers without going near
		// it again
		const existing = this.opened.get(project.filePath);
		if (existing) {
			return existing;
		}

		const resolution = await resolveTypes(project, this.sources);

		const service = await ProjectService.create({
			project,
			cache: this.cache,
			types: resolution.location
		});

		// nothing to parse without types, and warm() knows that — calling it unconditionally keeps
		// the decision in one place rather than in every caller
		service.warm();

		const opened = { service, report: resolution.report };
		this.opened.set(project.filePath, opened);

		return opened;
	}

	/**
	 * The service for a project, if one has been opened
	 *
	 * @param project - The project
	 * @returns {ProjectService|undefined} Its service
	 * @memberof ProjectServices
	 */
	public get (project: Project): ProjectService|undefined {
		return this.opened.get(project.filePath)?.service;
	}

	/**
	 * Disposes the service for a project and forgets it.
	 *
	 * A project that was never opened is not an error: workspace folders are removed in bulk, and
	 * a folder that held no valid project never had a service.
	 *
	 * @param project - The project going away
	 * @memberof ProjectServices
	 */
	public close (project: Project): void {
		this.opened.get(project.filePath)?.service.dispose();
		this.opened.delete(project.filePath);
	}

	/**
	 * Disposes every service held
	 *
	 * @memberof ProjectServices
	 */
	public dispose (): void {
		for (const { service } of this.opened.values()) {
			service.dispose();
		}
		this.opened.clear();
	}
}

import path from 'node:path';
import { readThemes } from './config.ts';
import type { AlloyTheme } from './config.ts';
import type { SourceCache, SourceFile } from './references.ts';
import { findFiles, pathExists } from './fs.ts';
import { Project } from './project.ts';

/**
 * One corner of the Alloy MVC triad.
 *
 * Callers ask for the kind of file they want rather than an extension, because the mapping between
 * the two is Alloy's business and not theirs.
 */
export type RelatedFileType = 'view' | 'style' | 'controller';

interface RelatedFileShape {
	directory: string;
	/** In preference order, so a TypeScript controller wins over the JavaScript beside it */
	extensions: string[];
}

const shapes: Record<RelatedFileType, RelatedFileShape> = {
	view: { directory: 'views', extensions: [ '.xml' ] },
	style: { directory: 'styles', extensions: [ '.tss' ] },
	controller: { directory: 'controllers', extensions: [ '.ts', '.js' ] }
};

/** The directories under app/ whose files have related files at all */
const pairable = /^(controllers|styles|views|widgets)[\\/]/;

/**
 * The file of a given kind that pairs with the one given.
 *
 * Alloy pairs files by position: app/views/a/b.xml, app/styles/a/b.tss and app/controllers/a/b.js
 * are one screen, and a widget repeats the same triad one level down. So the answer is the same
 * path with its directory and extension swapped — provided the result exists, since a view is
 * allowed to have no controller.
 *
 * Takes a file system path, not a URI. Translating the protocol's URIs is the server layer's job.
 *
 * @param project - The project the file belongs to
 * @param type - The kind of file wanted
 * @param filePath - The file to find the counterpart of
 * @returns {Promise<string|undefined>} The counterpart's path, if there is one
 */
export async function relatedFile (project: Project, type: RelatedFileType, filePath: string): Promise<string|undefined> {
	if (await project.type() !== 'alloy') {
		return;
	}

	for (const candidate of counterparts(project, type, filePath)) {
		if (await pathExists(candidate)) {
			return candidate;
		}
	}
}

/**
 * Where the file of a given kind that pairs with the one given would be, whether or not it exists:
 * the place to create it.
 *
 * The last extension the kind takes, which for a controller is JavaScript — the language a project
 * that has not chosen TypeScript is written in.
 *
 * @param project - The project the file belongs to
 * @param type - The kind of file wanted
 * @param filePath - The file to find the counterpart of
 * @returns {string|undefined} The path, or nothing for a file that has no counterpart
 */
export function counterpartPath (project: Project, type: RelatedFileType, filePath: string): string|undefined {
	return counterparts(project, type, filePath).at(-1);
}

/**
 * Every path the counterpart of a file could have, in preference order
 *
 * @param project - The project the file belongs to
 * @param type - The kind of file wanted
 * @param filePath - The file to find the counterpart of
 * @returns {string[]} The candidates, none for a file outside the pairable directories
 */
function counterparts (project: Project, type: RelatedFileType, filePath: string): string[] {
	const appRoot = path.join(project.filePath, 'app');
	const relative = path.relative(appRoot, filePath);

	// path.relative walks back out of the project with '..' segments rather than failing, and the
	// directory swap below would turn that into a plausible path somewhere else entirely, so
	// anything that is not one of the pairable directories under app/ stops here
	if (!pairable.test(relative)) {
		return [];
	}

	const segments = relative.split(path.sep);
	const shape = shapes[type];

	// a widget is the same triad nested under app/widgets/<name>/, so the directory to swap is one
	// level deeper than it is for the app itself
	const swapAt = segments[0] === 'widgets' ? 2 : 0;
	segments[swapAt] = shape.directory;

	const name = path.basename(segments[segments.length - 1], path.extname(segments[segments.length - 1]));

	return shape.extensions.map(extension => path.join(appRoot, ...segments.slice(0, -1), `${name}${extension}`));
}

/**
 * Alloy's `CONST.PLATFORM_FOLDERS_ALLOY`: the folders under `styles/` and `views/` that hold what
 * one platform alone uses
 */
const PLATFORM_FOLDERS = [ 'android', 'ios', 'mobileweb', 'windows' ];

/** A stylesheet Alloy applies to a view, and what it is to the cascade */
export interface AppliedStylesheet extends SourceFile {
	/** The platform it is loaded for alone, for one under a platform folder */
	platform?: string;
	/** The theme it belongs to, for one under `app/themes/` */
	theme?: string;
	/**
	 * Whether it applies only to some builds: one platform's, or a theme `config.json` does not name
	 * for every build. An editor knows neither, so its rules may apply rather than do.
	 */
	conditional: boolean;
}

/**
 * Every stylesheet Alloy loads for a view, in the order it loads them.
 *
 * Transcribed from `compile/index.js` and `loadGlobalStyles` in `styler.js`. The global ones come
 * first — `app.tss`, the theme's, and each platform folder's of both — then the view's own and its
 * platform folders', then the theme's copy of the view's and its platform folders'. A widget has
 * its own in place of the app's, and the global ones all the same: `parseAlloyComponent` starts
 * every component it compiles, widgets included, from `styler.globalStyle`.
 *
 * Alloy builds for one platform and loads that platform's folders alone. An editor builds for none,
 * so every platform's is loaded, each marked as applying only on its platform.
 *
 * @param project - The project the view belongs to
 * @param viewPath - The view's path
 * @param cache - Where to read from, so an open stylesheet answers with what is in the buffer
 * @returns {Promise<AppliedStylesheet[]>} The stylesheets that exist, `app.tss` always among them
 */
export async function stylesheetsFor (project: Project, viewPath: string, cache: SourceCache): Promise<AppliedStylesheet[]> {
	const { app, widget, component, name } = placeOf(project, viewPath);

	const themes = await readThemes(project, cache);
	const candidates: Omit<AppliedStylesheet, 'text'>[] = [];
	const add = (directory: string, file: string, theme?: AlloyTheme): void => {
		candidates.push({ path: path.join(directory, file), theme: theme?.name, conditional: theme?.conditional ?? false });
		for (const platform of PLATFORM_FOLDERS) {
			candidates.push({ path: path.join(directory, platform, file), platform, theme: theme?.name, conditional: true });
		}
	};

	// loadGlobalStyles: app.tss, the theme's, then each platform's of both
	candidates.push({ path: path.join(app, 'styles', 'app.tss'), conditional: false });
	for (const theme of themes) {
		candidates.push({ path: path.join(app, 'themes', theme.name, 'styles', 'app.tss'), theme: theme.name, conditional: theme.conditional });
	}
	for (const platform of PLATFORM_FOLDERS) {
		candidates.push({ path: path.join(app, 'styles', platform, 'app.tss'), platform, conditional: true });
		for (const theme of themes) {
			candidates.push({ path: path.join(app, 'themes', theme.name, 'styles', platform, 'app.tss'), platform, theme: theme.name, conditional: true });
		}
	}

	add(path.join(component, 'styles'), name);
	for (const theme of themes) {
		add(widget ? path.join(app, 'themes', theme.name, 'widgets', widget, 'styles') : path.join(app, 'themes', theme.name, 'styles'), name, theme);
	}

	const found: AppliedStylesheet[] = [];
	for (const candidate of candidates) {
		// app.tss is always there to be read, empty or not, so an unsaved one still answers
		const always = candidate === candidates[0];
		if (always || await pathExists(candidate.path)) {
			found.push({ ...candidate, text: (await cache.read(candidate.path)).text });
		}
	}

	return found;
}

/**
 * The view's own stylesheet, where a rule written for it belongs, whether or not it exists yet.
 *
 * The one beside it under `styles/` — the widget's own for a view in a widget — and, for a view under
 * a platform folder, the one of the view it stands in for, which is what Alloy styles it from.
 *
 * @param project - The project the view belongs to
 * @param viewPath - The view's path
 * @returns {string} The stylesheet's path
 */
export function ownStylesheet (project: Project, viewPath: string): string {
	const { component, name } = placeOf(project, viewPath);
	return path.join(component, 'styles', name);
}

/**
 * Whether a view is one platform's version of another, under a platform folder
 *
 * @param project - The project the view belongs to
 * @param viewPath - The view's path
 * @returns {boolean} Whether it is
 */
export function inPlatformFolder (project: Project, viewPath: string): boolean {
	return placeOf(project, viewPath).platform !== undefined;
}

/**
 * Where a view sits in Alloy's layout, as the stylesheets that apply to it are found from
 *
 * @param project - The project the view belongs to
 * @param viewPath - The view's path
 * @returns The app directory, the widget and its directory when it is in one, the name its
 *   stylesheets share, and the platform folder it is under when it is under one
 */
function placeOf (project: Project, viewPath: string): { app: string; widget?: string; component: string; name: string; platform?: string } {
	const app = path.join(project.filePath, 'app');
	const segments = path.relative(app, viewPath).split(path.sep);

	// the widget's own triad in place of the app's, and the theme's copy under themes/<name>/widgets
	const widget = segments[0] === 'widgets' && segments.length > 3 ? segments[1] : undefined;
	const component = widget ? path.join(app, 'widgets', widget) : app;
	const inComponent = widget ? segments.slice(3) : segments.slice(1);

	// Alloy strips a platform folder from a view's path before looking for its stylesheet, so a
	// view under views/ios/ is styled by the stylesheet of the view it stands in for
	const platform = PLATFORM_FOLDERS.includes(inComponent[0]) && inComponent.length > 1 ? inComponent[0] : undefined;
	const name = (platform ? inComponent.slice(1) : inComponent).join(path.sep).replace(/\.xml$/, '.tss');

	return { app, widget, component, name, platform };
}

/**
 * The stylesheets Alloy applies to a view, most specific first — `stylesheetsFor` the other way
 * round, which is the order a search for the rule that styles something wants.
 *
 * @param project - The project the view belongs to
 * @param viewPath - The view's path
 * @param cache - Where to read from, so an open stylesheet answers with what is in the buffer
 * @returns {Promise<SourceFile[]>} The stylesheets, most specific first
 */
export async function applicableStyles (project: Project, viewPath: string, cache: SourceCache): Promise<SourceFile[]> {
	if (await project.type() !== 'alloy') {
		return [];
	}
	return (await stylesheetsFor(project, viewPath, cache)).reverse();
}

/**
 * The views a stylesheet applies to — the other direction from `stylesheetsFor`.
 *
 * Any `app.tss` — the app's, a theme's, or one of their platform folders' — styles every view in
 * the app, its widgets' included. Any other stylesheet styles the view it is paired with, found
 * by dropping the theme and platform folders from its path, and the same view under any platform
 * folder, which Alloy styles from the same stylesheet. A stylesheet is only ever styling what these
 * contain, so what a class or an id in one can refer to is answered from them and nowhere else.
 *
 * @param project - The project the stylesheet belongs to
 * @param stylePath - The stylesheet's path
 * @param cache - Where to read from, so an open view answers with what is in the buffer
 * @returns {Promise<SourceFile[]>} The views, which may be none at all
 */
export async function viewsStyledBy (project: Project, stylePath: string, cache: SourceCache): Promise<SourceFile[]> {
	if (await project.type() !== 'alloy') {
		return [];
	}

	const app = path.join(project.filePath, 'app');
	let segments = path.relative(app, stylePath).split(path.sep);

	// a theme's stylesheet stands in for the one at the same place outside the theme
	if (segments[0] === 'themes' && segments.length > 2) {
		segments = segments.slice(2);
	}

	const widget = segments[0] === 'widgets' && segments.length > 3 ? segments[1] : undefined;
	let inStyles = widget ? segments.slice(3) : segments.slice(1);
	if ((widget ? segments[2] : segments[0]) !== 'styles') {
		return [];
	}
	if (PLATFORM_FOLDERS.includes(inStyles[0]) && inStyles.length > 1) {
		inStyles = inStyles.slice(1);
	}

	if (!widget && inStyles.length === 1 && inStyles[0] === 'app.tss') {
		// project.views() reads app/views alone, so each widget's views are added to it
		const widgetViews = await Promise.all((await project.widgets()).map(name => findFiles(path.join(app, 'widgets', name, 'views'), [ '.xml' ])));
		return Promise.all([ ...await project.views(), ...widgetViews.flat() ].map(view => cache.read(view)));
	}

	const views = widget ? path.join(app, 'widgets', widget, 'views') : path.join(app, 'views');
	const name = inStyles.join(path.sep).replace(/\.tss$/, '.xml');

	const found: SourceFile[] = [];
	for (const candidate of [ path.join(views, name), ...PLATFORM_FOLDERS.map(platform => path.join(views, platform, name)) ]) {
		if (await pathExists(candidate)) {
			found.push(await cache.read(candidate));
		}
	}
	return found;
}

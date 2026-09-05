import path from 'node:path';
import { pathExists } from './fs.js';
import { Project } from './project.js';

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

	const appRoot = path.join(project.filePath, 'app');
	const relative = path.relative(appRoot, filePath);

	// path.relative walks back out of the project with '..' segments rather than failing, and the
	// directory swap below would turn that into a plausible path somewhere else entirely, so
	// anything that is not one of the pairable directories under app/ stops here
	if (!pairable.test(relative)) {
		return;
	}

	const segments = relative.split(path.sep);
	const shape = shapes[type];

	// a widget is the same triad nested under app/widgets/<name>/, so the directory to swap is one
	// level deeper than it is for the app itself
	const swapAt = segments[0] === 'widgets' ? 2 : 0;
	segments[swapAt] = shape.directory;

	const name = path.basename(segments[segments.length - 1], path.extname(segments[segments.length - 1]));

	for (const extension of shape.extensions) {
		segments[segments.length - 1] = `${name}${extension}`;
		const candidate = path.join(appRoot, ...segments);
		if (await pathExists(candidate)) {
			return candidate;
		}
	}
}

import path from 'node:path';
import { Project } from './project.ts';
import { ProjectRegistry } from './registry.ts';

/**
 * What a document is, and what it does.
 *
 * Two questions, because neither answers on its own. The language id says a file is XML; the
 * project layout says whether that is a view, a tiapp.xml or a translation. A `.js` says nothing
 * at all until you know whether it sits under `app/controllers` or `Resources`.
 *
 * The id is matched case insensitively and by substring, because editors do not agree on it.
 * VS Code sends language ids (`xml`, `javascript`); Pulsar sends grammar names (`Alloy (TSS)`).
 * An editor that has no grammar for TSS at all sends something meaningless, so the extension is
 * the fallback rather than the primary source.
 */

export type FileKind = 'xml' | 'tss' | 'javascript' | 'typescript' | 'unknown';

export type FileRole =
	| 'view' | 'style' | 'controller' | 'model' | 'lib' | 'alloy'
	| 'source'
	| 'tiapp' | 'i18n'
	| 'unknown';

export interface RoutedFile {
	project: Project;
	path: string;
	kind: FileKind;
	role: FileRole;
}

/** Checked in order, so `typescript` is not read as containing `script` alone */
const ids: [ string, FileKind ][] = [
	[ 'tss', 'tss' ],
	[ 'typescript', 'typescript' ],
	[ 'javascript', 'javascript' ],
	[ 'xml', 'xml' ]
];

const extensions: Record<string, FileKind> = {
	'.xml': 'xml',
	'.tss': 'tss',
	'.js': 'javascript',
	'.jsx': 'javascript',
	'.ts': 'typescript',
	'.tsx': 'typescript'
};

/** The directories under app/ that hold each kind of Alloy file */
const alloyDirectories: Record<string, FileRole> = {
	views: 'view',
	styles: 'style',
	controllers: 'controller',
	models: 'model',
	lib: 'lib',
	i18n: 'i18n'
};

/**
 * What language a document is written in
 *
 * @param languageId - The id or grammar name the client reported
 * @param filePath - The file's path, used when the id says nothing
 * @returns {FileKind} The language, as far as it can be told
 */
export function fileKind (languageId: string, filePath: string): FileKind {
	const id = languageId.toLowerCase();

	for (const [ needle, kind ] of ids) {
		if (id.includes(needle)) {
			return kind;
		}
	}

	return extensions[path.extname(filePath).toLowerCase()] ?? 'unknown';
}

/**
 * What a file is for, derived from where it sits in the project.
 *
 * Alloy roles are gated on the project type: a classic project with an `app/views` directory has
 * one by coincidence, and treating it as Alloy would offer completions for a compiler that will
 * never run over it.
 *
 * @param project - The project the file belongs to
 * @param filePath - An absolute path to the file
 * @returns {Promise<FileRole>} What the file does in the project
 */
export async function fileRole (project: Project, filePath: string): Promise<FileRole> {
	const relative = path.relative(project.filePath, filePath);
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		return 'unknown';
	}

	const segments = relative.split(path.sep);
	if (segments.length === 1 && segments[0] === 'tiapp.xml') {
		return 'tiapp';
	}

	if (await project.type() !== 'alloy') {
		return classicRole(segments);
	}

	if (segments[0] !== 'app') {
		return 'unknown';
	}

	// a widget is the same triad nested under app/widgets/<name>/, so the directory that names the
	// role is one level deeper
	const rest = segments[1] === 'widgets' ? segments.slice(3) : segments.slice(1);

	if (rest.length === 1) {
		return rest[0] === 'alloy.js' ? 'alloy' : 'unknown';
	}

	return alloyDirectories[rest[0]] ?? 'unknown';
}

/**
 * What a file is for in a classic project, where everything executable lives under Resources
 *
 * @param segments - The file's path relative to the project, split
 * @returns {FileRole} What the file does
 */
function classicRole (segments: string[]): FileRole {
	if (segments.length < 2) {
		return 'unknown';
	}
	if (segments[0] === 'Resources') {
		return 'source';
	}
	return segments[0] === 'i18n' ? 'i18n' : 'unknown';
}

/**
 * Routes a document to the project it belongs to and what it is there.
 *
 * A file in no registered project is not routed at all, rather than routed to a project that
 * happens to be open — answering a question about a file the server knows nothing about is how
 * the wrong SDK's completions end up in someone's editor.
 *
 * @param registry - The registered projects
 * @param filePath - An absolute path to the file
 * @param languageId - The id or grammar name the client reported
 * @returns {Promise<RoutedFile|undefined>} Where the file belongs, if anywhere
 */
export async function route (registry: ProjectRegistry, filePath: string, languageId: string): Promise<RoutedFile|undefined> {
	const project = registry.projectFor(filePath);
	if (!project) {
		return;
	}

	return {
		project,
		path: filePath,
		kind: fileKind(languageId, filePath),
		role: await fileRole(project, filePath)
	};
}

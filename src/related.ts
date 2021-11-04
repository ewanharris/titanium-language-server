import { Project } from './project';
import fs from 'fs-extra';
import path from 'path';
import { URI } from 'vscode-uri';

const alloyDirectoryMap: { [key: string]: string } = {
	xml: 'views',
	tss: 'styles',
	js: 'controllers'
};

/**
 * Get path of related file
 *
 * @param {Project} project - The Titanium project instance
 * @param {String} type 			view, style, controller
 * @param {String} currentFilePath	path of current file
 * @returns {String}
 */
export async function getTargetPath (project: Project, type: string, currentFilePath: string): Promise<string|undefined> {
	// convert from a file URI to a plain fsPath just incase one is passed in
	if (currentFilePath.startsWith('file://')) {
		currentFilePath = URI.parse(currentFilePath).fsPath;
	}

	const alloyRootPath = path.join(project.filePath, 'app');

	const pathUnderAlloy = path.relative(alloyRootPath, currentFilePath);
	const pathSplitArr = pathUnderAlloy.split(path.sep);

	if (pathSplitArr[0] === 'widgets') {
		pathSplitArr[2] = alloyDirectoryMap[type];  // change type
	} else {
		pathSplitArr[0] = alloyDirectoryMap[type];  // change type
	}

	const extensionLookups = [ type ];
	if (type === 'js') {
		extensionLookups.unshift('ts');
	}

	for (const extension of extensionLookups) {
		const fileSplitArr = pathSplitArr[pathSplitArr.length - 1].split('.');
		fileSplitArr[fileSplitArr.length - 1] = extension; // change ext

		const targetPath = path.resolve(alloyRootPath, pathSplitArr.join(path.sep), '..', fileSplitArr.join('.'));

		if (await fs.pathExists(targetPath)) {
			return targetPath;
		}
	}
}

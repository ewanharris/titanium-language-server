import assert from 'node:assert/strict';
import path from 'node:path';
import ts from 'typescript';
import { Project } from '../../../core/project.ts';
import { alloyLibraryPath } from '../../../core/typescript/alloy-library.ts';
import { ProjectTypes } from '../../../core/typescript/types.ts';
import type { TypesLocation } from '../../../core/typescript/types.ts';
import { fixturePath } from '../../fixtures.ts';

/**
 * Compiling generated declarations, which is the assertion that matters most about them.
 *
 * An error in a generated declaration is a member that resolves to nothing in every editor, and
 * nothing else in the suite would notice: the language service answers an error type with silence
 * rather than with a complaint. Shared because three test files need it and each would otherwise
 * carry its own compiler host.
 */

/**
 * The stubbed types the classic fixture installs, which both project types borrow
 *
 * @returns {Promise<TypesLocation>} Where the stub lives
 */
export async function stubTypes (): Promise<TypesLocation> {
	const project = new Project(await fixturePath('classic-project'));
	await project.load();

	const located = await new ProjectTypes().locate(project);
	assert.ok(located?.location, 'the classic fixture should carry the stubbed types');

	return located.location;
}

/**
 * Compiles sources alongside the Titanium types and the shipped Alloy declarations, and answers
 * the errors in them.
 *
 * The Alloy library is included because it is what a generated Alloy declaration adds to: on its
 * own, `createController` returning `Controller` names a type nothing declares. Including it here
 * is also the only type check that file gets — it ships outside `src/`, so `npm run build` never
 * looks at it.
 *
 * @param sources - Each source, by a name to give it
 * @returns {Promise<string[]>} The messages, which should be none
 */
export async function errorsIn (sources: Record<string, string>): Promise<string[]> {
	const types = await stubTypes();
	const directory = path.dirname(types.entry);
	const files = Object.fromEntries(
		Object.entries(sources).map(([ name, text ]) => [ path.join(directory, name), text ])
	);

	const host = ts.createCompilerHost({});
	const original = host.getSourceFile.bind(host);

	host.fileExists = file => file in files || ts.sys.fileExists(file);
	host.readFile = file => files[file] ?? ts.sys.readFile(file);
	host.getSourceFile = (file, ...rest) => (file in files
		? ts.createSourceFile(file, files[file], ts.ScriptTarget.ES2020, true)
		: original(file, ...rest));

	const roots = [ types.entry, alloyLibraryPath(), ...Object.keys(files) ];
	const program = ts.createProgram(roots, { noEmit: true, strict: true, types: [] }, host);

	return [ ...program.getSemanticDiagnostics(), ...program.getSyntacticDiagnostics() ]
		.filter(diagnostic => diagnostic.file && (diagnostic.file.fileName in files || diagnostic.file.fileName === alloyLibraryPath()))
		.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
}

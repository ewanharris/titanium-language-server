import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import ts from 'typescript';
import { Project } from '../../../core/project.ts';
import { generateProjectDeclaration } from '../../../core/typescript/project-declaration.ts';
import type { ProjectFacts } from '../../../core/typescript/project-declaration.ts';
import { ProjectTypes } from '../../../core/typescript/types.ts';
import type { TypesLocation } from '../../../core/typescript/types.ts';
import { fixturePath } from '../../fixtures.ts';

/**
 * The facts a project declaration is built from, with everything empty unless a test says otherwise
 *
 * @param facts - What this test cares about
 * @returns {ProjectFacts} The full set
 */
function facts (facts: Partial<ProjectFacts> = {}): ProjectFacts {
	return {
		type: 'alloy',
		config: { values: {}, dependencies: [] },
		translationKeys: [],
		controllers: [],
		models: [],
		widgets: [],
		...facts
	};
}

/**
 * The stub the classic fixture installs
 *
 * @returns {Promise<TypesLocation>} Where it lives
 */
async function stubTypes (): Promise<TypesLocation> {
	const project = new Project(await fixturePath('classic-project'));
	await project.load();

	const located = await new ProjectTypes().locate(project);
	assert.ok(located?.location, 'the classic fixture should carry the stubbed types');

	return located.location;
}

/**
 * Compiles declarations alongside the Titanium types and answers the errors in them.
 *
 * An error here is a member that resolves to nothing in every editor, so this is the assertion
 * that matters most about generated TypeScript.
 *
 * @param sources - Each generated declaration, by a name to give it
 * @returns {Promise<string[]>} The messages, which should be none
 */
async function errorsIn (sources: Record<string, string>): Promise<string[]> {
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

	const program = ts.createProgram([ types.entry, ...Object.keys(files) ], { noEmit: true, strict: true, types: [] }, host);

	return [ ...program.getSemanticDiagnostics(), ...program.getSyntacticDiagnostics() ]
		.filter(diagnostic => diagnostic.file && diagnostic.file.fileName in files)
		.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
}

describe('The project declaration', () => {

	describe('Alloy.CFG', () => {

		it('should carry the configured keys, with the types they were written as', () => {
			const text = generateProjectDeclaration(facts({
				config: { values: { test: 'value', retries: 3, debug: true }, dependencies: [] }
			}));

			assert.match(text, /test: string;/);
			assert.match(text, /retries: number;/);
			assert.match(text, /debug: boolean;/);
		});

		it('should widen a value to its type rather than pinning it to what is configured', () => {
			// the value differs per environment and per build; the type does not. Pinning `"value"`
			// would make a comparison against anything else an error in the user's editor
			const text = generateProjectDeclaration(facts({
				config: { values: { test: 'value' }, dependencies: [] }
			}));

			assert.doesNotMatch(text, /test: "value"/);
		});

		it('should nest an object rather than flattening it', () => {
			const text = generateProjectDeclaration(facts({
				config: { values: { api: { base: 'https://example.com', timeout: 30 } }, dependencies: [] }
			}));

			assert.match(text, /api: \{\s*base: string;\s*timeout: number;\s*\};/);
		});

		it('should quote a key that is not a plain identifier', () => {
			const text = generateProjectDeclaration(facts({
				config: { values: { 'a-key': 1, 'fine': 2 }, dependencies: [] }
			}));

			assert.match(text, /"a-key": number;/);
			assert.match(text, /\bfine: number;/);
		});

		it('should answer an empty configuration as an empty CFG rather than leaving it out', () => {
			// Alloy.CFG exists whether or not anything is configured, and a missing member reads to
			// the user as a broken server rather than as an empty config.json
			assert.match(generateProjectDeclaration(facts()), /const CFG:/);
		});

		it('should describe an array and a null without inventing a shape for them', () => {
			const text = generateProjectDeclaration(facts({
				config: { values: { list: [ 1, 2 ], nothing: null }, dependencies: [] }
			}));

			assert.match(text, /list: unknown\[\];/);
			assert.match(text, /nothing: null;/);
		});
	});

	describe('the create functions', () => {

		it('should offer the controllers, models and widgets the project has', () => {
			const text = generateProjectDeclaration(facts({
				controllers: [ 'index', 'folder/nested' ],
				models: [ 'todo' ],
				widgets: [ 'widget-test' ]
			}));

			assert.match(text, /function createController \(name: 'index' \| 'folder\/nested'/);
			assert.match(text, /function createModel \(name: 'todo'/);
			assert.match(text, /function createCollection \(name: 'todo'/);
			assert.match(text, /function createWidget \(name: 'widget-test'/);
		});

		it('should take a collection name from the models, because that is where one comes from', () => {
			const text = generateProjectDeclaration(facts({ models: [ 'todo', 'user' ] }));

			assert.match(text, /function createCollection \(name: 'todo' \| 'user'/);
		});

		it('should keep a plain string overload beside the names it knows', () => {
			// a name the project does not have yet is something the user is about to create, not a
			// mistake. Without the second overload the server would put an error on it
			const text = generateProjectDeclaration(facts({ controllers: [ 'index' ] }));

			assert.match(text, /function createController \(name: string,/);
		});

		it('should take only the string overload when the project has none of a kind', () => {
			// an empty union is `never`, which would make every call an error
			const text = generateProjectDeclaration(facts());

			assert.doesNotMatch(text, /createController \(name: '/);
			assert.match(text, /function createController \(name: string,/);
		});
	});

	describe('L', () => {

		it('should offer the translation keys', () => {
			const text = generateProjectDeclaration(facts({ translationKeys: [ 'test', 'welcome.title' ] }));

			assert.match(text, /function L \(key: 'test' \| 'welcome\.title', hint\?: string\): string;/);
		});

		it('should be declared for a classic project too, since L is a Titanium global', () => {
			const text = generateProjectDeclaration(facts({ type: 'classic', config: undefined, translationKeys: [ 'test' ] }));

			assert.match(text, /function L \(key: 'test'/);
		});

		it('should keep a plain string overload, so an untranslated key is not an error', () => {
			const text = generateProjectDeclaration(facts({ translationKeys: [ 'test' ] }));

			assert.match(text, /declare function L \(key: string, hint\?: string\): string;/);
		});

		it('should say nothing at all about L when the project has no translations', () => {
			assert.doesNotMatch(generateProjectDeclaration(facts()), /function L \(/);
		});
	});

	describe('for a classic project', () => {

		it('should declare no Alloy namespace, because classic has no Alloy', () => {
			const text = generateProjectDeclaration(facts({ type: 'classic', config: undefined, translationKeys: [ 'test' ] }));

			assert.doesNotMatch(text, /namespace Alloy/);
		});

		it('should be empty when there is nothing to say', () => {
			assert.equal(generateProjectDeclaration(facts({ type: 'classic', config: undefined })).trim(), '');
		});
	});

	describe('as TypeScript', () => {

		it('should typecheck clean against the Titanium types', async () => {
			const text = generateProjectDeclaration(facts({
				config: { values: { test: 'value', api: { base: 'x' } }, dependencies: [] },
				translationKeys: [ 'test', 'welcome.title' ],
				controllers: [ 'index' ],
				models: [ 'todo' ],
				widgets: [ 'widget-test' ]
			}));

			assert.deepEqual(await errorsIn({ 'project.d.ts': text }), []);
		});

		it('should not make a name the project does not have an error', async () => {
			// the overload pair is what buys this, and it is the whole reason for the second one
			const text = generateProjectDeclaration(facts({
				translationKeys: [ 'test' ],
				controllers: [ 'index' ]
			}));
			const usage = [
				'const a = Alloy.createController(\'notYetWritten\');',
				'const b = L(\'notYetTranslated\');',
				'const c = Alloy.CFG;'
			].join('\n');

			assert.deepEqual(await errorsIn({ 'project.d.ts': text, 'usage.ts': usage }), []);
		});
	});
});

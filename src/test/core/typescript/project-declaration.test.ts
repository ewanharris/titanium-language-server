import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateProjectDeclaration } from '../../../core/typescript/project-declaration.ts';
import type { ProjectFacts } from '../../../core/typescript/project-declaration.ts';
import type { AlloyFacts } from '../../../core/typescript/alloy-declaration.ts';
import { errorsIn } from './compile.ts';

/**
 * The Alloy half of the facts, empty unless a test says otherwise
 *
 * @param overrides - What this test cares about
 * @returns {AlloyFacts} The full set
 */
function alloy (overrides: Partial<AlloyFacts> = {}): AlloyFacts {
	return { config: { values: {}, dependencies: [] }, controllers: [], models: [], widgets: [], ...overrides };
}

/**
 * The facts for an Alloy project, empty unless a test says otherwise.
 *
 * A classic project is `{ alloy: undefined }`, and there is no other way to write one — which is
 * the point of the shape.
 *
 * @param overrides - What this test cares about
 * @returns {ProjectFacts} The full set
 */
function facts (overrides: Partial<ProjectFacts> = {}): ProjectFacts {
	return { translationKeys: [], alloy: alloy(), ...overrides };
}

describe('The project declaration', () => {

	describe('for a classic project', () => {

		it('should declare no Alloy namespace, because classic has no Alloy', () => {
			const text = generateProjectDeclaration({ translationKeys: [ 'test' ], alloy: undefined });

			assert.doesNotMatch(text, /namespace Alloy/);
		});

		it('should still declare L, because translations are not Alloy\'s', () => {
			// classic keeps them in i18n/ beside tiapp.xml rather than under app/, and an
			// implementation that treated i18n as Alloy's would answer nothing for half its projects
			const text = generateProjectDeclaration({ translationKeys: [ 'classicOnly' ], alloy: undefined });

			assert.match(text, /function L \(key: 'classicOnly'/);
		});

		it('should be empty when there is nothing to say', () => {
			assert.equal(generateProjectDeclaration({ translationKeys: [], alloy: undefined }), '');
		});
	});

	describe('for an Alloy project', () => {

		it('should carry both halves', () => {
			const text = generateProjectDeclaration(facts({
				translationKeys: [ 'test' ],
				alloy: alloy({ controllers: [ 'index' ] })
			}));

			assert.match(text, /namespace Alloy/, 'expected the Alloy half');
			assert.match(text, /function L \(key: 'test'/, 'expected the Titanium half');
		});

		it('should declare the namespace even with nothing configured, since Alloy.CFG still exists', () => {
			assert.match(generateProjectDeclaration(facts()), /namespace Alloy/);
		});
	});

	describe('as TypeScript', () => {

		it('should typecheck clean against the Titanium types and the Alloy library', async () => {
			const text = generateProjectDeclaration(facts({
				translationKeys: [ 'test', 'welcome.title' ],
				alloy: alloy({
					config: { values: { test: 'value', api: { base: 'x' } }, dependencies: [] },
					controllers: [ 'index' ],
					models: [ 'todo' ],
					widgets: [ 'widget-test' ]
				})
			}));

			assert.deepEqual(await errorsIn({ 'project.d.ts': text }), []);
		});

		it('should typecheck clean for a classic project too', async () => {
			const text = generateProjectDeclaration({ translationKeys: [ 'test' ], alloy: undefined });

			assert.deepEqual(await errorsIn({ 'project.d.ts': text }), []);
		});

		it('should not make a name the project does not have an error', async () => {
			// the overload pair is what buys this, and it is the whole reason for the second one
			const text = generateProjectDeclaration(facts({
				translationKeys: [ 'test' ],
				alloy: alloy({ controllers: [ 'index' ] })
			}));
			const usage = [
				'const a = Alloy.createController(\'notYetWritten\');',
				'const b = L(\'notYetTranslated\');',
				'const c = Alloy.CFG;'
			].join('\n');

			assert.deepEqual(await errorsIn({ 'project.d.ts': text, 'usage.ts': usage }), []);
		});

		it('should resolve the runtime types the shipped library declares', async () => {
			// the generated half names Controller, Model and Collection without declaring any of
			// them: assets/alloy.d.ts is what does, and the two only mean anything together
			const text = generateProjectDeclaration(facts({ alloy: alloy({ controllers: [ 'index' ], models: [ 'todo' ] }) }));
			const usage = [
				'const c: Alloy.Controller = Alloy.createController(\'index\');',
				'const view = c.getView();',
				'const m: Alloy.Model = Alloy.createModel(\'todo\');',
				'const id: string | number = m.id;'
			].join('\n');

			assert.deepEqual(await errorsIn({ 'project.d.ts': text, 'usage.ts': usage }), []);
		});
	});
});

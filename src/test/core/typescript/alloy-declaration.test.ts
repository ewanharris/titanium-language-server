import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { alloyDeclaration } from '../../../core/typescript/alloy-declaration.ts';
import type { AlloyFacts } from '../../../core/typescript/alloy-declaration.ts';

/**
 * The Alloy facts, with everything empty unless a test says otherwise
 *
 * @param overrides - What this test cares about
 * @returns {AlloyFacts} The full set
 */
function alloy (overrides: Partial<AlloyFacts> = {}): AlloyFacts {
	return {
		config: { values: {}, dependencies: [] },
		controllers: [],
		models: [],
		widgets: [],
		...overrides
	};
}

describe('What an Alloy project declares', () => {

	describe('Alloy.CFG', () => {

		it('should carry the configured keys, with the types they were written as', () => {
			const text = alloyDeclaration(alloy({ config: { values: { test: 'value', retries: 3, debug: true }, dependencies: [] } }));

			assert.match(text, /test: string;/);
			assert.match(text, /retries: number;/);
			assert.match(text, /debug: boolean;/);
		});

		it('should widen a value to its type rather than pinning it to what is configured', () => {
			// the value differs per environment and per build; the type does not. Pinning `"value"`
			// would make a comparison against anything else an error in the user's editor
			const text = alloyDeclaration(alloy({ config: { values: { test: 'value' }, dependencies: [] } }));

			assert.doesNotMatch(text, /test: "value"/);
		});

		it('should nest an object rather than flattening it', () => {
			const text = alloyDeclaration(alloy({ config: { values: { api: { base: 'https://example.com', timeout: 30 } }, dependencies: [] } }));

			assert.match(text, /api: \{\s*base: string;\s*timeout: number;\s*\};/);
		});

		it('should quote a key that is not a plain identifier', () => {
			const text = alloyDeclaration(alloy({ config: { values: { 'a-key': 1, 'fine': 2 }, dependencies: [] } }));

			assert.match(text, /"a-key": number;/);
			assert.match(text, /\bfine: number;/);
		});

		it('should answer an empty configuration as an empty CFG rather than leaving it out', () => {
			// Alloy.CFG exists whether or not anything is configured, and a missing member reads to
			// the user as a broken server rather than as an empty config.json
			assert.match(alloyDeclaration(alloy()), /const CFG:/);
		});

		it('should describe an array and a null without inventing a shape for them', () => {
			const text = alloyDeclaration(alloy({ config: { values: { list: [ 1, 2 ], nothing: null }, dependencies: [] } }));

			assert.match(text, /list: unknown\[\];/);
			assert.match(text, /nothing: null;/);
		});
	});

	describe('the create functions', () => {

		it('should offer the controllers, models and widgets the project has', () => {
			const text = alloyDeclaration(alloy({
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
			assert.match(alloyDeclaration(alloy({ models: [ 'todo', 'user' ] })), /function createCollection \(name: 'todo' \| 'user'/);
		});

		it('should keep a plain string overload beside the names it knows', () => {
			// a name the project does not have yet is something the user is about to create, not a
			// mistake. Without the second overload the server would put an error on it
			assert.match(alloyDeclaration(alloy({ controllers: [ 'index' ] })), /function createController \(name: string,/);
		});

		it('should take only the string overload when the project has none of a kind', () => {
			// an empty union is `never`, which would make every call an error
			const text = alloyDeclaration(alloy());

			assert.doesNotMatch(text, /createController \(name: '/);
			assert.match(text, /function createController \(name: string,/);
		});
	});

	it('should not declare the runtime types, which ship as a library rather than generated', () => {
		// assets/alloy.d.ts declares Controller, Model and Collection. Declaring them here too
		// would be the same interface declared twice, which is an error rather than a merge
		const text = alloyDeclaration(alloy({ controllers: [ 'index' ] }));

		assert.doesNotMatch(text, /interface Controller/);
		assert.doesNotMatch(text, /interface Model\b/);
		assert.match(text, /\): Controller;/, 'but it still names them');
	});

	it('should say nothing about L, which is not Alloy\'s', () => {
		// L is a Titanium global and a classic project has translations too, so it is declared by
		// the Titanium half — keeping it here is what made this look Alloy-only
		assert.doesNotMatch(alloyDeclaration(alloy()), /function L \(/);
	});
});

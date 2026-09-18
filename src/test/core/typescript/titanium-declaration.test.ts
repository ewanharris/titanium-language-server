import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { titaniumDeclaration } from '../../../core/typescript/titanium-declaration.ts';

describe('What every Titanium project declares', () => {

	it('should offer the translation keys to L', () => {
		const text = titaniumDeclaration([ 'test', 'welcome.title' ]);

		assert.match(text, /function L \(key: 'test' \| 'welcome\.title', hint\?: string\): string;/);
	});

	it('should keep a plain string overload, so an untranslated key is not an error', () => {
		// a key is often written before the string is added, and an error on it would be wrong
		assert.match(titaniumDeclaration([ 'test' ]), /declare function L \(key: string, hint\?: string\): string;/);
	});

	it('should put the keys first, which is what makes them the completion', () => {
		const text = titaniumDeclaration([ 'test' ]);

		assert.ok(text.indexOf('\'test\'') < text.indexOf('key: string'), 'expected the union overload first');
	});

	it('should say nothing at all when the project has no translations', () => {
		assert.equal(titaniumDeclaration([]), '');
	});

	it('should escape a key that would break the declaration', () => {
		// a key comes out of a strings.xml and may legally contain a quote; a syntax error in the
		// declaration takes every answer down with it
		assert.match(titaniumDeclaration([ 'it\'s' ]), /'it\\'s'/);
	});
});

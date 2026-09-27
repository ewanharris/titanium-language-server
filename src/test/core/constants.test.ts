import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { constantsFor, CONSTANT_RULES } from '../../core/constants.ts';

/**
 * The constants a project's types declare, by namespace, as `ProjectService.constantsOf` answers
 * them — names only, since that is all the expansion reads
 */
const declared: Record<string, string[]> = {
	'Titanium.UI': [ 'FILL', 'SIZE', 'TEXT_ALIGNMENT_CENTER', 'TEXT_ALIGNMENT_LEFT', 'TEXT_ALIGNMENT_RIGHT', 'KEYBOARD_TYPE_EMAIL', 'KEYBOARD_APPEARANCE_DARK' ],
	'Titanium.Media': [ 'IMAGE_SCALING_ASPECT_FIT', 'VIDEO_SCALING_RESIZE' ]
};

const available = (namespace: string): string[] => declared[namespace] ?? [];

describe('The constants a property takes', () => {

	it('should expand a wildcard over what the project\'s types declare', () => {
		assert.deepEqual(constantsFor('textAlign', [ 'Titanium.UI.Label' ], available), [
			'Ti.UI.TEXT_ALIGNMENT_CENTER',
			'Ti.UI.TEXT_ALIGNMENT_LEFT',
			'Ti.UI.TEXT_ALIGNMENT_RIGHT'
		]);
	});

	it('should write each one the way a stylesheet does, under Ti rather than Titanium', () => {
		assert.ok(constantsFor('width', [ 'Titanium.UI.View' ], available).every(name => name.startsWith('Ti.UI.')));
	});

	it('should offer a named constant only when the project\'s types declare it', () => {
		// a project on an older SDK is never offered a constant its SDK does not have
		assert.deepEqual(constantsFor('width', [ 'Titanium.UI.View' ], available), [ 'Ti.UI.FILL', 'Ti.UI.SIZE' ]);
		assert.deepEqual(constantsFor('width', [ 'Titanium.UI.View' ], () => [ 'SIZE' ]), [ 'Ti.UI.SIZE' ]);
	});

	it('should choose by type where two types take different constants for one property', () => {
		assert.deepEqual(constantsFor('scalingMode', [ 'Titanium.UI.ImageView' ], available), [ 'Ti.Media.IMAGE_SCALING_ASPECT_FIT' ]);
		assert.deepEqual(constantsFor('scalingMode', [ 'Titanium.Media.VideoPlayer' ], available), [ 'Ti.Media.VIDEO_SCALING_RESIZE' ]);
	});

	it('should offer the constants of every type given, once each', () => {
		// a class used on both an ImageView and a VideoPlayer
		const names = constantsFor('scalingMode', [ 'Titanium.UI.ImageView', 'Titanium.Media.VideoPlayer', 'Titanium.UI.ImageView' ], available);

		assert.deepEqual(names, [ 'Ti.Media.IMAGE_SCALING_ASPECT_FIT', 'Ti.Media.VIDEO_SCALING_RESIZE' ]);
	});

	it('should not sweep in a neighbouring family that shares a prefix', () => {
		// TextArea's apidoc says KEYBOARD_*, which would take KEYBOARD_APPEARANCE_DARK as well
		assert.deepEqual(constantsFor('keyboardType', [ 'Titanium.UI.TextArea' ], available), [ 'Ti.UI.KEYBOARD_TYPE_EMAIL' ]);
	});

	it('should answer nothing for a property it has no constants for', () => {
		assert.deepEqual(constantsFor('text', [ 'Titanium.UI.Label' ], available), []);
		assert.deepEqual(constantsFor('constructor', [ 'Titanium.UI.Label' ], available), []);
	});

	it('should answer nothing for a type-restricted property on a type it does not name', () => {
		assert.deepEqual(constantsFor('scalingMode', [ 'Titanium.UI.Label' ], available), []);
	});

	it('should cite the apidoc file every rule was transcribed from', () => {
		for (const rule of CONSTANT_RULES) {
			assert.match(rule.source, /^apidoc\/Titanium\/.+\.yml$/, `${rule.property} has no source`);
		}
	});
});

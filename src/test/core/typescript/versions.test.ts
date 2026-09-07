import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { majorOf, selectTypesVersion } from '../../../core/typescript/versions.ts';

/** The majors DefinitelyTyped actually publishes, per `npm view @types/titanium versions` */
const published = [
	'3.5.30',
	'7.3.1',
	'8.0.5',
	'9.2.2',
	'12.0.8',
	'13.3.0'
];

describe('Types version resolution', () => {

	describe('reading the tiapp sdk-version', () => {
		it('should read the major from a GA version', () => {
			assert.equal(majorOf('12.4.0.GA'), 12);
		});

		it('should read the major from a version with no qualifier', () => {
			assert.equal(majorOf('10.1.0'), 10);
		});

		it('should read the major from a nightly qualifier', () => {
			// a build from master carries a timestamp rather than GA
			assert.equal(majorOf('13.0.0.v20240117144104'), 13);
		});

		it('should not read a major from something that is not a version', () => {
			assert.equal(majorOf('latest'), undefined);
		});

		it('should not read a major from an empty version', () => {
			assert.equal(majorOf(''), undefined);
		});
	});

	describe('selecting a types version', () => {
		it('should take the newest release of the SDK major when one is published', () => {
			// the types trail the SDK even on a supported major: 12.4.0 SDK, 12.0.8 types
			const selection = selectTypesVersion('12.4.0.GA', published);

			assert.equal(selection.version, '12.0.8');
			assert.equal(selection.kind, 'matched');
		});

		it('should fall back to the nearest major below when the SDK major is not published', () => {
			// there is no 10.x or 11.x on DefinitelyTyped, so a 10.x project lands on 9.2.2
			const selection = selectTypesVersion('10.1.0.GA', published);

			assert.equal(selection.version, '9.2.2');
			assert.equal(selection.kind, 'older-major');
		});

		it('should fall back across more than one missing major', () => {
			const selection = selectTypesVersion('11.1.0.GA', published);

			assert.equal(selection.version, '9.2.2');
			assert.equal(selection.kind, 'older-major');
		});

		it('should take the newest published major when the SDK is newer than anything published', () => {
			const selection = selectTypesVersion('14.0.0.GA', published);

			assert.equal(selection.version, '13.3.0');
			assert.equal(selection.kind, 'older-major');
		});

		it('should resolve nothing when every published major is above the SDK', () => {
			// nearest-at-or-below has no answer below the floor, and a newer major is not a
			// substitute: the API is additive, so 3.x types would offer a 2.x project methods it
			// does not have
			const selection = selectTypesVersion('2.0.0.GA', published);

			assert.equal(selection.version, undefined);
			assert.equal(selection.kind, 'none');
		});

		it('should resolve nothing when nothing is published at all', () => {
			const selection = selectTypesVersion('12.4.0.GA', []);

			assert.equal(selection.version, undefined);
			assert.equal(selection.kind, 'none');
		});

		it('should resolve nothing when the sdk-version cannot be read', () => {
			const selection = selectTypesVersion('not-a-version', published);

			assert.equal(selection.version, undefined);
			assert.equal(selection.kind, 'none');
		});

		it('should compare versions numerically rather than as strings', () => {
			// '9.2.2' sorts above '13.3.0' as a string, and '8.0.5' above '10.0.0'
			const selection = selectTypesVersion('13.0.0.GA', [ '9.2.2', '13.3.0', '13.10.0', '13.9.0' ]);

			assert.equal(selection.version, '13.10.0');
			assert.equal(selection.kind, 'matched');
		});

		it('should ignore prereleases, which DefinitelyTyped does not publish for consumption', () => {
			const selection = selectTypesVersion('13.0.0.GA', [ '13.3.0', '13.4.0-beta.1' ]);

			assert.equal(selection.version, '13.3.0');
			assert.equal(selection.kind, 'matched');
		});

		it('should report the SDK version it was asked about, so the message can name it', () => {
			const selection = selectTypesVersion('10.1.0.GA', published);

			assert.equal(selection.sdkVersion, '10.1.0.GA');
		});
	});
});

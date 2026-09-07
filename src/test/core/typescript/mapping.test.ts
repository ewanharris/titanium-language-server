import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GeneratedMapping, IdentityMapping } from '../../../core/typescript/mapping.ts';

describe('Position mapping', () => {

	describe('a real file', () => {
		const map = new IdentityMapping('/project/app/controllers/index.js');

		it('should map a position to itself', () => {
			assert.deepEqual(map.position(42), { path: '/project/app/controllers/index.js', offset: 42 });
		});

		it('should map a range to itself', () => {
			assert.deepEqual(map.range({ start: 10, end: 20 }), {
				path: '/project/app/controllers/index.js',
				range: { start: 10, end: 20 }
			});
		});

		it('should not claim to be generated', () => {
			assert.equal(map.generated, false);
		});
	});

	describe('generated content', () => {
		// the shape #13 produces: a declaration whose only real positions are the ids, which came
		// from `id="..."` attributes in the view
		//
		//   interface IndexViews {\n\t"label": Titanium.UI.Label;\n}
		//   0                     22    28
		const map = new GeneratedMapping('/project/app/views/index.xml', [
			// the `label` inside the generated declaration came from the view's id attribute
			{ generated: { start: 24, length: 5 }, source: { start: 17 } }
		]);

		it('should say it is generated, so nothing treats its offsets as file offsets', () => {
			assert.equal(map.generated, true);
		});

		it('should map a position inside a segment back to the source', () => {
			assert.deepEqual(map.position(24), { path: '/project/app/views/index.xml', offset: 17 });
		});

		it('should map an offset part way through a segment', () => {
			// the cursor lands mid-identifier, and the answer should land mid-identifier too
			assert.deepEqual(map.position(26), { path: '/project/app/views/index.xml', offset: 19 });
		});

		it('should map the position just past the end of a segment, which is where a range ends', () => {
			assert.deepEqual(map.position(29), { path: '/project/app/views/index.xml', offset: 22 });
		});

		it('should map nothing for a position in generated scaffolding', () => {
			// `interface IndexViews {` corresponds to nothing anyone wrote, so pointing an editor
			// at it would jump the user somewhere arbitrary in their view
			assert.equal(map.position(3), undefined);
		});

		it('should map nothing for a position past the end of every segment', () => {
			assert.equal(map.position(500), undefined);
		});

		it('should map a range that sits inside one segment', () => {
			assert.deepEqual(map.range({ start: 24, end: 29 }), {
				path: '/project/app/views/index.xml',
				range: { start: 17, end: 22 }
			});
		});

		it('should map nothing for a range that starts in scaffolding', () => {
			assert.equal(map.range({ start: 0, end: 29 }), undefined);
		});

		it('should clamp a range that runs off the end of its segment', () => {
			// better to point at the identifier than to refuse, and better than pointing at text
			// after it that the segment does not describe
			assert.deepEqual(map.range({ start: 26, end: 400 }), {
				path: '/project/app/views/index.xml',
				range: { start: 19, end: 22 }
			});
		});

		it('should map an empty range at a segment boundary', () => {
			assert.deepEqual(map.range({ start: 24, end: 24 }), {
				path: '/project/app/views/index.xml',
				range: { start: 17, end: 17 }
			});
		});
	});

	describe('several segments', () => {
		const map = new GeneratedMapping('/project/app/views/index.xml', [
			{ generated: { start: 10, length: 3 }, source: { start: 100 } },
			{ generated: { start: 40, length: 4 }, source: { start: 200 } }
		]);

		it('should map into the first segment', () => {
			assert.deepEqual(map.position(11), { path: '/project/app/views/index.xml', offset: 101 });
		});

		it('should map into the second segment', () => {
			assert.deepEqual(map.position(41), { path: '/project/app/views/index.xml', offset: 201 });
		});

		it('should map nothing for the gap between them', () => {
			assert.equal(map.position(25), undefined);
		});

		it('should not run the two together when a range spans the gap', () => {
			// a range covering both would describe text in the view that is not what was asked about
			assert.deepEqual(map.range({ start: 11, end: 42 }), {
				path: '/project/app/views/index.xml',
				range: { start: 101, end: 103 }
			});
		});
	});

	describe('no segments at all', () => {
		// a view that failed to parse yields a declaration with nothing mappable in it, and that
		// has to answer nothing rather than throw
		const map = new GeneratedMapping('/project/app/views/broken.xml', []);

		it('should map no position', () => {
			assert.equal(map.position(0), undefined);
		});

		it('should map no range', () => {
			assert.equal(map.range({ start: 0, end: 1 }), undefined);
		});
	});
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { URI } from 'vscode-uri';
import { offsetAt, toLocation, toPath, toUri } from '../../server/convert.js';

describe('Converting between core and the protocol', () => {

	describe('paths and URIs', () => {
		it('should round trip a path', () => {
			const filePath = path.join(path.sep, 'projects', 'app', 'app', 'views', 'index.xml');

			assert.equal(toPath(toUri(filePath)), filePath);
		});

		it('should decode a URI the client encoded', () => {
			const filePath = path.join(path.sep, 'my projects', 'index.xml');

			assert.equal(toPath(URI.file(filePath).toString()), filePath);
		});
	});

	describe('offsets and positions', () => {
		it('should find the offset of a position', () => {
			const text = '<Alloy>\n\t<Window class="container"/>\n</Alloy>';

			assert.equal(offsetAt(text, { line: 1, character: 17 }), text.indexOf('container') + 1);
		});

		it('should count a CRLF as the line break it is', () => {
			// a view saved on Windows is two characters per line ending, not one
			assert.equal(offsetAt('a\r\nb', { line: 1, character: 0 }), 3);
		});

		it('should turn a range into positions', () => {
			const text = '".container": {\n\tbackgroundColor: "white"\n}';

			const location = toLocation(text, { path: path.join(path.sep, 'a', 'index.tss'), range: { start: 17, end: 32 } });

			assert.equal(location.uri, toUri(path.join(path.sep, 'a', 'index.tss')));
			assert.deepEqual(location.range, { start: { line: 1, character: 1 }, end: { line: 1, character: 16 } });
		});
	});
});

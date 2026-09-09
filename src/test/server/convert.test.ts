import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { URI } from 'vscode-uri';
import { InsertTextFormat } from 'vscode-languageserver';
import { offsetAt, toCompletionItem, toLocation, toPath, toUri } from '../../server/convert.ts';

describe('Converting between core and the protocol', () => {

	describe('paths and URIs', () => {
		it('should round trip a path', () => {
			const filePath = path.join(path.sep, 'projects', 'app', 'app', 'views', 'index.xml');

			assert.equal(toPath(toUri(filePath)), filePath);
		});

		it('should give a Windows drive letter the case the rest of the platform uses', () => {
			// fsPath lower cases the drive where cwd and import.meta.dirname upper case it, and the
			// registry compares the two as strings. Only the separator is platform specific — a
			// drive shaped path is recognised as one everywhere, so this is not a Windows only test
			assert.equal(
				toPath('file:///d%3A/projects/app/tiapp.xml'),
				process.platform === 'win32' ? 'D:\\projects\\app\\tiapp.xml' : 'D:/projects/app/tiapp.xml'
			);
		});

		it('should leave a path that has no drive letter alone', () => {
			assert.equal(toPath(toUri(path.join(path.sep, 'projects', 'app'))), path.join(path.sep, 'projects', 'app'));
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
	describe('completions', () => {

		it('should insert the label when a completion offers no forms of its own', () => {
			const item = toCompletionItem({ label: 'backgroundColor' }, true);

			assert.equal(item.label, 'backgroundColor');
			assert.equal(item.insertText, undefined);
			assert.equal(item.insertTextFormat, undefined);
		});

		it('should insert the snippet when the client has an engine for it', () => {
			const item = toCompletionItem({
				label: 'backgroundColor',
				insert: { snippet: 'backgroundColor="$1"$0', plain: 'backgroundColor="' }
			}, true);

			assert.equal(item.insertText, 'backgroundColor="$1"$0');
			assert.equal(item.insertTextFormat, InsertTextFormat.Snippet);
		});

		it('should insert the plain form when the client has none', () => {
			// the whole point of the issue: without this the user gets a literal ${1} and $0 in
			// their file, which is worse than the completion not being offered at all
			const item = toCompletionItem({
				label: 'backgroundColor',
				insert: { snippet: 'backgroundColor="$1"$0', plain: 'backgroundColor="' }
			}, false);

			assert.equal(item.insertText, 'backgroundColor="');
			assert.equal(item.insertTextFormat, InsertTextFormat.PlainText);
		});

		it('should never leave a tab stop in what a plain client is given', () => {
			// a site whose plain form was written carelessly is the same bug arriving by another
			// route, so the shape of the fallback is asserted rather than assumed
			const sites = [
				{ snippet: 'backgroundColor="$1"$0', plain: 'backgroundColor="' },
				{ snippet: 'Label$1>$2</Label>', plain: 'Label' },
				{ snippet: 'doClick($1)$0', plain: 'doClick(' },
				{ snippet: 'color: {\n\t${1}\t\n}', plain: 'color: ' }
			];

			for (const insert of sites) {
				const item = toCompletionItem({ label: 'x', insert }, false);

				assert.equal(item.insertTextFormat, InsertTextFormat.PlainText);
				assert.doesNotMatch(String(item.insertText), /\$\{?\d/, `${insert.plain} carries a tab stop`);
			}
		});

		it('should carry the detail and documentation through either way', () => {
			for (const snippets of [ true, false ]) {
				const item = toCompletionItem({
					label: 'x',
					detail: 'a detail',
					documentation: 'some documentation',
					insert: { snippet: 'x$1', plain: 'x' }
				}, snippets);

				assert.equal(item.detail, 'a detail');
				assert.equal(item.documentation, 'some documentation');
			}
		});
	});
});

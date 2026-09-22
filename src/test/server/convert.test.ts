import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { URI } from 'vscode-uri';
import { CompletionItemKind, InsertTextFormat, MarkupKind } from 'vscode-languageserver';
import { offsetAt, toCompletionItem, toCompletionKind, toLocation, toMarkup, toPath, toUri, toViewHoverMarkup } from '../../server/convert.ts';

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

	describe('completion item kinds', () => {

		/** Everything the protocol had before the enumeration grew, which is what an old client gets */
		const original = new Set<CompletionItemKind>(
			Object.values(CompletionItemKind).filter((kind): kind is CompletionItemKind => typeof kind === 'number' && kind <= CompletionItemKind.Reference)
		);
		const everything = new Set<CompletionItemKind>(
			Object.values(CompletionItemKind).filter((kind): kind is CompletionItemKind => typeof kind === 'number')
		);

		it('should send TypeScript\'s kind as the protocol\'s', () => {
			assert.equal(toCompletionKind('method', everything), CompletionItemKind.Method);
			assert.equal(toCompletionKind('interface', everything), CompletionItemKind.Interface);
		});

		it('should send a kind the client cannot know as one it can', () => {
			// a client that declares no value set "only supports the kinds from Text to Reference",
			// and an integer past that is an icon it has nothing for
			assert.equal(toCompletionKind('const', everything), CompletionItemKind.Constant);
			assert.equal(toCompletionKind('const', original), CompletionItemKind.Variable);
			assert.equal(toCompletionKind('enum member', original), CompletionItemKind.Value);
			assert.equal(toCompletionKind('directory', original), CompletionItemKind.Module);
			assert.equal(toCompletionKind('type parameter', original), CompletionItemKind.Class);
		});

		it('should send no kind at all rather than one the client never declared', () => {
			// omitting it lets the client pick its own default, which beats an icon saying the
			// wrong thing about what the entry is
			assert.equal(toCompletionKind('method', new Set([ CompletionItemKind.Text ])), undefined);
		});

		it('should send no kind for a kind it has no mapping for', () => {
			// TypeScript's list is longer than the useful part of it, and grows
			assert.equal(toCompletionKind('warning', everything), undefined);
			assert.equal(toCompletionKind('', everything), undefined);
		});
	});

	describe('hover markup', () => {

		it('should fence the signature for a client that renders markdown', () => {
			const markup = toMarkup({ text: 'const win: Window', documentation: 'A window' }, true);

			assert.equal(markup.kind, MarkupKind.Markdown);
			assert.equal(markup.value, '```typescript\nconst win: Window\n```\n\nA window');
		});

		it('should send the same words as plain text to a client that does not', () => {
			// the backticks are what such a client would show, so they are not sent
			const markup = toMarkup({ text: 'const win: Window', documentation: 'A window' }, false);

			assert.equal(markup.kind, MarkupKind.PlainText);
			assert.equal(markup.value, 'const win: Window\n\nA window');
		});

		it('should leave out the half that is empty rather than the blank line for it', () => {
			assert.equal(toMarkup({ text: '', documentation: 'A window' }, true).value, 'A window');
			assert.equal(toMarkup({ text: 'const win: Window', documentation: '' }, true).value, '```typescript\nconst win: Window\n```');
			assert.equal(toMarkup({ text: '', documentation: 'A window' }, false).value, 'A window');
		});
	});

	describe('hover markup in a view', () => {
		const range = { start: 0, end: 1 };
		const image = { file: '/p/app/assets/images/logo.png', bytes: 73, width: 3, height: 2, dataUri: 'data:image/png;base64,AAAA' };

		it('should render the signature and documentation the way script hover does', () => {
			const markup = toViewHoverMarkup({ range, signature: 'Titanium.UI.Label', documentation: 'A label' }, true);

			assert.equal(markup.value, '```typescript\nTitanium.UI.Label\n```\n\nA label');
		});

		it('should embed an image with its dimensions and size beneath it', () => {
			const markup = toViewHoverMarkup({ range, image }, true);

			assert.equal(markup.value, '![logo.png](data:image/png;base64,AAAA)\n\n3 × 2 · 73 B');
		});

		it('should say an image is too large rather than embed it', () => {
			const markup = toViewHoverMarkup({ range, image: { file: '/p/test.png', bytes: 211013, width: 1024, height: 1024 } }, true);

			assert.equal(markup.value, '1024 × 1024 · 206.1 KB, too large to preview');
		});

		it('should leave out dimensions it could not read', () => {
			const markup = toViewHoverMarkup({ range, image: { file: '/p/banner.jpg', bytes: 17, dataUri: 'data:image/jpeg;base64,AA' } }, true);

			assert.equal(markup.value, '![banner.jpg](data:image/jpeg;base64,AA)\n\n17 B');
		});

		it('should describe an image in words to a client without markdown, which cannot show it', () => {
			const markup = toViewHoverMarkup({ range, image }, false);

			assert.equal(markup.kind, MarkupKind.PlainText);
			assert.equal(markup.value, 'Image: 3 × 2 · 73 B');
		});

		it('should list a key\'s translations, escaped so a value cannot become markup', () => {
			const markup = toViewHoverMarkup({ range, translations: [ { locale: 'en', value: 'Hello *world*' }, { locale: 'fr', value: 'Bonjour' } ] }, true);

			assert.equal(markup.value, '**en**: Hello \\*world\\*  \n**fr**: Bonjour');
		});

		it('should list them plainly to a client without markdown', () => {
			const markup = toViewHoverMarkup({ range, translations: [ { locale: 'en', value: 'Hello *world*' } ] }, false);

			assert.equal(markup.value, 'en: Hello *world*');
		});

		it('should put the documentation after the translations it explains', () => {
			const markup = toViewHoverMarkup({ range, translations: [], documentation: 'No locale declares `x`.' }, true);

			assert.equal(markup.value, 'No locale declares `x`.');
		});
	});
});

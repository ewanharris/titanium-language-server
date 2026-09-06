import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseTss, nodeAt, parseSelector } from '../../core/tss.js';
import { fixturePath } from '../fixtures.js';

/** The source text a range covers, which is how positions are asserted here */
function slice (text: string, node: { range: { start: number, end: number } }): string {
	return text.slice(node.range.start, node.range.end);
}

describe('core/tss', () => {

	describe('rules and selectors', () => {

		it('should parse a quoted selector and its properties', () => {
			const text = '".container": {\n\tbackgroundColor: "white"\n}';
			const { rules } = parseTss(text);

			assert.equal(rules.length, 1);
			assert.equal(rules[0].selector.text, '.container');
			assert.equal(slice(text, rules[0].selector), '".container"');
			assert.equal(rules[0].properties.length, 1);
			assert.equal(rules[0].properties[0].name, 'backgroundColor');
		});

		it('should parse a bare selector', () => {
			// Alloy allows an unquoted tag selector
			const { rules } = parseTss('Label: {\n\tcolor: "#000"\n}');
			assert.equal(rules[0].selector.text, 'Label');
		});

		it('should accept single quotes as well as double', () => {
			const { rules } = parseTss("'Label': {\n\tcolor: '#000'\n}");
			assert.equal(rules[0].selector.text, 'Label');
			assert.deepEqual(rules[0].properties[0].value, {
				kind: 'string', value: '#000', terminated: true, range: { start: 19, end: 25 }
			});
		});

		it('should keep selector qualifiers as written', () => {
			const { rules } = parseTss('"Label[platform=android,windows]": {}');
			assert.equal(rules[0].selector.text, 'Label[platform=android,windows]');
		});

		it('should parse several rules, with or without separating commas', () => {
			// the top level treats commas as optional whitespace
			const { rules } = parseTss('"a": {}\n"b": {},\n"c": {}');
			assert.deepEqual(rules.map(rule => rule.selector.text), [ 'a', 'b', 'c' ]);
		});
	});

	describe('values', () => {

		it('should parse each scalar kind', () => {
			const { rules } = parseTss('"a": { s: "x", n: 12, f: 1.5, neg: -3, t: true, f2: false, nul: null, und: undefined }');
			const kinds = rules[0].properties.map(property => [ property.name, property.value?.kind ]);
			assert.deepEqual(kinds, [
				[ 's', 'string' ], [ 'n', 'number' ], [ 'f', 'number' ], [ 'neg', 'number' ],
				[ 't', 'boolean' ], [ 'f2', 'boolean' ], [ 'nul', 'null' ], [ 'und', 'undefined' ]
			]);
			assert.equal((rules[0].properties[1].value as { value: number }).value, 12);
			assert.equal((rules[0].properties[3].value as { value: number }).value, -3);
		});

		it('should parse a nested object and keep its properties addressable', () => {
			const text = '"#label": {\n\tfont: {\n\t\tfontSize: 12\n\t}\n}';
			const { rules } = parseTss(text);
			const font = rules[0].properties[0];

			assert.equal(font.name, 'font');
			assert.equal(font.value?.kind, 'object');
			const nested = (font.value as { properties: { name: string }[] }).properties;
			assert.deepEqual(nested.map(property => property.name), [ 'fontSize' ]);
		});

		it('should parse arrays', () => {
			const { rules } = parseTss('"a": { items: [ 1, "two", true ] }');
			const value = rules[0].properties[0].value as { kind: string, elements: { kind: string }[] };
			assert.equal(value.kind, 'array');
			assert.deepEqual(value.elements.map(element => element.kind), [ 'number', 'string', 'boolean' ]);
		});

		it('should keep Titanium constants as expressions rather than strings', () => {
			// Ti.UI.SIZE is a reference, not the text "Ti.UI.SIZE" — the difference matters
			// for completion and for the generated types later
			const { rules } = parseTss('"a": { width: Ti.UI.SIZE, height: Titanium.UI.FILL, x: Alloy.Globals.foo }');
			assert.deepEqual(rules[0].properties.map(property => [ property.value?.kind, (property.value as { text?: string }).text ]), [
				[ 'expression', 'Ti.UI.SIZE' ],
				[ 'expression', 'Titanium.UI.FILL' ],
				[ 'expression', 'Alloy.Globals.foo' ]
			]);
		});

		it('should keep locale calls, WPATH and $.args as expressions', () => {
			const { rules } = parseTss('"a": { t: L(\'key\'), i: WPATH(\'/img.png\'), a: $.args.title }');
			assert.deepEqual(rules[0].properties.map(property => (property.value as { text?: string }).text), [
				'L(\'key\')', 'WPATH(\'/img.png\')', '$.args.title'
			]);
		});
	});

	describe('expressions and escapes', () => {

		it('should join constants across bitwise operators into one expression', () => {
			// Alloy allows these between constants, mostly for Android flags
			const { rules } = parseTss('"a": { flags: Ti.UI.A | Ti.UI.B, shifted: Ti.X << 2 }');
			assert.deepEqual(rules[0].properties.map(property => (property.value as { text?: string }).text), [
				'Ti.UI.A | Ti.UI.B', 'Ti.X << 2'
			]);
		});

		it('should strip comments from inside a call', () => {
			// Alloy's own grammar fixture has WPATH(/* before */'hello.png' /* after */ )
			const { rules } = parseTss('"a": { image: WPATH(/* before */\'hello.png\' /* after */ ) }');
			const value = rules[0].properties[0].value as { text: string, normalised: string };

			assert.ok(!value.text.includes('/*'), `comments left in ${JSON.stringify(value.text)}`);
			assert.equal(value.normalised, 'WPATH(\'hello.png\')');
		});

		it('should carry Alloy\'s normalised form alongside the source text', () => {
			// the editor wants what was typed; the compiler's view is what actually runs
			const { rules } = parseTss('"a": { t: L(\'one\', \'two\'), g: Titanium.Locale.getString("k"), f: Ti.UI.A | Ti.UI.B }');
			const values = rules[0].properties.map(property => property.value as { text: string, normalised: string });

			assert.deepEqual(values.map(value => value.text), [
				'L(\'one\', \'two\')', 'Titanium.Locale.getString("k")', 'Ti.UI.A | Ti.UI.B'
			]);
			assert.deepEqual(values.map(value => value.normalised), [
				'L(\'one\',\'two\')', 'L("k")', 'Ti.UI.A|Ti.UI.B'
			]);
		});

		it('should not collapse whitespace that is inside a string', () => {
			const { rules } = parseTss('"a": { t: L(\'two  words\') }');
			assert.equal((rules[0].properties[0].value as { normalised: string }).normalised, 'L(\'two  words\')');
		});

		it('should leave a trailing operator with nothing after it alone', () => {
			const { rules } = parseTss('"a": { flags: Ti.UI.A |\n}');
			assert.equal((rules[0].properties[0].value as { text?: string }).text, 'Ti.UI.A');
		});

		it('should decode \\uXXXX escapes', () => {
			// ALOY-813 in Alloy's own corpus; Alloy's grammar has an explicit rule for these
			const { rules } = parseTss("'#code': { text: '\\u2764\\u263a\\nnext line' }");
			assert.equal((rules[0].properties[0].value as { value: string }).value, '\u2764\u263a\nnext line');
		});

		it('should keep a run of backslashes that is surrounded by whitespace', () => {
			// ALOY-793. Alloy doubles `\s\\+\s` before parsing so the backslashes survive its own
			// unescaping; we get the same result by treating such a run as literal, which keeps
			// source offsets intact where a rewrite would shift them
			const { rules } = parseTss("'a': { one: 'x \\ y', two: 'x \\\\ y' }");
			const values = rules[0].properties.map(property => (property.value as { value: string }).value);
			assert.deepEqual(values, [ 'x \\ y', 'x \\\\ y' ]);
		});

		it('should unescape string contents', () => {
			// the escaped backslash is written against a letter on purpose: with whitespace either
			// side it would be a literal run instead, which the ALOY-793 test above covers
			const { rules } = parseTss('"a": { text: "line\\nbreak \\"quoted\\" x\\\\y \\t\\r\\b\\f \\q" }');
			assert.equal((rules[0].properties[0].value as { value: string }).value, 'line\nbreak "quoted" x\\y \t\r\b\f q');
		});

		it('should parse exponent numbers', () => {
			const { rules } = parseTss('"a": { big: 1e3, small: 1.5E-2 }');
			const values = rules[0].properties.map(property => (property.value as { value?: number }).value);
			assert.deepEqual(values, [ 1000, 0.015 ]);
		});

		it('should not swallow a trailing e that is not an exponent', () => {
			// `2e` is not a number, so the number ends at the 2 and the e is left where it is —
			// which reads as the start of the next property name, since that is what it looks like
			const { rules } = parseTss('"a": { half: 2e }');
			const [ half, dangling ] = rules[0].properties;

			assert.equal((half.value as { value: number }).value, 2);
			assert.equal(dangling.name, 'e');
			assert.equal(dangling.value, undefined);
		});
	});

	describe('comments', () => {

		it('should skip line and block comments anywhere', () => {
			const text = '// leading\n/* block */\n"a": { // trailing\n\tcolor: "red" /* after */\n}';
			const { rules, diagnostics } = parseTss(text);

			assert.deepEqual(diagnostics, []);
			assert.equal(rules.length, 1);
			assert.equal(rules[0].properties[0].name, 'color');
		});

		it('should parse a file that is only a comment', () => {
			const { rules, diagnostics } = parseTss('// this file already existed\n');
			assert.deepEqual(rules, []);
			assert.deepEqual(diagnostics, []);
		});
	});

	describe('half-typed documents', () => {

		it('should keep a property whose value has not been typed yet', () => {
			const { rules } = parseTss('"a": {\n\twidth:\n\theight: 10\n}');
			const [ width, height ] = rules[0].properties;

			assert.equal(width.name, 'width');
			assert.equal(width.value, undefined);
			assert.equal(height.name, 'height');
			assert.equal(height.value?.kind, 'number');
		});

		it('should keep a bare word that has no colon yet', () => {
			// the user is typing a property name; it is still the thing to complete against
			const { rules } = parseTss('"a": {\n\tscroll\n\tlayout: "vertical"\n}');
			assert.deepEqual(rules[0].properties.map(property => property.name), [ 'scroll', 'layout' ]);
		});

		it('should keep an unterminated string and say it is unterminated', () => {
			const text = '"a": {\n\timage: "\n}';
			const { rules } = parseTss(text);
			const value = rules[0].properties[0].value as { kind: string, terminated: boolean };

			assert.equal(value.kind, 'string');
			assert.equal(value.terminated, false);
		});

		it('should keep a rule whose block was never opened', () => {
			const { rules } = parseTss('".f"\n\n"#s"\n\n"Label": { color: "red" }');
			assert.deepEqual(rules.map(rule => rule.selector.text), [ '.f', '#s', 'Label' ]);
			assert.deepEqual(rules[0].properties, []);
		});

		it('should recover from an unterminated selector and still parse what follows', () => {
			const { rules } = parseTss('"W\n\n"#id": { layout: "vertical" }');
			const found = rules.find(rule => rule.selector.text === '#id');
			assert.notEqual(found, undefined);
			assert.equal(found?.properties[0].name, 'layout');
		});

		it('should treat a dedent as closing a block that was never closed', () => {
			// strictly everything after an unclosed brace is inside it, which is correct and
			// useless — the rules below a typo would offer nothing. A name back at column zero is
			// the signal that the author moved on
			const { rules, diagnostics } = parseTss('"#id": {\n\tlayout:\n\n".after": {\n\tcolor: "red"\n}');

			assert.deepEqual(rules.map(rule => rule.selector.text), [ '#id', '.after' ]);
			assert.equal(rules[1].properties[0].name, 'color');
			assert.ok(diagnostics.some(diagnostic => /Unterminated block/.test(diagnostic.message)));
		});

		it('should not split a well formed block that happens not to be indented', () => {
			// the dedent rule must only apply where the strict parse already failed, or valid TSS
			// written without indentation would be torn apart
			const { rules, diagnostics } = parseTss('"Label": {\ncolor: "red"\nheight: 10\n}');

			assert.deepEqual(diagnostics, []);
			assert.equal(rules.length, 1);
			assert.deepEqual(rules[0].properties.map(property => property.name), [ 'color', 'height' ]);
		});

		it('should never throw, and report what it could not read', () => {
			const { diagnostics } = parseTss('"a": {\n\timage: "\n}');
			assert.ok(diagnostics.length > 0);
			assert.ok(diagnostics.every(d => typeof d.message === 'string' && d.range.end >= d.range.start));
		});
	});

	describe('input it cannot read at all', () => {

		it('should step over a character that starts nothing, and carry on', () => {
			const { rules, diagnostics } = parseTss('@\n"a": { color: "red" }');

			assert.deepEqual(rules.map(rule => rule.selector.text), [ 'a' ]);
			assert.ok(diagnostics.some(diagnostic => /Unexpected/.test(diagnostic.message)));
		});

		it('should step over junk inside an array', () => {
			const { rules, diagnostics } = parseTss('"a": { items: [ 1, @, 2 ] }');
			const value = rules[0].properties[0].value as { elements: { kind: string }[] };

			assert.deepEqual(value.elements.map(element => element.kind), [ 'number', 'number' ]);
			assert.ok(diagnostics.some(diagnostic => /Unexpected/.test(diagnostic.message)));
		});

		it('should report an array that was never closed', () => {
			const { rules, diagnostics } = parseTss('"a": { items: [ 1, 2');

			assert.equal((rules[0].properties[0].value as { kind: string }).kind, 'array');
			assert.ok(diagnostics.some(diagnostic => /Unterminated array/.test(diagnostic.message)));
		});

		it('should cope with the file ending immediately after a colon', () => {
			const { rules } = parseTss('"a": { color:');
			assert.equal(rules[0].properties[0].name, 'color');
			assert.equal(rules[0].properties[0].value, undefined);
		});

		it('should report a block that was never closed', () => {
			const { diagnostics } = parseTss('"a": { color: "red"');
			assert.ok(diagnostics.some(diagnostic => /Unterminated block/.test(diagnostic.message)));
		});
	});

	describe('the real fixtures', () => {
		let styles: string;

		before(async () => {
			styles = path.join(await fixturePath('alloy-project'), 'app', 'styles');
		});

		it('should parse index.tss into its three rules', async () => {
			const text = await fs.readFile(path.join(styles, 'index.tss'), 'utf-8');
			const { rules, diagnostics } = parseTss(text);

			assert.deepEqual(diagnostics, []);
			assert.deepEqual(rules.map(rule => rule.selector.text), [ '.container', 'Label', '#label' ]);
		});

		it('should parse app.tss, whose body is one large comment', async () => {
			const text = await fs.readFile(path.join(styles, 'app.tss'), 'utf-8');
			const { rules, diagnostics } = parseTss(text);

			assert.deepEqual(diagnostics, []);
			assert.deepEqual(rules.map(rule => rule.selector.text), [ '.thirdClass' ]);
		});

		it('should recover the readable rules from the half-typed sample.tss', async () => {
			// this fixture is deliberately mid-keystroke throughout; Alloy's own PEG grammar
			// throws on its second line, which is why this parser exists
			const text = await fs.readFile(path.join(styles, 'sample.tss'), 'utf-8');
			const { rules } = parseTss(text);
			const selectors = rules.map(rule => rule.selector.text);

			for (const expected of [ '#container', 'Label', '#label', '#id', '.f', '#s', 'ImageView', '.testClass', '.secondClass' ]) {
				assert.ok(selectors.includes(expected), `expected to recover ${expected}, got ${selectors.join(', ')}`);
			}
		});
	});

	describe('parseSelector', () => {

		it('should read the three selector kinds', () => {
			assert.deepEqual(parseSelector('#label'), { kind: 'id', name: 'label', queries: {} });
			assert.deepEqual(parseSelector('.container'), { kind: 'class', name: 'container', queries: {} });
			assert.deepEqual(parseSelector('Label'), { kind: 'tag', name: 'Label', queries: {} });
		});

		it('should split queries on whitespace, and a platform list on commas', () => {
			// Alloy's own rule: `[...]` holds space separated key=value pairs, and platform alone
			// takes a comma separated list of values
			assert.deepEqual(parseSelector('Label[platform=android,windows]'), {
				kind: 'tag', name: 'Label', queries: { platform: [ 'android', 'windows' ] }
			});
			assert.deepEqual(parseSelector('#index[platform=ios formFactor=tablet]'), {
				kind: 'id', name: 'index', queries: { platform: [ 'ios' ], formFactor: 'tablet' }
			});
		});

		it('should tolerate spaces around a comma in a platform list', () => {
			assert.deepEqual(parseSelector('Label[platform=android , windows]')?.queries, {
				platform: [ 'android', 'windows' ]
			});
		});

		it('should ignore empty space between queries', () => {
			assert.deepEqual(parseSelector('Label[platform=ios ]')?.queries, { platform: [ 'ios' ] });
		});

		it('should keep an unrecognised query as written', () => {
			assert.deepEqual(parseSelector('Label[if=Alloy.Globals.foo]')?.queries, { if: 'Alloy.Globals.foo' });
		});

		it('should return nothing for a selector Alloy would reject', () => {
			// Alloy dies on these rather than compiling them
			assert.equal(parseSelector(''), undefined);
			assert.equal(parseSelector('[platform=ios]'), undefined);
		});

		it('should skip the undefined key Alloy skips', () => {
			// styler.js drops `undefined` with no prefix, which is how a stray parse gets in
			assert.equal(parseSelector('undefined'), undefined);
			assert.deepEqual(parseSelector('#undefined'), { kind: 'id', name: 'undefined', queries: {} });
		});
	});

	describe('nodeAt', () => {

		it('should find the property under an offset', () => {
			const text = '"a": {\n\tbackgroundColor: "white"\n}';
			const found = nodeAt(parseTss(text), text.indexOf('backgroundColor') + 3);

			assert.equal(found?.kind, 'propertyName');
			assert.equal(found?.property?.name, 'backgroundColor');
		});

		it('should distinguish being in the value from being in the name', () => {
			const text = '"a": {\n\tbackgroundColor: "white"\n}';
			const found = nodeAt(parseTss(text), text.indexOf('"white"') + 2);

			assert.equal(found?.kind, 'value');
			assert.equal(found?.property?.name, 'backgroundColor');
		});

		it('should find the selector', () => {
			const text = '".container": {\n\tcolor: "red"\n}';
			const found = nodeAt(parseTss(text), 3);

			assert.equal(found?.kind, 'selector');
			assert.equal(found?.rule.selector.text, '.container');
		});

		it('should report the enclosing rule when the offset is in empty space inside a block', () => {
			const text = '".container": {\n\t\n}';
			const found = nodeAt(parseTss(text), text.indexOf('\n\t') + 2);

			assert.equal(found?.kind, 'body');
			assert.equal(found?.rule.selector.text, '.container');
		});

		it('should report the object when the offset is in its whitespace, not on a property', () => {
			const text = '"#label": {\n\tfont: {\n\t\tfontSize: 12\n\n\t}\n}';
			const found = nodeAt(parseTss(text), text.indexOf('12') + 3);

			assert.equal(found?.kind, 'value');
			assert.equal(found?.property?.name, 'font');
		});

		it('should return nothing outside any rule', () => {
			assert.equal(nodeAt(parseTss('\n\n".a": {}'), 0), undefined);
		});

		it('should find a property inside a nested object', () => {
			const text = '"#label": {\n\tfont: {\n\t\tfontSize: 12\n\t}\n}';
			const found = nodeAt(parseTss(text), text.indexOf('fontSize') + 2);

			assert.equal(found?.kind, 'propertyName');
			assert.equal(found?.property?.name, 'fontSize');
		});
	});
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { styleHoverAt, viewHoverAt } from '../../core/hover.ts';
import type { ViewHover } from '../../core/hover.ts';
import { Project } from '../../core/project.ts';
import { SourceCache } from '../../core/references.ts';
import { fixturePath } from '../fixtures.ts';
import { api } from './fake-api.ts';

/**
 * The hover where `|` marks the cursor
 *
 * @param text - The view source, with `|` marking the cursor
 * @param fixture - The project to answer against
 * @returns The hover, and the text its range covers so an assertion reads as what is highlighted
 */
async function hoverAt (text: string, fixture = 'alloy-project'): Promise<(ViewHover & { covers: string })|undefined> {
	const root = await fixturePath(fixture);
	const project = new Project(root);
	await project.load();

	const source = text.replace('|', '');
	const found = await viewHoverAt({
		project,
		view: { path: path.join(root, 'app', 'views', 'index.xml'), text: source },
		offset: text.indexOf('|'),
		api,
		cache: new SourceCache()
	});

	return found && { ...found, covers: source.slice(found.range.start, found.range.end) };
}

describe('Hover in a view', () => {

	describe('on a tag', () => {

		it('should name the type the element creates, with its documentation', async () => {
			const found = await hoverAt('<Alloy><La|bel/></Alloy>');

			assert.equal(found?.signature, 'Titanium.UI.Label');
			assert.match(found?.documentation ?? '', /A text label/);
			assert.equal(found?.covers, 'Label');
		});

		it('should list the styles the element ends up with, and the rule each comes from', async () => {
			// index.tss on disk styles Label with a color and #label with a font size
			const found = await hoverAt('<Alloy><Window><La|bel id="label" text="Hi"/></Window></Alloy>');
			const byName = new Map(found?.styles?.map(style => [ style.name, style ]));

			assert.deepEqual(byName.get('color'), { name: 'color', value: '"#000"', selector: 'Label', file: 'styles/index.tss', conditional: [] });
			assert.equal(byName.get('font.fontSize')?.selector, '#label');
			assert.deepEqual(byName.get('text'), { name: 'text', value: 'Hi', conditional: [] }, 'an attribute has no rule behind it');
		});

		it('should let the view\'s own stylesheet beat app.tss, which Alloy loads first', async () => {
			const root = await fixturePath('alloy-project');
			const project = new Project(root);
			await project.load();

			const cache = new SourceCache();
			cache.override(path.join(root, 'app', 'styles', 'app.tss'), '"Label": { color: "blue" }');
			cache.override(path.join(root, 'app', 'styles', 'index.tss'), '"Label": { color: "red" }');

			const text = '<Alloy><Label/></Alloy>';
			const found = await viewHoverAt({ project, view: { path: path.join(root, 'app', 'views', 'index.xml'), text }, offset: text.indexOf('Label'), api, cache });

			assert.deepEqual(found?.styles?.find(style => style.name === 'color'), { name: 'color', value: '"red"', selector: 'Label', file: 'styles/index.tss', conditional: [] });
		});

		it('should name the part of a key a style comes from', async () => {
			const root = await fixturePath('alloy-project');
			const project = new Project(root);
			await project.load();

			const cache = new SourceCache();
			cache.override(path.join(root, 'app', 'styles', 'index.tss'), '".big, Label": { color: "red" }');

			const text = '<Alloy><Label/></Alloy>';
			const found = await viewHoverAt({ project, view: { path: path.join(root, 'app', 'views', 'index.xml'), text }, offset: text.indexOf('Label'), api, cache });

			assert.equal(found?.styles?.find(style => style.name === 'color')?.selector, 'Label');
		});

		it('should take styles from the theme and the platform folders too', async () => {
			// alloy-themed-project: the theme's #title sets the colour, index.tss sets the text, and
			// styles/android/index.tss sets it again on Android alone
			const found = await hoverAt('<Alloy><Window class="main"><La|bel id="title"/></Window></Alloy>', 'alloy-themed-project');
			const byName = new Map(found?.styles?.map(style => [ style.name, style ]));

			assert.deepEqual(byName.get('color'), { name: 'color', value: '"white"', selector: '#title', file: 'themes/dark/styles/index.tss', conditional: [] });
			assert.deepEqual(byName.get('text'), {
				name: 'text',
				value: '"Hi"',
				selector: '#title',
				file: 'styles/index.tss',
				conditional: [ { selector: '#title', file: 'styles/android/index.tss', value: '"Android"' } ]
			});
		});

		it('should list what app.tss gives an element in a widget, as Alloy applies it there too', async () => {
			const root = await fixturePath('alloy-themed-project');
			const project = new Project(root);
			await project.load();

			const cache = new SourceCache();
			cache.override(path.join(root, 'app', 'styles', 'app.tss'), '"Label": { font: { fontSize: 20 } }');

			const text = '<Alloy><Label class="badge"/></Alloy>';
			const view = { path: path.join(root, 'app', 'widgets', 'badge', 'views', 'widget.xml'), text };
			const found = await viewHoverAt({ project, view, offset: text.indexOf('Label'), api, cache });

			assert.deepEqual(found?.styles?.find(style => style.name === 'font.fontSize'), { name: 'font.fontSize', value: '20', selector: 'Label', file: 'styles/app.tss', conditional: [] });
		});

		it('should list no styles for an element nothing styles', async () => {
			const found = await hoverAt('<Alloy><Vi|ew/></Alloy>');

			assert.equal(found?.styles, undefined);
		});

		it('should describe Alloy\'s own markup, which has no Titanium type', async () => {
			const found = await hoverAt('<Alloy><Requ|ire src="index"/></Alloy>');

			assert.equal(found?.signature, '<Require>');
			assert.match(found?.documentation ?? '', /app\/controllers/);
		});

		it('should answer nothing for a < with no name yet', async () => {
			assert.equal(await hoverAt('<Alloy><|</Alloy>'), undefined);
		});

		it('should answer nothing for a tag it knows nothing about', async () => {
			// resolves to Titanium.UI.Unknown, which the types do not have
			assert.equal(await hoverAt('<Alloy><Unkn|own/></Alloy>'), undefined);
		});
	});

	describe('on an attribute name', () => {

		it('should give a property its type and documentation', async () => {
			const found = await hoverAt('<Alloy><Label te|xt="Hi"/></Alloy>');

			assert.equal(found?.signature, '(property) Titanium.UI.Label.text: string');
			assert.equal(found?.documentation, 'The text to display');
			assert.equal(found?.covers, 'text');
		});

		it('should say a property is read only', async () => {
			// a view cannot set one, so completion never offers it — but one written by hand still
			// deserves an explanation of why it does nothing
			const found = await hoverAt('<Alloy><Label lineC|ount="2"/></Alloy>');

			assert.equal(found?.signature, '(property) readonly Titanium.UI.Label.lineCount: number');
		});

		it('should describe an event from the type\'s event map', async () => {
			const found = await hoverAt('<Alloy><Label onCl|ick="doClick"/></Alloy>');

			assert.equal(found?.signature, '(event) Titanium.UI.Label click: ClickEvent');
			assert.match(found?.documentation ?? '', /Fired when the device detects a click/);
		});

		it('should say which platform a prefixed event is limited to', async () => {
			const found = await hoverAt('<Alloy><Label ios:onCl|ick="doClick"/></Alloy>');

			assert.equal(found?.signature, '(event) Titanium.UI.Label click: ClickEvent');
			assert.match(found?.documentation ?? '', /Only on ios/);
			assert.equal(found?.covers, 'ios:onClick');
		});

		it('should describe Alloy\'s own attributes', async () => {
			const found = await hoverAt('<Alloy><Label plat|form="ios"/></Alloy>');

			assert.equal(found?.signature, '(Alloy) platform');
			assert.match(found?.documentation ?? '', /android/);
		});

		it('should describe src by the tag it is written on', async () => {
			assert.match((await hoverAt('<Alloy><Widget s|rc="x"/></Alloy>'))?.documentation ?? '', /app\/widgets/);
			assert.match((await hoverAt('<Alloy><Model s|rc="x"/></Alloy>'))?.documentation ?? '', /app\/models/);
		});

		it('should prefer Alloy\'s meaning of id over any the type has', async () => {
			assert.equal((await hoverAt('<Alloy><Label i|d="title"/></Alloy>'))?.signature, '(Alloy) id');
		});

		it('should answer nothing for an attribute nothing describes', async () => {
			assert.equal(await hoverAt('<Alloy><Label unkn|own="1"/></Alloy>'), undefined);
		});

		it('should answer nothing for an attribute of Alloy\'s markup that Alloy does not read', async () => {
			// a <Require> has no Titanium type to fall back on
			assert.equal(await hoverAt('<Alloy><Require col|or="red"/></Alloy>'), undefined);
		});

		it('should answer nothing for an event the type does not emit', async () => {
			assert.equal(await hoverAt('<Alloy><Label onOp|en="x"/></Alloy>'), undefined);
		});

		it('should not mistake a name every object has for one of Alloy\'s', async () => {
			// a lookup table that is a plain object answers `constructor` from its prototype
			assert.equal(await hoverAt('<Alloy><Label constr|uctor="1"/></Alloy>'), undefined);
			assert.equal(await hoverAt('<Alloy><toStr|ing/></Alloy>'), undefined);
		});
	});

	describe('on a value', () => {

		it('should preview the image a value names', async () => {
			const found = await hoverAt('<Alloy><ImageView image="/images/lo|go.png"/></Alloy>');

			assert.equal(found?.image?.width, 3);
			assert.match(found?.image?.dataUri ?? '', /^data:image\/png;base64,/);
			assert.equal(found?.covers, '/images/logo.png');
		});

		it('should say so when no image is behind the path', async () => {
			const found = await hoverAt('<Alloy><ImageView image="/images/miss|ing.png"/></Alloy>');

			assert.equal(found?.image, undefined);
			assert.match(found?.documentation ?? '', /No image/);
		});

		it('should not treat a value as an image when the property does not take one', async () => {
			assert.equal(await hoverAt('<Alloy><Label text="/images/lo|go.png"/></Alloy>'), undefined);
		});

		it('should show a key\'s translation in every locale that has one', async () => {
			const found = await hoverAt('<Alloy><Label text="L(\'welcome.ti|tle\')"/></Alloy>');

			assert.deepEqual(found?.translations, [
				{ locale: 'en', value: 'Welcome' },
				{ locale: 'fr', value: 'Bienvenue' }
			]);
			assert.equal(found?.covers, 'welcome.title');
		});

		it('should list the default language first', async () => {
			const root = await fixturePath('alloy-project');
			const project = new Project(root);
			await project.load();
			const text = '<Alloy><Label text="L(\'welcome.title\')"/></Alloy>';

			const found = await viewHoverAt({
				project,
				view: { path: path.join(root, 'app', 'views', 'index.xml'), text },
				offset: text.indexOf('welcome'),
				api,
				cache: new SourceCache(),
				defaultLanguage: 'fr'
			});

			assert.deepEqual(found?.translations?.map(translation => translation.locale), [ 'fr', 'en' ]);
		});

		it('should show one in element text, and from titleid', async () => {
			assert.equal((await hoverAt('<Alloy><Label>L("te|st")</Label></Alloy>'))?.translations?.length, 2);
			assert.equal((await hoverAt('<Alloy><Window titleid="untrans|lated"/></Alloy>'))?.translations?.length, 1);
		});

		it('should say so when no locale has the key', async () => {
			const found = await hoverAt('<Alloy><Label text="L(\'noex|ist\')"/></Alloy>');

			assert.deepEqual(found?.translations, []);
			assert.match(found?.documentation ?? '', /No locale/);
		});
	});

	it('should answer nothing in plain text', async () => {
		assert.equal(await hoverAt('<Alloy><Label>Hel|lo</Label></Alloy>'), undefined);
	});

	it('should answer nothing in a classic project', async () => {
		assert.equal(await hoverAt('<Alloy><La|bel/></Alloy>', 'classic-project'), undefined);
	});
});

/**
 * The hover where `|` marks the cursor in `app/styles/index.tss`
 *
 * @param text - The stylesheet, with `|` marking the cursor
 * @param view - The view it styles, as a buffer, when the test needs particular elements
 * @param fixture - The project to answer against
 * @returns The hover, and the text its range covers
 */
async function styleHover (text: string, view?: string, fixture = 'alloy-project', style = 'index.tss', styles: Record<string, string> = {}): Promise<(ViewHover & { covers: string })|undefined> {
	const root = await fixturePath(fixture);
	const project = new Project(root);
	await project.load();

	const cache = new SourceCache();
	if (view !== undefined) {
		cache.override(path.join(root, 'app', 'views', 'index.xml'), view);
	}
	for (const [ name, contents ] of Object.entries(styles)) {
		cache.override(path.join(root, 'app', 'styles', name), contents);
	}

	const source = text.replace('|', '');
	const found = await styleHoverAt({
		project,
		style: { path: path.join(root, 'app', 'styles', style), text: source },
		offset: text.indexOf('|'),
		api,
		cache
	});

	return found && { ...found, covers: source.slice(found.range.start, found.range.end) };
}

describe('Hover in a stylesheet', () => {

	describe('on a selector', () => {

		it('should name the type a tag styles, and the elements it styles', async () => {
			const found = await styleHover('"La|bel": {}');

			assert.equal(found?.signature, 'Titanium.UI.Label');
			assert.match(found?.documentation ?? '', /A text label/);
			assert.match(found?.documentation ?? '', /`<Label id="label">` in views\/index\.xml/);
			assert.equal(found?.covers, 'Label');
		});

		it('should name the types of the elements a class is on', async () => {
			const found = await styleHover('".sha|red": {}', '<Alloy><Window><Label class="shared"/><ImageView class="shared"/></Window></Alloy>');

			assert.equal(found?.signature, 'Titanium.UI.Label | Titanium.UI.ImageView');
			assert.match(found?.documentation ?? '', /`<Label class="shared">`/);
		});

		it('should list ten elements and count the rest', async () => {
			const labels = Array.from({ length: 12 }, (_, index) => `<Label id="l${index}" class="many"/>`).join('');
			const found = await styleHover('".ma|ny": {}', `<Alloy><Window>${labels}</Window></Alloy>`);

			assert.match(found?.documentation ?? '', /`<Label id="l9">`[^]*- and 2 more$/);
			assert.doesNotMatch(found?.documentation ?? '', /l10/);
		});

		it('should answer nothing for a tag the types know nothing of', async () => {
			assert.equal(await styleHover('"Unkn|own": {}'), undefined);
		});

		it('should describe the part of a comma separated key under the cursor', async () => {
			const found = await styleHover('".container, #la|bel": {}');

			assert.equal(found?.signature, 'Titanium.UI.Label');
			assert.equal(found?.covers, 'label');
		});

		it('should describe an escaped part, covering its name as written', async () => {
			const found = await styleHover('".container, \\u0023la|bel": {}');

			assert.equal(found?.signature, 'Titanium.UI.Label');
			assert.equal(found?.covers, 'label');
		});

		it('should say so when nothing in the views carries a class', async () => {
			const found = await styleHover('".nothing|HasThis": {}');

			assert.equal(found?.signature, undefined);
			assert.match(found?.documentation ?? '', /Nothing .* has the class `nothingHasThis`/);
		});
	});

	describe('on a property name', () => {

		it('should give the property its type and documentation', async () => {
			const found = await styleHover('"Label": { te|xt: "Hi" }');

			assert.equal(found?.signature, '(property) Titanium.UI.Label.text: string');
			assert.equal(found?.documentation, 'The text to display');
			assert.equal(found?.covers, 'text');
		});

		it('should give a nested property its type', async () => {
			const found = await styleHover('"Label": { font: { font|Size: 12 } }');

			assert.equal(found?.signature, '(property) Titanium.UI.Label.font.fontSize: number | string');
		});

		it('should name the types that have it when the rule styles several', async () => {
			const found = await styleHover('".shared": { wid|th: 10 }', '<Alloy><Window><Label class="shared"/><ImageView class="shared"/></Window></Alloy>');

			assert.equal(found?.signature, '(property) width: string | number — Label, ImageView');
		});

		it('should say where a rule of higher priority overrides it', async () => {
			const found = await styleHover('"Label": { co|lor: "blue" }\n"#title": { color: "red" }', '<Alloy><Window><Label id="title"/></Window></Alloy>');

			assert.match(found?.documentation ?? '', /Overridden on `<Label id="title">` by `#title` in styles\/index\.tss/);
		});

		it('should say a rule in app.tss is overridden by the same selector in the view\'s own stylesheet', async () => {
			const found = await styleHover('"Label": { co|lor: "blue" }', '<Alloy><Window><Label id="title"/></Window></Alloy>', 'alloy-project', 'app.tss', { 'index.tss': '"Label": { color: "red" }' });

			assert.match(found?.documentation ?? '', /Overridden on `<Label id="title">` by `Label` in styles\/index\.tss/);
		});

		it('should describe a property of a rule for the view\'s own name, which its top level element takes as an id', async () => {
			const found = await styleHover('"#index": { tit|le: "Home" }', '<Alloy><Window/></Alloy>');

			assert.equal(found?.signature, '(property) Titanium.UI.Window.title: string');
		});

		it('should name the part of a key that overrides it, not the whole key', async () => {
			const found = await styleHover('"Label": { co|lor: "blue" }\n".big, #title": { color: "red" }', '<Alloy><Window><Label id="title"/></Window></Alloy>');

			assert.match(found?.documentation ?? '', /Overridden on `<Label id="title">` by `#title` in styles\/index\.tss/);
		});

		it('should describe a property of a comma separated key from every part\'s types', async () => {
			const found = await styleHover('".container, #label": { ti|tle: "x" }');

			assert.equal(found?.signature, '(property) title: string — Window');
		});

		it('should say where a theme overrides a rule in a platform folder', async () => {
			const found = await styleHover('"Label": { co|lor: "blue" }', undefined, 'alloy-themed-project', 'ios/app.tss');

			assert.match(found?.documentation ?? '', /Overridden on `<Label id="title">` by `#title` in themes\/dark\/styles\/index\.tss/);
		});

		it('should say a theme no build selects applies nowhere, rather than who overrides it', async () => {
			// config.json selects dark, so nothing loads the light theme's stylesheet
			const found = await styleHover('"#title": { co|lor: "pink" }', undefined, 'alloy-themed-project', path.join('..', 'themes', 'light', 'styles', 'index.tss'));

			assert.doesNotMatch(found?.documentation ?? '', /Overridden/);
			assert.match(found?.documentation ?? '', /No build loads this stylesheet/);
		});

		it('should say where the element\'s own attribute overrides it', async () => {
			const found = await styleHover('"Label": { co|lor: "blue" }', '<Alloy><Window><Label id="title" color="green"/></Window></Alloy>');

			assert.match(found?.documentation ?? '', /Overridden on `<Label id="title">` by its own `color` attribute/);
		});

		it('should say where a rule overrides it only when its condition holds', async () => {
			const found = await styleHover('"Label": { co|lor: "blue" }\n"Label[platform=ios]": { color: "red" }', '<Alloy><Window><Label id="title"/></Window></Alloy>');

			assert.match(found?.documentation ?? '', /`Label\[platform=ios\]` in styles\/index\.tss overrides it on `<Label id="title">` where its condition holds/);
		});

		it('should say nothing of the cascade where the rule wins', async () => {
			const found = await styleHover('"#title": { co|lor: "red" }\n"Label": { color: "blue" }', '<Alloy><Window><Label id="title"/></Window></Alloy>');

			assert.doesNotMatch(found?.documentation ?? '', /Overridden|overrides/);
		});

		it('should describe a property with no value yet, which nothing can override', async () => {
			const found = await styleHover('"Label": { co|lor: }', '<Alloy><Window><Label id="title"/></Window></Alloy>');

			assert.equal(found?.signature, '(property) Titanium.UI.Label.color: string');
			assert.equal(found?.documentation, '');
		});

		it('should answer nothing for a property none of the types has', async () => {
			assert.equal(await styleHover('"Label": { nothi|ng: 1 }'), undefined);
		});
	});

	describe('on a value', () => {

		it('should describe a constant', async () => {
			const found = await styleHover('"Label": { width: Ti.UI.SI|ZE }');

			assert.equal(found?.signature, '(constant) Titanium.UI.SIZE');
			assert.equal(found?.documentation, 'SIZE behavior for UI layout.');
			assert.equal(found?.covers, 'Ti.UI.SIZE');
		});

		it('should preview the image a value names', async () => {
			const found = await styleHover('"ImageView": { image: "/images/lo|go.png" }');

			assert.ok(found?.image, 'expected a preview');
			assert.equal(found?.covers, '/images/logo.png');
		});

		it('should show a key\'s translations', async () => {
			const found = await styleHover('"Label": { text: L(\'welcome.ti|tle\') }');

			assert.ok(found?.translations?.length, 'expected the key\'s translations');
			assert.equal(found?.covers, 'welcome.title');
		});

		it('should list the default language\'s translation first', async () => {
			const root = await fixturePath('alloy-project');
			const project = new Project(root);
			await project.load();
			const text = '"Label": { text: L(\'welcome.title\') }';

			const found = await styleHoverAt({
				project,
				style: { path: path.join(root, 'app', 'styles', 'index.tss'), text },
				offset: text.indexOf('welcome'),
				api,
				cache: new SourceCache(),
				defaultLanguage: 'fr'
			});

			assert.deepEqual(found?.translations?.map(translation => translation.locale), [ 'fr', 'en' ]);
		});

		it('should answer nothing for an expression that is not a constant', async () => {
			assert.equal(await styleHover('"Label": { text: Alloy.CFG.ti|tle }'), undefined);
			assert.equal(await styleHover('"Label": { width: Ti.UI.NOTH|ING }'), undefined);
		});

		it('should answer nothing for a value with nothing to say', async () => {
			assert.equal(await styleHover('"Label": { color: "re|d" }'), undefined);
		});
	});

	it('should answer nothing outside any rule', async () => {
		assert.equal(await styleHover('"Label": {}\n|'), undefined);
	});

	it('should answer nothing in a classic project', async () => {
		assert.equal(await styleHover('"La|bel": {}', undefined, 'classic-project'), undefined);
	});
});

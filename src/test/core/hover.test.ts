import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { viewHoverAt } from '../../core/hover.ts';
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

		it('should describe Alloy\'s own markup, which has no Titanium type', async () => {
			const found = await hoverAt('<Alloy><Requ|ire src="index"/></Alloy>');

			assert.equal(found?.signature, '<Require>');
			assert.match(found?.documentation ?? '', /app\/controllers/);
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

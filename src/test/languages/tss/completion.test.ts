import { describe, it } from 'mocha';
import { createSandbox } from 'sinon';
import { testCompletion } from '../../test-util';

describe('TSS Completions', () => {
	let sandbox: sinon.SinonSandbox;

	beforeEach(() => {
		sandbox = createSandbox();
	});

	afterEach(() => {
		sandbox.restore();
	});

	it('Should provide tag suggestions', async () => {
		await testCompletion('tss', '"W|', {
			count: 30,
			items: [
				{ label: 'ActionView' }
			]
		}, sandbox);
	});

	it('Should provide property name suggestions', async () => {
		await testCompletion('tss', `#id":{
scroll|`, {
			count: 19,
			items: [
				{ label: 'autoAdjustScrollViewInsets' }
			]
		}, sandbox);
	});

	it('Should provide property value suggestions', async () => {
		await testCompletion('tss', `"#label": {
font: {
	fontSize: 12
},
separatorStyle:|
}`, {
			count: 2,
			items: [
				{ label: 'Ti.UI.TABLE_VIEW_SEPARATOR_STYLE_NONE' }
			]
		}, sandbox);

		await testCompletion('tss', `"#container": {
backgroundColor: ma|
}`, {
			count: 2,
			items: [
				{ label: '\'magenta\'' }
			]
		}, sandbox);

		await testCompletion('tss', `#id":{
layout:|`, {
			count: 3,
			items: [
				{ label: '\'vertical\'' }
			]
		}, sandbox);
	});

	it('Should provide property name suggestions regardless of the prefix casing', async () => {
		for (const prefix of [ 'back', 'Back', 'BACK' ]) {
			await testCompletion('tss', `"Label": {\n\t${prefix}|\n}`, {
				items: [
					{ label: 'backgroundColor' }
				]
			}, sandbox);
		}
	});

	it('Should provide tag suggestions for a multi character prefix', async () => {
		await testCompletion('tss', '"Win|', {
			items: [
				{ label: 'Window' },
				{ label: 'NavigationWindow' }
			]
		}, sandbox);

		await testCompletion('tss', '"Window|', {
			items: [
				{ label: 'Window' }
			]
		}, sandbox);
	});

	it('Should provide class suggestions', async () => {
		// '.' is a class selector, so the classes from the related view are suggested
		await testCompletion('tss', '".test|"', {
			count: 1,
			items: [
				{ label: 'testClass' }
			]
		}, sandbox);

		await testCompletion('tss', '".|"', {
			count: 3,
			items: [
				{ label: 'foo' },
				{ label: 'testClass' },
				{ label: 'noexistclass' }
			]
		}, sandbox);
	});

	it('Should provide id suggestions', async () => {
		// '#' is an id selector, so the ids from the related view are suggested
		await testCompletion('tss', '"#cont|"', {
			count: 1,
			items: [
				{ label: 'container' }
			]
		}, sandbox);

		await testCompletion('tss', '"#|"', {
			count: 5,
			items: [
				{ label: 'container' },
				{ label: 'scrollView' },
				{ label: 'noexistid' }
			]
		}, sandbox);
	});

	it('Should provide i18n suggestions', async () => {
		await testCompletion('tss', `"Label": {
			textid: "|
		}
		`, {
			count: 1,
			items: [
				{ label: 'test' }
			]
		}, sandbox);
	});

	it('Should provide image suggestions', async () => {
		await testCompletion('tss', `"ImageView": {
			image: "|
		}
		`, {
			count: 1,
			items: [
				{ label: '/test.png' }
			]
		}, sandbox);
	});

	it('Should provide inner property suggestions', async () => {
		await testCompletion('tss', `"Label": {
			font: {
				f|
			}
		}
		`, {
			count: 4,
			items: [
				{ label: 'fontFamily' }
			]
		}, sandbox);
	});
});

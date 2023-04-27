import { describe, it } from 'mocha';
import { createSandbox } from 'sinon';
import { testCompletion } from '../../test-util';
import { CompletionItemKind, CompletionItemTag } from 'vscode-languageserver';

describe('JavaScript completions', () => {
	let sandbox: sinon.SinonSandbox;

	beforeEach(() => {
		sandbox = createSandbox();
	});

	afterEach(() => {
		sandbox.restore();
	});

	it('Should provide completions for functions', async () => {
		await testCompletion('js', 'Ti.UI.createWind|', {
			count: 1,
			items: [
				{ label: 'createWindow', kind: CompletionItemKind.Method }
			]
		}, sandbox);
	});

	it('Should provide completions for properties', async () => {
		// This should be a constant?
		await testCompletion('js', 'Ti.UI.ANIMATION_CURVE_LI|', {
			count: 1,
			items: [
				{ label: 'ANIMATION_CURVE_LINEAR', kind: CompletionItemKind.Property }
			]
		}, sandbox);

		await testCompletion('js', 'Ti.UI.apiN|', {
			count: 1,
			items: [
				{ label: 'apiName', kind: CompletionItemKind.Property }
			]
		}, sandbox);
	});

	it('should provide combined', async () => {
		await testCompletion('js', 'Ti.|', {
			count: 200
		}, sandbox);
	});

	it('should provide deprecated information', async () => {
		await testCompletion('js', 'Ti.Analytics.navE|', {
			count: 1,
			items: [
				{ label: 'navEvent', kind: CompletionItemKind.Method, tags: [ CompletionItemTag.Deprecated ] }
			]
		}, sandbox);
	});

	it('should provide require definitions', async () => {
		await testCompletion('js', 'require(\'|\')', {
			count: 2,
			items: [
				{ label: '/folder/custom-view', kind: CompletionItemKind.Reference },
				{ label: '/http', kind: CompletionItemKind.Reference },
			]
		}, sandbox);
	});

	it('should provide import definitions', async () => {
		await testCompletion('js', 'import http from \'|\';', {
			count: 2,
			items: [
				{ label: '/folder/custom-view', kind: CompletionItemKind.Reference },
				{ label: '/http', kind: CompletionItemKind.Reference },
			]
		}, sandbox);

		await testCompletion('js', 'import \'|\';', {
			count: 2,
			items: [
				{ label: '/folder/custom-view', kind: CompletionItemKind.Reference },
				{ label: '/http', kind: CompletionItemKind.Reference },
			]
		}, sandbox);

		await testCompletion('js', 'import * as foo \'|\';', {
			count: 2,
			items: [
				{ label: '/folder/custom-view', kind: CompletionItemKind.Reference },
				{ label: '/http', kind: CompletionItemKind.Reference },
			]
		}, sandbox);

		await testCompletion('js', 'import { http } \'|\';', {
			count: 2,
			items: [
				{ label: '/folder/custom-view', kind: CompletionItemKind.Reference },
				{ label: '/http', kind: CompletionItemKind.Reference },
			]
		}, sandbox);

		await testCompletion('js', 'const http = await import(\'|\');', {
			count: 2,
			items: [
				{ label: '/folder/custom-view', kind: CompletionItemKind.Reference },
				{ label: '/http', kind: CompletionItemKind.Reference },
			]
		}, sandbox);

		await testCompletion('js', 'import(\'|\').then();', {
			count: 2,
			items: [
				{ label: '/folder/custom-view', kind: CompletionItemKind.Reference },
				{ label: '/http', kind: CompletionItemKind.Reference },
			]
		}, sandbox);

		await testCompletion('js', 'import(\'|\');', {
			count: 2,
			items: [
				{ label: '/folder/custom-view', kind: CompletionItemKind.Reference },
				{ label: '/http', kind: CompletionItemKind.Reference },
			]
		}, sandbox);
	});

	it('should provide i18n completions', async () => {
		await testCompletion('js', 'L(\'|\')', {
			count: 1,
			items: [
				{ label: 'test', kind: CompletionItemKind.Reference }
			]
		}, sandbox);
	});
});

describe('Alloy completions', async () => {
	let sandbox: sinon.SinonSandbox;

	beforeEach(() => {
		sandbox = createSandbox();
	});

	afterEach(() => {
		sandbox.restore();
	});

	it('should provide Alloy completions', async () => {
		await testCompletion('js', 'Alloy.|', {
			count: 16,
			items: [
				{ label: 'Alloy.Controller', kind: CompletionItemKind.Interface }
			]
		}, sandbox);
	});

	it('should provide Alloy property completions', async () => {
		await testCompletion('js', 'Alloy.Controller.add|', {
			count: 2,
			items: [
				{ label: 'addClass', kind: CompletionItemKind.Method },
				{ label: 'addListener', kind: CompletionItemKind.Method }
			]
		}, sandbox);
	});

	it('should provide Alloy Controller completions', async () => {
		await testCompletion('js', 'Alloy.createController(\'|\')', {
			count: 6,
			items: [
				{ label: '/existing-file', kind: CompletionItemKind.Reference },
			]
		}, sandbox);
	});

	it('should provide Alloy Model completions', async () => {
		await testCompletion('js', 'Alloy.createModel(\'|\')', {
			count: 1,
			items: [
				{ label: '/test', kind: CompletionItemKind.Reference }
			]
		}, sandbox);
	});

	it('should provide Alloy Widget completions', async () => {
		await testCompletion('js', 'Alloy.createWidget(\'|\')', {
			count: 1,
			items: [
				{ label: 'widget-test', kind: CompletionItemKind.Reference }
			]
		}, sandbox);
	});

	it('should provide Alloy CFG completions', async () => {
		await testCompletion('js', 'Alloy.CFG.|', {
			count: 1,
			items: [
				{ label: 'test', kind: CompletionItemKind.Value }
			]
		}, sandbox);
	});

	it('should provide id completions', async () => {
		await testCompletion('js', '$.|', {
			count: 3,
			items: [
				{ label: 'container', kind: CompletionItemKind.Reference },
				{ label: 'scrollView', kind: CompletionItemKind.Reference },
			]
		}, sandbox);

		await testCompletion('js', '$.scrollView.|', {
			count: 113,
			items: [
				{ label: 'addEventListener', kind: CompletionItemKind.Method }
			]
		}, sandbox);

		await testCompletion('js', '$.scrollView.addEventListener(\'|\')', {
			count: 22,
			items: [
				{ label: 'click', kind: CompletionItemKind.Event }
			]
		}, sandbox);
	});
});

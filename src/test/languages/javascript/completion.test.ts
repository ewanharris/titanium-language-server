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
		await testCompletion('Ti.UI.createWind|', {
			count: 1,
			items: [
				{ label: 'createWindow', kind: CompletionItemKind.Method }
			]
		}, sandbox);
	});

	it('Should provide completions for properties', async () => {
		// This should be a constant?
		await testCompletion('Ti.UI.ANIMATION_CURVE_LI|', {
			count: 1,
			items: [
				{ label: 'ANIMATION_CURVE_LINEAR', kind: CompletionItemKind.Property }
			]
		}, sandbox);

		await testCompletion('Ti.UI.apiN|', {
			count: 1,
			items: [
				{ label: 'apiName', kind: CompletionItemKind.Property }
			]
		}, sandbox);
	});

	it('should provide combined', async () => {
		await testCompletion('Ti.|', {
			count: 200
		}, sandbox);
	});

	it('should provide deprecated information', async () => {
		await testCompletion('Ti.Analytics.navE|', {
			count: 1,
			items: [
				{ label: 'navEvent', kind: CompletionItemKind.Method, tags: [ CompletionItemTag.Deprecated ] }
			]
		}, sandbox);
	});

	it('should provide require definitions', async () => {
		await testCompletion('require(\'|\')', {
			count: 2,
			items: [
				{ label: '/folder/custom-view', kind: CompletionItemKind.Reference },
				{ label: '/http', kind: CompletionItemKind.Reference },
			]
		}, sandbox);
	});

	it('should provide import definitions', async () => {
		await testCompletion('import http from \'|\';', {
			count: 2,
			items: [
				{ label: '/folder/custom-view', kind: CompletionItemKind.Reference },
				{ label: '/http', kind: CompletionItemKind.Reference },
			]
		}, sandbox);

		await testCompletion('import \'|\';', {
			count: 2,
			items: [
				{ label: '/folder/custom-view', kind: CompletionItemKind.Reference },
				{ label: '/http', kind: CompletionItemKind.Reference },
			]
		}, sandbox);

		await testCompletion('import * as foo \'|\';', {
			count: 2,
			items: [
				{ label: '/folder/custom-view', kind: CompletionItemKind.Reference },
				{ label: '/http', kind: CompletionItemKind.Reference },
			]
		}, sandbox);

		await testCompletion('import { http } \'|\';', {
			count: 2,
			items: [
				{ label: '/folder/custom-view', kind: CompletionItemKind.Reference },
				{ label: '/http', kind: CompletionItemKind.Reference },
			]
		}, sandbox);

		await testCompletion('const http = await import(\'|\');', {
			count: 2,
			items: [
				{ label: '/folder/custom-view', kind: CompletionItemKind.Reference },
				{ label: '/http', kind: CompletionItemKind.Reference },
			]
		}, sandbox);

		await testCompletion('import(\'|\').then();', {
			count: 2,
			items: [
				{ label: '/folder/custom-view', kind: CompletionItemKind.Reference },
				{ label: '/http', kind: CompletionItemKind.Reference },
			]
		}, sandbox);

		await testCompletion('import(\'|\');', {
			count: 2,
			items: [
				{ label: '/folder/custom-view', kind: CompletionItemKind.Reference },
				{ label: '/http', kind: CompletionItemKind.Reference },
			]
		}, sandbox);
	});

	it('should provide i18n completions', async () => {
		await testCompletion('L(\'|\')', {
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
		await testCompletion('Alloy.|', {
			count: 16,
			items: [
				{ label: 'Alloy.Controller', kind: CompletionItemKind.Interface }
			]
		}, sandbox);
	});

	it('should provide Alloy property completions', async () => {
		await testCompletion('Alloy.Controller.add|', {
			count: 2,
			items: [
				{ label: 'addClass', kind: CompletionItemKind.Method },
				{ label: 'addListener', kind: CompletionItemKind.Method }
			]
		}, sandbox);
	});

	it('should provide Alloy Controller completions', async () => {
		await testCompletion('Alloy.createController(\'|\')', {
			count: 6,
			items: [
				{ label: '/existing-file', kind: CompletionItemKind.Reference },
			]
		}, sandbox);
	});

	it('should provide Alloy Model completions', async () => {
		await testCompletion('Alloy.createModel(\'|\')', {
			count: 1,
			items: [
				{ label: '/test', kind: CompletionItemKind.Reference }
			]
		}, sandbox);
	});

	it('should provide Alloy Widget completions', async () => {
		await testCompletion('Alloy.createWidget(\'|\')', {
			count: 1,
			items: [
				{ label: 'widget-test', kind: CompletionItemKind.Reference }
			]
		}, sandbox);
	});

	it('should provide Alloy CFG completions', async () => {
		await testCompletion('Alloy.CFG.|', {
			count: 1,
			items: [
				{ label: 'test', kind: CompletionItemKind.Value }
			]
		}, sandbox);
	});

	it('should provide id completions', async () => {
		await testCompletion('$.|', {
			count: 3,
			items: [
				{ label: 'container', kind: CompletionItemKind.Reference },
				{ label: 'scrollView', kind: CompletionItemKind.Reference },
			]
		}, sandbox);

		await testCompletion('$.scrollView.|', {
			count: 113,
			items: [
				{ label: 'addEventListener', kind: CompletionItemKind.Method }
			]
		}, sandbox);

		await testCompletion('$.scrollView.addEventListener(\'|\')', {
			count: 22,
			items: [
				{ label: 'click', kind: CompletionItemKind.Event }
			]
		}, sandbox);
	});
});

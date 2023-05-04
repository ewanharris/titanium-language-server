import { describe, it } from 'mocha';
import { createSandbox } from 'sinon';
import { testCompletion } from '../../test-util';
import { CompletionItemKind } from 'vscode-languageserver';

describe('View completions', () => {
	let sandbox: sinon.SinonSandbox;

	beforeEach(() => {
		sandbox = createSandbox();
	});

	afterEach(() => {
		sandbox.restore();
	});

	it('should provide tag completions', async () => {
		await testCompletion('view', '<Window|', {
			count: 4,
			items: [
				{ label: 'Window', kind: CompletionItemKind.Class },
				{ label: 'NavigationWindow', kind: CompletionItemKind.Class },
				{ label: 'SplitWindow', kind: CompletionItemKind.Class },
				{ label: 'WindowToolbar', kind: CompletionItemKind.Class },
			]
		}, sandbox);
	});

	it('should provide event completions', async () => {
		await testCompletion('view', '<Button onL|', {
			count: 2,
			items: [
				{ label: 'onLongclick', kind: CompletionItemKind.Event },
				{ label: 'onLongpress', kind: CompletionItemKind.Event }
			]
		}, sandbox);
	});

	it('should provide attribute completions', async () => {
		await testCompletion('view', '<Label background|', {
			count: 17,
			items: [
				{ label: 'backgroundColor', kind: CompletionItemKind.Property },
			]
		}, sandbox);
	});

	it('should provide attribute value completions', async () => {
		await testCompletion('view', '<Label color="|"', {
			count: 24,
			items: [
				{ label: 'transparent', kind: CompletionItemKind.Value },
				{ label: 'red', kind: CompletionItemKind.Value },
			]
		}, sandbox);

		await testCompletion('view', '<Label text="foo" color="|"', {
			count: 24,
			items: [
				{ label: 'transparent', kind: CompletionItemKind.Value },
				{ label: 'red', kind: CompletionItemKind.Value },
			]
		}, sandbox);

		await testCompletion('view', '<ImageView text="foo" image="|"', {
			count: 1,
			items: [
				{ label: '/test.png' },
			]
		}, sandbox);

		await testCompletion('view', '<Label color="red" textid="|"', {
			count: 1,
			items: [
				{ label: 'test' },
			]
		}, sandbox);

		await testCompletion('view', '<Label text="foo" color="Alloy.CFG.|"', {
			count: 1,
			items: [
				{ label: 'test' },
			]
		}, sandbox);
	});

	it('should provide tss class completions', async () => {
		await testCompletion('view', '<Label class="|"', {
			count: 3,
			items: [
				{ label: 'testClass', kind: CompletionItemKind.Reference },
			]
		}, sandbox);
	});

	it('should provide tss id completions', async () => {
		await testCompletion('view', '<Label id="|"', {
			count: 3,
			items: [
				{ label: 'container', kind: CompletionItemKind.Reference },
			]
		}, sandbox);
	});

	it('should provide require src completions', async () => {
		await testCompletion('view', '<Require src="|"', {
			count: 5,
			items: [
				{ label: '/existing-file', kind: CompletionItemKind.Reference },
			]
		}, sandbox);

		await testCompletion('view', '<Require text="foo" src="|" test="bar', {
			count: 5,
			items: [
				{ label: '/existing-file', kind: CompletionItemKind.Reference },
			]
		}, sandbox);
	});

	it('should provide widget src completions', async () => {
		await testCompletion('view', '<Widget src="|"', {
			count: 1,
			items: [
				{ label: 'widget-test', kind: CompletionItemKind.Reference },
			]
		}, sandbox);

		await testCompletion('view', '<Widget text="foo" src="|" test="bar', {
			count: 1,
			items: [
				{ label: 'widget-test', kind: CompletionItemKind.Reference },
			]
		}, sandbox);
	});

	it('should provide custom tag completions', async () => {
		await testCompletion('view', '<CustomView module="|"/>', {
			count: 1,
			items: [
				{ label: '/folder/custom-view', kind: CompletionItemKind.Reference },
			]
		}, sandbox);
	});
});

import { describe, it } from 'mocha';
import { createSandbox } from 'sinon';
import { testCompletion } from '../../test-util';
import { CompletionItemKind } from 'vscode-languageserver';

describe('TiApp completions', () => {
	let sandbox: sinon.SinonSandbox;

	beforeEach(() => {
		sandbox = createSandbox();
	});

	afterEach(() => {
		sandbox.restore();
	});

	it('Should provide completions for SDK versions', async () => {
		await testCompletion('tiapp', '<sdk-version>|', {
			count: 2,
			items: [
				{ label: '12.1.0.GA', kind: CompletionItemKind.Value },
				{ label: '10.1.0.GA', kind: CompletionItemKind.Value }

			]
		}, sandbox);

		await testCompletion('tiapp', '<sdk-version>10.|', {
			count: 1,
			items: [
				{ label: '10.1.0.GA', kind: CompletionItemKind.Value }
			]
		}, sandbox);
	});

	it('Should provide completions for modules', async () => {
		await testCompletion('tiapp', '<module>|', {
			count: 1,
			items: [
				{ label: 'test.awesome', kind: CompletionItemKind.Module, detail: 'android' }

			]
		}, sandbox);

	});
});

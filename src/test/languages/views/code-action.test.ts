import { describe, it } from 'mocha';
import { createSandbox } from 'sinon';
import { testCodeAction, testCompletion } from '../../test-util';
import { CompletionItemKind, Range } from 'vscode-languageserver';

describe('View completions', () => {
	let sandbox: sinon.SinonSandbox;

	beforeEach(() => {
		sandbox = createSandbox();
	});

	afterEach(() => {
		sandbox.restore();
	});

	it('should provide code actions for new id', async () => {
		await testCodeAction('view', '<View id="noexistid|" class="noexistclass" onClick="noExistFunc" />', {
			count: 1,
			items: [
				{
					title: 'Generate style for id (sample.tss)',
					command: 'titanium.insertCodeAction',
					arguments: [ '\n"#noexistid": {\n}\n', '/Users/awam/git/tidev/titanium-language-server/src/test/fixtures/alloy-project/app/styles/sample.tss' ]
				}
			]
		}, sandbox, undefined, 'views/sample.xml');
	});

	it('should provide code actions for new class', async () => {
		await testCodeAction('view', '<View id="noexistid" class="noexistclass|" onClick="noExistFunc" />', {
			count: 1,
			items: [
				{
					title: 'Generate style for class (sample.tss)',
					command: 'titanium.insertCodeAction',
					arguments: [ '\n".noexistclass": {\n}\n', '/Users/awam/git/tidev/titanium-language-server/src/test/fixtures/alloy-project/app/styles/sample.tss' ]
				}
			]
		}, sandbox, undefined, 'views/sample.xml');
	});

	it('should provide code actions for new handler', async () => {
		await testCodeAction('view', '<View id="noexistid" class="noexistclass" onClick="noExistFunc|" />', {
			count: 1,
			items: [
				{
					title: 'Generate function (sample.js)',
					command: 'titanium.insertCodeAction',
					arguments: [ '\nfunction noExistFunc(e){\n}\n', '/Users/awam/git/tidev/titanium-language-server/src/test/fixtures/alloy-project/app/controllers/sample.js' ]
				}
			]
		}, sandbox, undefined, 'views/sample.xml');
	});
});

import { describe, it } from 'mocha';
import { createSandbox } from 'sinon';
import { getFixturePath, testCodeAction } from '../../test-util';

describe('View code actions', () => {
	let sandbox: sinon.SinonSandbox;

	beforeEach(() => {
		sandbox = createSandbox();
	});

	afterEach(() => {
		sandbox.restore();
	});

	it('should provide code actions for new id', async () => {
		const filePath = await getFixturePath('alloy-project/app/styles/sample.tss');
		await testCodeAction('view', '<View id="noexistid|" class="noexistclass" onClick="noExistFunc" />', {
			count: 1,
			items: [
				{
					title: 'Generate style for id (sample.tss)',
					command: 'titanium.insertCodeAction',
					arguments: [ '\n"#noexistid": {\n}\n', filePath ]
				}
			]
		}, sandbox, undefined, 'views/sample.xml');
	});

	it('should provide code actions for new class', async () => {
		const filePath = await getFixturePath('alloy-project/app/styles/sample.tss');
		await testCodeAction('view', '<View id="noexistid" class="noexistclass|" onClick="noExistFunc" />', {
			count: 1,
			items: [
				{
					title: 'Generate style for class (sample.tss)',
					command: 'titanium.insertCodeAction',
					arguments: [ '\n".noexistclass": {\n}\n', filePath ]
				}
			]
		}, sandbox, undefined, 'views/sample.xml');
	});

	it('should provide code actions for new handler', async () => {
		const filePath = await getFixturePath('alloy-project/app/controllers/sample.js');
		await testCodeAction('view', '<View id="noexistid" class="noexistclass" onClick="noExistFunc|" />', {
			count: 1,
			items: [
				{
					title: 'Generate function (sample.js)',
					command: 'titanium.insertCodeAction',
					arguments: [ '\nfunction noExistFunc(e){\n}\n', filePath ]
				}
			]
		}, sandbox, undefined, 'views/sample.xml');
	});

	it('should use the whole word when the cursor is inside it', async () => {
		const filePath = await getFixturePath('alloy-project/app/styles/sample.tss');
		await testCodeAction('view', '<View id="noexi|stid" />', {
			count: 1,
			items: [
				{
					title: 'Generate style for id (sample.tss)',
					command: 'titanium.insertCodeAction',
					arguments: [ '\n"#noexistid": {\n}\n', filePath ]
				}
			]
		}, sandbox, undefined, 'views/sample.xml');
	});

	it('should not offer to generate a style that already exists', async () => {
		// "#container" is already declared in styles/sample.tss
		await testCodeAction('view', '<View id="container|" />', {
			count: 0
		}, sandbox, undefined, 'views/sample.xml');

		// ".testClass" is already declared in styles/sample.tss
		await testCodeAction('view', '<View class="testClass|" />', {
			count: 0
		}, sandbox, undefined, 'views/sample.xml');
	});

	it('should not offer to generate a function that already exists', async () => {
		// doClick is already declared in controllers/sample.js
		await testCodeAction('view', '<View onClick="doClick|" />', {
			count: 0
		}, sandbox, undefined, 'views/sample.xml');
	});

	it('should not provide code actions when there is no word at the cursor', async () => {
		await testCodeAction('view', '<View id="|" />', {
			count: 0
		}, sandbox, undefined, 'views/sample.xml');
	});
});

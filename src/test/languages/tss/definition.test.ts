import { describe, it } from 'mocha';
import { createSandbox } from 'sinon';
import { Range } from 'vscode-languageserver';
import { getFixturePath, testDefinition } from '../../test-util';

describe('TSS Definitions', () => {
	let sandbox: sinon.SinonSandbox;

	beforeEach(() => {
		sandbox = createSandbox();
	});

	afterEach(() => {
		sandbox.restore();
	});

	it('should provide id definitions', async () => {
		await testDefinition('tss', '"#container|"', {
			count: 1,
			locations: [
				{
					range: Range.create(1, 19, 1, 0),
					uri: await getFixturePath('alloy-project/app/views/sample.xml'),
				}
			]
		}, sandbox, undefined, 'styles/sample.tss');
	});

	it('should provide class definitions', async () => {
		await testDefinition('tss', '".testClass|"', {
			count: 1,
			locations: [
				{
					range: Range.create(13, 9, 13, 0),
					uri: await getFixturePath('alloy-project/app/views/sample.xml'),
				}
			]
		}, sandbox, undefined, 'styles/sample.tss');
	});
});

import { describe, it } from 'mocha';
import { createSandbox } from 'sinon';
import { Position, Range } from 'vscode-languageserver';
import { getFixtureUri, testDefinition } from '../../test-util';

describe('View Definitions', () => {
	let sandbox: sinon.SinonSandbox;

	beforeEach(() => {
		sandbox = createSandbox();
	});

	afterEach(() => {
		sandbox.restore();
	});

	it('should provide id definitions', async () => {
		await testDefinition('view', '<Label id="|label" />', {
			count: 1,
			locations: [
				{
					range: Range.create(14, 0, 14, 8),
					uri: await getFixtureUri('alloy-project/app/styles/sample.tss'),
				}
			]
		}, sandbox, undefined, 'views/sample.xml');
	});

	it('should provide class definitions', async () => {
		await testDefinition('view', '<Label class="|testClass" />', {
			count: 1,
			locations: [
				{
					range: Range.create(36, 0, 36, 12),
					uri: await getFixtureUri('alloy-project/app/styles/sample.tss'),
				}
			]
		}, sandbox, undefined, 'views/sample.xml');
	});

	it('should provide tag definitions', async () => {
		await testDefinition('view', '<Labe|l class="testClass" />', {
			count: 2,
			locations: [
				{
					range: Range.create(4, 0, 4, 6),
					uri: await getFixtureUri('alloy-project/app/styles/sample.tss'),
				},
				{
					range: Range.create(13, 0, 13, 6),
					uri: await getFixtureUri('alloy-project/app/styles/app.tss'),
				}
			]
		}, sandbox, undefined, 'views/sample.xml');
	});

	it('should provide handler definitions', async () => {
		await testDefinition('view', '<Label onClick="doClic|k" />', {
			count: 1,
			locations: [
				{
					range: Range.create(20, 0, 20, 17),
					uri: await getFixtureUri('alloy-project/app/controllers/sample.js'),
				}
			]
		}, sandbox, undefined, 'views/sample.xml');
	});

	it('should provide i18n definitions', async () => {
		await testDefinition('view', '<Label text="L(\'tes|t\')" />', {
			count: 1,
			locations: [
				{
					range: Range.create(2, 9, 2, 36),
					uri: await getFixtureUri('alloy-project/app/i18n/en/strings.xml'),
				}
			]
		}, sandbox, undefined, 'views/sample.xml');
	});

	it('should provide widget definitions', async () => {
		await testDefinition('view', '<Widget src="|widget-test"/>', {
			count: 1,
			items: [
				{
					originSelectionRange: { start: Position.create(0, 12), end: Position.create(0, 24) },
					targetRange: { start: Position.create(0, 0), end: Position.create(0, 0) },
					targetUri: await getFixtureUri('alloy-project/app/widgets/widget-test/controllers/widget.js'),
					targetSelectionRange: { start: Position.create(0, 0), end: Position.create(0, 0) }
				}
			]
		}, sandbox, undefined, 'views/sample.xml');
	});

	it('should provide widget definitions', async () => {
		await testDefinition('view', '<Require src="|existing-file"/>', {
			count: 1,
			items: [
				{
					originSelectionRange: { start: Position.create(0, 13), end: Position.create(0, 27) },
					targetRange: { start: Position.create(0, 0), end: Position.create(0, 0) },
					targetUri: await getFixtureUri('alloy-project/app/controllers/existing-file.js'),
					targetSelectionRange: { start: Position.create(0, 0), end: Position.create(0, 0) }
				}
			]
		}, sandbox, undefined, 'views/sample.xml');
	});

	it('should provide custom tag definitions', async () => {
		await testDefinition('view', '<CustomView top="30" module="folder/custom-vie|w" />', {
			count: 1,
			items: [
				{
					originSelectionRange: { start: Position.create(0, 28), end: Position.create(0, 47) },
					targetRange: { start: Position.create(0, 0), end: Position.create(0, 0) },
					targetUri: await getFixtureUri('alloy-project/app/lib/folder/custom-view.js'),
					targetSelectionRange: { start: Position.create(0, 0), end: Position.create(0, 0) }
				}
			]
		}, sandbox, undefined, 'views/sample.xml');
	});
});

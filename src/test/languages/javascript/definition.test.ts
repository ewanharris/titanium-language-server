import { describe, it } from 'mocha';
import { createSandbox } from 'sinon';
import { Position } from 'vscode-languageserver';
import { getFixturePath, testDefinition } from '../../test-util';

describe('JavaScript definitions', () => {
	let sandbox: sinon.SinonSandbox;

	beforeEach(() => {
		sandbox = createSandbox();
	});

	afterEach(() => {
		sandbox.restore();
	});

	it('should provide require definition', async () => {
		await testDefinition('require(\'/|http\')', {
			count: 1,
			items: [
				{
					originSelectionRange: { start: Position.create(0, 8), end: Position.create(0, 14) },
					targetRange: { start: Position.create(0, 0), end: Position.create(0, 0) },
					targetUri: await getFixturePath('alloy-project/app/lib/http.js'),
					targetSelectionRange: { start: Position.create(0, 0), end: Position.create(0, 0) }
				}
			]
		}, sandbox);
	});

	it('should provide import definition', async () => {
		await testDefinition('import http from \'/|http\'', {
			count: 1,
			items: [
				{
					originSelectionRange: { start: Position.create(0, 17), end: Position.create(0, 23) },
					targetRange: { start: Position.create(0, 0), end: Position.create(0, 0) },
					targetUri: await getFixturePath('alloy-project/app/lib/http.js'),
					targetSelectionRange: { start: Position.create(0, 0), end: Position.create(0, 0) }
				}
			]
		}, sandbox);
	});
});

describe('Alloy definitions', () => {
	let sandbox: sinon.SinonSandbox;

	beforeEach(() => {
		sandbox = createSandbox();
	});

	afterEach(() => {
		sandbox.restore();
	});

	it('should provide Controller definition', async () => {
		await testDefinition('Alloy.createController(\'|sample\')', {
			count: 1,
			items: [
				{
					originSelectionRange: { start: Position.create(0, 23), end: Position.create(0, 30) },
					targetRange: { start: Position.create(0, 0), end: Position.create(0, 0) },
					targetUri: await getFixturePath('alloy-project/app/controllers/sample.js'),
					targetSelectionRange: { start: Position.create(0, 0), end: Position.create(0, 0) }
				}
			]
		}, sandbox);
	});

	it('should provide Collection and Model definition', async () => {
		await testDefinition('Alloy.createCollection(\'|test\')', {
			count: 1,
			items: [
				{
					originSelectionRange: { start: Position.create(0, 23), end: Position.create(0, 28) },
					targetRange: { start: Position.create(0, 0), end: Position.create(0, 0) },
					targetUri: await getFixturePath('alloy-project/app/models/test.js'),
					targetSelectionRange: { start: Position.create(0, 0), end: Position.create(0, 0) }
				}
			]
		}, sandbox);

		await testDefinition('Alloy.Collections.instance(\'|test\')', {
			count: 1,
			items: [
				{
					originSelectionRange: { start: Position.create(0, 27), end: Position.create(0, 32) },
					targetRange: { start: Position.create(0, 0), end: Position.create(0, 0) },
					targetUri: await getFixturePath('alloy-project/app/models/test.js'),
					targetSelectionRange: { start: Position.create(0, 0), end: Position.create(0, 0) }
				}
			]
		}, sandbox);

		await testDefinition('Alloy.createModel(\'|test\')', {
			count: 1,
			items: [
				{
					originSelectionRange: { start: Position.create(0, 18), end: Position.create(0, 23) },
					targetRange: { start: Position.create(0, 0), end: Position.create(0, 0) },
					targetUri: await getFixturePath('alloy-project/app/models/test.js'),
					targetSelectionRange: { start: Position.create(0, 0), end: Position.create(0, 0) }
				}
			]
		}, sandbox);

		await testDefinition('Alloy.Models.instance(\'|test\')', {
			count: 1,
			items: [
				{
					originSelectionRange: { start: Position.create(0, 22), end: Position.create(0, 27) },
					targetRange: { start: Position.create(0, 0), end: Position.create(0, 0) },
					targetUri: await getFixturePath('alloy-project/app/models/test.js'),
					targetSelectionRange: { start: Position.create(0, 0), end: Position.create(0, 0) }
				}
			]
		}, sandbox);
	});

	it('should provide Widget definition', async () => {
		await testDefinition('Alloy.createWidget(\'|widget-test\')', {
			count: 1,
			items: [
				{
					originSelectionRange: { start: Position.create(0, 19), end: Position.create(0, 31) },
					targetRange: { start: Position.create(0, 0), end: Position.create(0, 0) },
					targetUri: await getFixturePath('alloy-project/app/widgets/widget-test/controllers/widget.js'),
					targetSelectionRange: { start: Position.create(0, 0), end: Position.create(0, 0) }
				}
			]
		}, sandbox);
	});

	it('should provide Widget Controller definition', async () => {
		await testDefinition('Widget.createController(\'|test\')', {
			count: 1,
			items: [
				{
					originSelectionRange: { start: Position.create(0, 24), end: Position.create(0, 29) },
					targetRange: { start: Position.create(0, 0), end: Position.create(0, 0) },
					targetUri: await getFixturePath('alloy-project/app/widgets/widget-test/controllers/test.js'),
					targetSelectionRange: { start: Position.create(0, 0), end: Position.create(0, 0) }
				}
			]
		}, sandbox, undefined, 'widgets/widget-test/controllers/widget.js');
	});

	it('should provide Widget Model and Collection definition', async () => {
		await testDefinition('Widget.Collections.instance(\'|test\')', {
			count: 1,
			items: [
				{
					originSelectionRange: { start: Position.create(0, 28), end: Position.create(0, 33) },
					targetRange: { start: Position.create(0, 0), end: Position.create(0, 0) },
					targetUri: await getFixturePath('alloy-project/app/widgets/widget-test/models/test.js'),
					targetSelectionRange: { start: Position.create(0, 0), end: Position.create(0, 0) }
				}
			]
		}, sandbox, undefined, 'widgets/widget-test/controllers/widget.js');

		await testDefinition('Widget.createCollection(\'|test\')', {
			count: 1,
			items: [
				{
					originSelectionRange: { start: Position.create(0, 24), end: Position.create(0, 29) },
					targetRange: { start: Position.create(0, 0), end: Position.create(0, 0) },
					targetUri: await getFixturePath('alloy-project/app/widgets/widget-test/models/test.js'),
					targetSelectionRange: { start: Position.create(0, 0), end: Position.create(0, 0) }
				}
			]
		}, sandbox, undefined, 'widgets/widget-test/controllers/widget.js');

		await testDefinition('Widget.Models.instance(\'|test\')', {
			count: 1,
			items: [
				{
					originSelectionRange: { start: Position.create(0, 23), end: Position.create(0, 28) },
					targetRange: { start: Position.create(0, 0), end: Position.create(0, 0) },
					targetUri: await getFixturePath('alloy-project/app/widgets/widget-test/models/test.js'),
					targetSelectionRange: { start: Position.create(0, 0), end: Position.create(0, 0) }
				}
			]
		}, sandbox, undefined, 'widgets/widget-test/controllers/widget.js');

		await testDefinition('Widget.createModel(\'|test\')', {
			count: 1,
			items: [
				{
					originSelectionRange: { start: Position.create(0, 19), end: Position.create(0, 24) },
					targetRange: { start: Position.create(0, 0), end: Position.create(0, 0) },
					targetUri: await getFixturePath('alloy-project/app/widgets/widget-test/models/test.js'),
					targetSelectionRange: { start: Position.create(0, 0), end: Position.create(0, 0) }
				}
			]
		}, sandbox, undefined, 'widgets/widget-test/controllers/widget.js');
	});

});

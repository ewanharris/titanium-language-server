import { describe, it } from 'mocha';
import { createSandbox } from 'sinon';
import { Range } from 'vscode-languageserver';
import { getFixturePath, getFixtureUri, testHover } from '../../test-util';

describe('View Hovers', () => {
	let sandbox: sinon.SinonSandbox;

	beforeEach(() => {
		sandbox = createSandbox();
	});

	afterEach(() => {
		sandbox.restore();
	});

	it('should provide hover definitions for images', async () => {
		const imagePath = await getFixturePath('alloy-project/app/assets/test.png');
		const imageUri = await getFixtureUri('alloy-project/app/assets/test.png');
		await testHover('view', '<ImageView image="/assets/test.png|">', {
			contents: `![${imagePath}](${imageUri}|height=100)`,
			range: Range.create(0, 18, 0, 34)
		}, sandbox);
	});

	it('should not error when the assets directory does not exist', async () => {
		await testHover('view', '<ImageView image="/assets/test.png|">', {
			contents: 'Image not found',
			range: Range.create(0, 18, 0, 34)
		}, sandbox, { type: 'classic', sdkVersion: '10.1.0.GA' });
	});
});

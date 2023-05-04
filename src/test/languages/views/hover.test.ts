import { describe, it } from 'mocha';
import { createSandbox } from 'sinon';
import { getFixturePath, testHover } from '../../test-util';

describe('View Definitions', () => {
	let sandbox: sinon.SinonSandbox;

	beforeEach(() => {
		sandbox = createSandbox();
	});

	afterEach(() => {
		sandbox.restore();
	});

	it('should provide hover definitions for images', async () => {
		const imagePath = await getFixturePath('alloy-project/app/assets/test.png');
		await testHover('view', '<ImageView image="/assets/test.png|">', {
			contents: `![${imagePath}](${imagePath}|height=100)`
		}, sandbox);
	});
});

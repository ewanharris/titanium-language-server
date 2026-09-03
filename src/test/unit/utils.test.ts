import { describe, it } from 'mocha';
import { expect } from 'chai';
import path from 'path';
import { filterFiles } from '../../utils';
import { getFixturePath } from '../test-util';

describe('filterFiles', () => {

	it('should return the matching files in a directory', async () => {
		const files = await filterFiles(await getFixturePath('alloy-project/app/lib'), [ '.js' ]);
		expect(files.map(file => path.basename(file)).sort()).to.deep.equal([ 'custom-view.js', 'http.js' ]);
	});

	it('should return an empty array for a directory that does not exist', async () => {
		const files = await filterFiles(path.join(await getFixturePath('alloy-project'), 'no-such-directory'), [ '.js' ]);
		expect(files).to.deep.equal([]);
	});
});

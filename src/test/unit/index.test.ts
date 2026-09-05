import { describe, it } from 'mocha';
import { expect } from 'chai';
import fs from 'fs';
import { CustomRequests, serverPath } from '../../index';

describe('package entry points', () => {

	it('should expose a resolvable server path for extensions that bundle the server', () => {
		expect(serverPath).to.be.a('string');
		expect(fs.existsSync(serverPath)).to.equal(true);
	});

	it('should declare no custom protocol', () => {
		// Every custom request is something each editor has to implement before the server works
		// there. This asserts the target of zero, so adding one is a deliberate decision with a
		// failing test attached rather than something that quietly creeps in.
		expect(Object.keys(CustomRequests)).to.deep.equal([]);
	});
});

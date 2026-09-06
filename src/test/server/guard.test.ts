import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { safely } from '../../server/guard.js';
import { logger } from '../../logger.js';

describe('Containing a provider that throws', () => {

	const errors: string[] = [];

	afterEach(() => {
		logger.detach();
		errors.length = 0;
	});

	it('should return what the work returned when nothing goes wrong', async () => {
		assert.equal(await safely('working', 'fallback', () => Promise.resolve('answer')), 'answer');
	});

	it('should answer with the fallback rather than rejecting', async () => {
		logger.attach({ log: () => undefined, error: message => errors.push(message) });

		const result = await safely('finding a definition', null, () => {
			throw new Error('the sky fell in');
		});

		assert.equal(result, null);
		assert.ok(errors.some(message => message.includes('finding a definition') && message.includes('the sky fell in')));
	});

	it('should report something thrown that is not an error', async () => {
		logger.attach({ log: () => undefined, error: message => errors.push(message) });

		assert.deepEqual(await safely('finding a definition', [], () => Promise.reject('a string')), []);
		assert.ok(errors.some(message => message.includes('a string')));
	});
});

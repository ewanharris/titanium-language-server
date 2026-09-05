import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { RemoteConsole } from 'vscode-languageserver';
import { logger } from '../../logger.js';

/**
 * A RemoteConsole stood up with node:test mock functions, so calls to it can be asserted on.
 */
function mockConsole (): RemoteConsole {
	return { log: mock.fn(), error: mock.fn() } as unknown as RemoteConsole;
}

function callsOf (fn: unknown): unknown[][] {
	return (fn as ReturnType<typeof mock.fn>).mock.calls.map(call => call.arguments);
}

describe('logger', () => {

	afterEach(() => {
		mock.restoreAll();
		mock.reset();
		logger.detach();
	});

	it('should send messages to the client when attached', () => {
		const remoteConsole = mockConsole();
		logger.attach(remoteConsole);

		logger.log('a message');
		logger.error('an error');

		assert.deepEqual(callsOf(remoteConsole.log), [ [ 'a message' ] ]);
		assert.deepEqual(callsOf(remoteConsole.error), [ [ 'an error' ] ]);
	});

	it('should write to stderr when not attached, never stdout', () => {
		// stdout is the JSON-RPC transport; writing to it corrupts the protocol stream
		const stderr = mock.method(process.stderr, 'write', () => true);
		const stdout = mock.method(process.stdout, 'write', () => true);

		logger.log('a message');
		logger.error('an error');

		const written = stderr.mock.calls.map(call => call.arguments[0]);
		const leaked = stdout.mock.calls.length;
		mock.restoreAll();

		assert.equal(leaked, 0);
		assert.deepEqual(written, [ 'a message\n', 'an error\n' ]);
	});

	it('should stop sending to the client once detached', () => {
		const remoteConsole = mockConsole();
		logger.attach(remoteConsole);
		logger.detach();
		const stderr = mock.method(process.stderr, 'write', () => true);

		logger.log('a message');

		mock.restoreAll();
		assert.equal(stderr.mock.calls.length, 1);
		assert.deepEqual(callsOf(remoteConsole.log), []);
	});
});

import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import { createSandbox } from 'sinon';
import { RemoteConsole } from 'vscode-languageserver';
import { logger } from '../../logger';

describe('logger', () => {
	const sandbox = createSandbox();

	afterEach(() => {
		sandbox.restore();
		logger.detach();
	});

	it('should send messages to the client when attached', () => {
		const remoteConsole = { log: sandbox.stub(), error: sandbox.stub() } as unknown as RemoteConsole;
		logger.attach(remoteConsole);

		logger.log('a message');
		logger.error('an error');

		expect((remoteConsole.log as sinon.SinonStub).calledOnceWith('a message')).to.equal(true);
		expect((remoteConsole.error as sinon.SinonStub).calledOnceWith('an error')).to.equal(true);
	});

	it('should write to stderr when not attached, never stdout', () => {
		// stdout is the JSON-RPC transport; writing to it corrupts the protocol stream
		const stderr = sandbox.stub(process.stderr, 'write').returns(true);
		const stdout = sandbox.stub(process.stdout, 'write').returns(true);

		logger.log('a message');
		logger.error('an error');

		expect(stdout.called).to.equal(false);
		expect(stderr.args.map(args => args[0])).to.deep.equal([ 'a message\n', 'an error\n' ]);
	});

	it('should stop sending to the client once detached', () => {
		const remoteConsole = { log: sandbox.stub(), error: sandbox.stub() } as unknown as RemoteConsole;
		logger.attach(remoteConsole);
		logger.detach();
		sandbox.stub(process.stderr, 'write').returns(true);

		logger.log('a message');

		expect((remoteConsole.log as sinon.SinonStub).called).to.equal(false);
	});
});

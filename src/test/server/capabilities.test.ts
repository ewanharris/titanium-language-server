import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClientCapabilities } from '../../server/capabilities.ts';

describe('server/capabilities', () => {

	describe('snippets', () => {

		it('should be supported when the client says so', () => {
			const capabilities = new ClientCapabilities({
				textDocument: { completion: { completionItem: { snippetSupport: true } } }
			});

			assert.equal(capabilities.snippets, true);
		});

		it('should not be supported when the client says nothing at all', () => {
			// the case that matters: a client that never mentions completions is not one that
			// quietly supports snippets, and assuming otherwise puts literal ${1} in a user's file
			assert.equal(new ClientCapabilities({}).snippets, false);
		});

		it('should not be supported when the client answers the question with false', () => {
			const capabilities = new ClientCapabilities({
				textDocument: { completion: { completionItem: { snippetSupport: false } } }
			});

			assert.equal(capabilities.snippets, false);
		});

		it('should not be supported when the client stops part way down the chain', () => {
			// each level is optional in the protocol, so a client may declare completions without
			// declaring anything about the items in them
			assert.equal(new ClientCapabilities({ textDocument: {} }).snippets, false);
			assert.equal(new ClientCapabilities({ textDocument: { completion: {} } }).snippets, false);
			assert.equal(new ClientCapabilities({ textDocument: { completion: { completionItem: {} } } }).snippets, false);
		});
	});

	describe('showDocument', () => {

		it('should be supported when the client says so', () => {
			assert.equal(new ClientCapabilities({ window: { showDocument: { support: true } } }).showDocument, true);
		});

		it('should not be supported when the client says nothing', () => {
			assert.equal(new ClientCapabilities({}).showDocument, false);
			assert.equal(new ClientCapabilities({ window: {} }).showDocument, false);
		});
	});

	describe('code action literals', () => {

		it('should be supported when the client declares the option', () => {
			// presence is the signal: the protocol carries the supported kinds inside it rather
			// than a boolean beside it
			const capabilities = new ClientCapabilities({
				textDocument: { codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: [] } } } }
			});

			assert.equal(capabilities.codeActionLiterals, true);
		});

		it('should not be supported when the client says nothing', () => {
			assert.equal(new ClientCapabilities({}).codeActionLiterals, false);
			assert.equal(new ClientCapabilities({ textDocument: { codeAction: {} } }).codeActionLiterals, false);
		});
	});

	describe('workspace folders', () => {

		it('should be supported when the client says so', () => {
			assert.equal(new ClientCapabilities({ workspace: { workspaceFolders: true } }).workspaceFolders, true);
		});

		it('should not be supported when the client says nothing', () => {
			assert.equal(new ClientCapabilities({}).workspaceFolders, false);
		});
	});
});

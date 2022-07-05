import { describe, it } from 'mocha';
import { JSProvider } from '../../../languages/javascript';
import { createSandbox } from 'sinon';
import { CompletionItem, CompletionItemKind, CompletionItemTag, CompletionParams, Connection } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Project } from '../../../project';
import { expect } from 'chai';
import { getFixture } from '../../test-util';

interface ProjectInfo {
	type: 'alloy' | 'classic';
	sdkVersion: string;
}

interface ExpectedData {
	count?: number;
	items?: CompletionItem[];
}

describe('JavaScript completions', () => {
	let sandbox: sinon.SinonSandbox;

	function assertCompletions (completions: CompletionItem[], expected: CompletionItem) {
		// todo

		const matches = completions.filter(completion => completion.label === expected.label);

		expect(matches.length).to.equal(1, `${expected.label} should exist once`);
		const match = matches[0];

		if (expected.kind) {
			expect(match.kind).to.equal(expected.kind);
		}

		if (expected.tags) {
			expect(match.tags).to.deep.equal(expected.tags);
		}
	}

	async function testCompletion (value: string, expected: ExpectedData, projectInfo: ProjectInfo = { type: 'alloy', sdkVersion: '10.1.0.GA' }) {
		const offset = value.indexOf('|');
		value = value.substring(0, offset) + value.substring(offset + 1);

		const connectionStub = sandbox.stub();
		const provider = new JSProvider(connectionStub as unknown as Connection);

		const document = TextDocument.create('test://test/test.js', 'javascript', 0, value);
		const position =  document.positionAt(offset);
		const project = sandbox.createStubInstance(Project);
		project.type.resolves(projectInfo.type);
		project.sdkVersion.returns(projectInfo.sdkVersion);

		const completions = await getFixture(`${projectInfo.sdkVersion}.json`);
		sandbox.stub(provider, 'loadCompletions').resolves(JSON.parse(completions));

		const returnData = await provider.doCompletion({ position } as CompletionParams, document, project);

		if (!returnData) {
			throw new Error('doCompletion didn\'t return a value');
		}
		// FIXME: probably should have doCompletion always return something?
		if (expected.count) {
			expect(returnData?.length).to.equal(expected.count);
		}

		if (expected.items) {
			for (const item of expected.items) {
				assertCompletions(returnData, item);
			}
		}
	}

	beforeEach(() => {
		sandbox = createSandbox();
	});

	afterEach(() => {
		sandbox.restore();
	});

	it('Should provide completions for functions', async () => {
		await testCompletion('Ti.UI.createWind|', {
			count: 1,
			items: [
				{ label: 'createWindow', kind: CompletionItemKind.Method }
			]
		});
	});

	it('Should provide completions for properties', async () => {
		// This should be a constant?
		await testCompletion('Ti.UI.ANIMATION_CURVE_LI|', {
			count: 1,
			items: [
				{ label: 'ANIMATION_CURVE_LINEAR', kind: CompletionItemKind.Property }
			]
		});

		await testCompletion('Ti.UI.apiN|', {
			count: 1,
			items: [
				{ label: 'apiName', kind: CompletionItemKind.Property }
			]
		});
	});

	it('should provide combined', async () => {
		await testCompletion('Ti.|', {
			count: 200
		});
	});

	it('should provide deprecated information', async () => {
		await testCompletion('Ti.Analytics.navE|', {
			count: 1,
			items: [
				{ label: 'navEvent', kind: CompletionItemKind.Method, tags: [ CompletionItemTag.Deprecated ] }
			]
		});
	});
});

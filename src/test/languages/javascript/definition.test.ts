import { describe, it } from 'mocha';
import { JSProvider } from '../../../languages/javascript';
import { createSandbox } from 'sinon';
import { Project } from '../../../project';
import { Connection, Definition, DefinitionLink, DefinitionParams, LocationLink, Position } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getFixture, getFixturePath } from '../../test-util';
import { expect } from 'chai';

interface ExpectedData {
	count?: number;
	items?: DefinitionLink[]
}

interface ProjectInfo {
	type: 'alloy' | 'classic';
	sdkVersion: string;
}

describe('JavaScript definitions', () => {
	let sandbox: sinon.SinonSandbox;

	function assertDefinitions(definitions: DefinitionLink[], expected: DefinitionLink) {
		const matches = definitions.filter(definition => definition.targetUri === expected.targetUri);
		expect(matches.length).to.equal(1, `${expected} should exist once`);

		const match = matches[0];
		expect(expected).to.deep.equal(match);
	}

	async function testDefinition(value: string, expected: ExpectedData, projectInfo: ProjectInfo = { type: 'alloy', sdkVersion: '10.1.0.GA' }) {
		const offset = value.indexOf('|');
		value = value.substring(0, offset) + value.substring(offset + 1);

		const connectionStub = sandbox.stub();
		const provider = new JSProvider(connectionStub as unknown as Connection);

		const document = TextDocument.create('test://test/test.js', 'javascript', 0, value);
		const position =  document.positionAt(offset);
		const project = sandbox.createStubInstance(Project);
		project.filePath = await getFixturePath('alloy-project');
		project.type.resolves(projectInfo.type);
		project.sdkVersion.returns(projectInfo.sdkVersion);

		const completions = await getFixture(`${projectInfo.sdkVersion}.json`);
		sandbox.stub(provider, 'loadCompletions').resolves(JSON.parse(completions));

		const returnData = await provider.doDefinition({ position } as DefinitionParams, document, project) as DefinitionLink[];

		if (!returnData) {
			throw new Error('doCompletion didn\'t return a value');
		}

		// FIXME: probably should have doCompletion always return something?
		if (expected.count) {
			expect(returnData?.length).to.equal(expected.count);
		}

		if (expected.items) {
			for (const item of expected.items) {
				assertDefinitions(returnData, item);
			}
		}
	}

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
		});
	});
});

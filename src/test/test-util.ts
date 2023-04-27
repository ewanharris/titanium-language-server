import fs from 'fs-extra';
import path from 'path';
import { JSProvider } from '../languages/javascript';
import { CompletionItem, CompletionParams, Connection } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Project } from '../project';
import { expect } from 'chai';

const fixtures = path.join(__dirname, '..', '..', 'src', 'test', 'fixtures');

export async function getFixturePath(fixtureName: string): Promise<string> {
	const fixturePath = path.join(fixtures, fixtureName);

	if (!await fs.pathExists(fixturePath)) {
		throw new Error(`Cannot find ${fixtureName} at ${fixturePath}`);
	}

	return fixturePath;
}

export async function getFixture (fixtureName: string): Promise<string> {
	const fixturePath = await getFixturePath(fixtureName);
	return fs.readFile(fixturePath, 'utf-8');
}

interface ProjectInfo {
	type: 'alloy' | 'classic';
	sdkVersion: string;
}

interface ExpectedData {
	count?: number;
	items?: CompletionItem[];
}

function assertCompletions (completions: CompletionItem[], expected: CompletionItem) {
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

export async function testCompletion (value: string, expected: ExpectedData, sandbox: sinon.SinonSandbox, projectInfo: ProjectInfo = { type: 'alloy', sdkVersion: '10.1.0.GA' }): Promise<void> {
	const offset = value.indexOf('|');
	value = value.substring(0, offset) + value.substring(offset + 1);

	const connectionStub = sandbox.stub();
	const provider = new JSProvider(connectionStub as unknown as Connection);

	const filePath = await getFixturePath('alloy-project/app/controllers/sample.js');
	const document = TextDocument.create(filePath, 'javascript', 0, value);
	const position =  document.positionAt(offset);
	const project = new Project(await getFixturePath('alloy-project'));
	await project.load();
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

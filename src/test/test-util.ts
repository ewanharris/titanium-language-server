import fs from 'fs-extra';
import path from 'path';
import { JSProvider } from '../languages/javascript';
import { TiappProvider } from '../languages/tiapp';
import { TSSProvider } from '../languages/tss';
import { XMLProvider } from '../languages/view';
import { CodeActionParams, Command, CompletionItem, CompletionParams, Connection, DefinitionLink, DefinitionParams, Hover, HoverParams, Location, Range } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Project } from '../project';
import { expect } from 'chai';

const fixtures = path.join(__dirname, '..', '..', 'src', 'test', 'fixtures');

export async function getFixturePath(fixtureName: string): Promise<string> {
	const fixturePath = path.join(fixtures, fixtureName);

	if (!await fs.pathExists(fixturePath)) {
		throw new Error(`Cannot find ${fixtureName} at ${fixturePath}`);
	}

	// If we're on Windows then lowercase the drive letter because that's what the API returns
	if (process.platform !== 'win32') {
		return fixturePath;
	}
	const { root } = path.parse(fixturePath);
	return `${root.substr(0, 1).toLowerCase()}${fixturePath.slice(1)}`;
}

export async function getFixture (fixtureName: string): Promise<string> {
	const fixturePath = await getFixturePath(fixtureName);
	return fs.readFile(fixturePath, 'utf-8');
}

interface ProjectInfo {
	type: 'alloy' | 'classic';
	sdkVersion: string;
}

interface ExpectedCompletions {
	count?: number;
	items?: CompletionItem[];
}

interface ExpectedCodeActions {
	count?: number;
	items?: Command[];
}

async function createTextDocument (alloyFile: string, value: string) {
	const filePath = await getFixturePath(`alloy-project/app/${alloyFile}`);
	return TextDocument.create(filePath, 'javascript', 0, value);
}

function createProvider (provider: string) {
	const connection = {
		sendRequest: async (request: string) => {
			switch (request) {
				case 'titanium/installedSdks':
					return [ { fullversion: '12.1.0.GA' }, { fullversion: '10.1.0.GA' } ];
				default:
					throw new Error(`Unknown request ${request}`);
			}
		}
	} as unknown as Connection;

	switch (provider) {
		case 'js':
			return new JSProvider(connection);
		case 'tiapp':
			return new TiappProvider(connection);
		case 'tss':
			return new TSSProvider(connection);
		case 'view':
			return new XMLProvider(connection);
		default:
			throw new Error(`Unknown provider ${provider}`);
	}
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

export async function testCompletion (providerType: string, value: string, expected: ExpectedCompletions, sandbox: sinon.SinonSandbox, projectInfo: ProjectInfo = { type: 'alloy', sdkVersion: '10.1.0.GA' }, filename = 'controllers/sample.js'): Promise<void> {
	const offset = value.indexOf('|');
	value = value.substring(0, offset) + value.substring(offset + 1);

	const provider = createProvider(providerType);

	const document = await createTextDocument(filename, value);
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

interface ExpectedDefinitions {
	count?: number;
	items?: DefinitionLink[];
	locations?: Location[];
}

function assertDefinitions(definitions: DefinitionLink[], expected: DefinitionLink) {
	const matches = definitions.filter(definition => definition.targetUri === expected.targetUri);
	expect(matches.length).to.equal(1, `${expected.targetUri} should exist once`);

	const match = matches[0];
	expect(expected).to.deep.equal(match);
}

function assertLocations(locations: Location[], expected: Location) {
	const matches = locations.filter(location => location.uri === expected.uri);
	expect(matches.length).to.equal(1, `${expected.uri} should exist once`);

	const match = matches[0];
	expect(expected).to.deep.equal(match);
}

export async function testDefinition(providerType: string, value: string, expected: ExpectedDefinitions, sandbox: sinon.SinonSandbox, projectInfo: ProjectInfo = { type: 'alloy', sdkVersion: '10.1.0.GA' }, filename = 'controllers/sample.js') {
	const offset = value.indexOf('|');
	value = value.substring(0, offset) + value.substring(offset + 1);

	const provider = createProvider(providerType);

	const document = await createTextDocument(filename, value);
	const position =  document.positionAt(offset);
	const project = sandbox.createStubInstance(Project);
	project.filePath = await getFixturePath('alloy-project');
	project.type.resolves(projectInfo.type);
	project.sdkVersion.returns(projectInfo.sdkVersion);
	project.i18nPath.resolves(await getFixturePath('alloy-project/app/i18n'));

	const completions = await getFixture(`${projectInfo.sdkVersion}.json`);
	sandbox.stub(provider, 'loadCompletions').resolves(JSON.parse(completions));

	const returnData = await provider.doDefinition({ position } as DefinitionParams, document, project) as DefinitionLink[];
	console.log(returnData);
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

	if (expected.locations) {
		for (const item of expected.locations) {
			assertLocations(returnData as unknown as Location[], item);
		}
	}
}

function assertCodeActions(codeActions: Command[], expected: Command) {
	expect(codeActions.length).to.equal(1, 'should exist once');

	const match = codeActions[0];
	expect(expected).to.deep.equal(match);
}

export async function testCodeAction(providerType: string, value: string, expected: ExpectedCodeActions, sandbox: sinon.SinonSandbox, projectInfo: ProjectInfo = { type: 'alloy', sdkVersion: '10.1.0.GA' }, filename = 'controllers/sample.js') {
	const offset = value.indexOf('|');
	value = value.substring(0, offset) + value.substring(offset + 1);

	const provider = createProvider(providerType);
	// const filePath = await getFixturePath(`alloy-project/app/${filename}`);
	// const value = await fs.readFile(filePath, 'utf8');
	const document = await createTextDocument(filename, value);
	const position =  document.positionAt(offset);
	const range = Range.create(position, position);
	const project = sandbox.createStubInstance(Project);
	project.filePath = await getFixturePath('alloy-project');
	project.type.resolves(projectInfo.type);
	project.sdkVersion.returns(projectInfo.sdkVersion);
	project.i18nPath.resolves(await getFixturePath('alloy-project/app/i18n'));

	const completions = await getFixture(`${projectInfo.sdkVersion}.json`);
	sandbox.stub(provider, 'loadCompletions').resolves(JSON.parse(completions));

	const returnData = await provider.doCodeAction({ range } as CodeActionParams, document, project) as Command[];

	if (!returnData) {
		throw new Error('doCompletion didn\'t return a value');
	}

	// FIXME: probably should have doCompletion always return something?
	if (expected.count) {
		expect(returnData?.length).to.equal(expected.count);
	}

	if (expected.items) {
		for (const item of expected.items) {
			assertCodeActions(returnData, item);
		}
	}
}

export async function testHover(providerType: string, value: string, expected: Hover, sandbox: sinon.SinonSandbox, projectInfo: ProjectInfo = { type: 'alloy', sdkVersion: '10.1.0.GA' }, filename = 'controllers/sample.js') {
	const offset = value.indexOf('|');
	value = value.substring(0, offset) + value.substring(offset + 1);

	const provider = createProvider(providerType);
	const document = await createTextDocument(filename, value);
	const position =  document.positionAt(offset);
	const project = sandbox.createStubInstance(Project);
	project.filePath = await getFixturePath('alloy-project');
	project.type.resolves(projectInfo.type);
	project.sdkVersion.returns(projectInfo.sdkVersion);
	project.i18nPath.resolves(await getFixturePath('alloy-project/app/i18n'));

	const completions = await getFixture(`${projectInfo.sdkVersion}.json`);
	sandbox.stub(provider, 'loadCompletions').resolves(JSON.parse(completions));

	const returnData = await provider.doHover({ position } as HoverParams, document, project) as Hover;

	if (!returnData) {
		throw new Error('doCompletion didn\'t return a value');
	}

	expect(expected).to.deep.equal(returnData);
}

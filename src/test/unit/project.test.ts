import { describe, it } from 'mocha';
import { expect } from 'chai';
import path from 'path';
import { Project } from '../../project';
import { getFixturePath } from '../test-util';

describe('Project', () => {

	it('should load a valid Titanium project', async () => {
		const project = new Project(await getFixturePath('alloy-project'));
		expect(await project.load()).to.equal(true);
		expect(project.isValid).to.equal(true);
		expect(project.sdkVersion()).to.equal('10.1.0.GA');
		expect(await project.type()).to.equal('alloy');
	});

	it('should not be valid when the directory is not a Titanium project', async () => {
		const project = new Project(await getFixturePath('not-a-project'));
		expect(await project.load()).to.equal(false);
		expect(project.isValid).to.equal(false);
	});

	it('should not be valid when the directory does not exist', async () => {
		const project = new Project(path.join(await getFixturePath('not-a-project'), 'nope'));
		expect(await project.load()).to.equal(false);
		expect(project.isValid).to.equal(false);
	});

	it('should not be valid when the tiapp.xml has no sdk-version', async () => {
		const project = new Project(await getFixturePath('no-sdk-project'));
		expect(await project.load()).to.equal(false);
		expect(project.isValid).to.equal(false);
	});

	it('should throw a helpful error when asked for a missing sdk version', async () => {
		const project = new Project(await getFixturePath('no-sdk-project'));
		await project.load();
		expect(() => project.sdkVersion()).to.throw(/No sdk-version is set/);
	});

	it('should only report directories as locally installed modules', async () => {
		const project = new Project(await getFixturePath('alloy-project'));
		await project.load();
		const modules = await project.locallyInstalledModules();
		expect(modules).to.deep.equal([
			{ name: 'test.awesome', platforms: [ 'android' ] },
			{ name: 'ti.map', platforms: [ 'iphone' ] }
		]);
	});

	it('should return an empty list for directories that do not exist', async () => {
		const project = new Project(await getFixturePath('not-a-project'));
		await project.load();
		expect(await project.libFiles()).to.deep.equal([]);
		expect(await project.controllers()).to.deep.equal([]);
		expect(await project.styles()).to.deep.equal([]);
		expect(await project.views()).to.deep.equal([]);
	});
});

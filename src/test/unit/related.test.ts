import { describe, it } from 'mocha';
import { expect } from 'chai';
import path from 'path';
import { getTargetPath } from '../../related';
import { Project } from '../../project';
import { getFixturePath } from '../test-util';

describe('getTargetPath', () => {

	async function createProject (): Promise<Project> {
		const project = new Project(await getFixturePath('alloy-project'));
		await project.load();
		return project;
	}

	it('should find the related file for a controller', async () => {
		const project = await createProject();
		const controller = await getFixturePath('alloy-project/app/controllers/sample.js');
		expect(await getTargetPath(project, 'xml', controller)).to.equal(await getFixturePath('alloy-project/app/views/sample.xml'));
		expect(await getTargetPath(project, 'tss', controller)).to.equal(await getFixturePath('alloy-project/app/styles/sample.tss'));
	});

	it('should accept a file uri', async () => {
		const project = await createProject();
		const controller = await getFixturePath('alloy-project/app/controllers/sample.js');
		const uri = `file://${controller.startsWith('/') ? '' : '/'}${controller.replace(/\\/g, '/')}`;
		expect(await getTargetPath(project, 'xml', uri)).to.equal(await getFixturePath('alloy-project/app/views/sample.xml'));
	});

	it('should find the related file for a widget', async () => {
		const project = await createProject();
		const widget = await getFixturePath('alloy-project/app/widgets/widget-test/controllers/widget.js');
		expect(await getTargetPath(project, 'xml', widget)).to.equal(await getFixturePath('alloy-project/app/widgets/widget-test/views/widget.xml'));
	});

	it('should prefer a TypeScript controller', async () => {
		const project = await createProject();
		const view = await getFixturePath('alloy-project/app/views/ts-lookup.xml');
		expect(await getTargetPath(project, 'js', view)).to.equal(await getFixturePath('alloy-project/app/controllers/ts-lookup.ts'));
	});

	it('should not resolve a related file for a file that has none', async () => {
		const project = await createProject();
		// app/lib is not a controller, style, view or widget, so it has no related file
		expect(await getTargetPath(project, 'xml', await getFixturePath('alloy-project/app/lib/http.js'))).to.equal(undefined);
		expect(await getTargetPath(project, 'xml', await getFixturePath('alloy-project/app/alloy.js'))).to.equal(undefined);
	});

	it('should not resolve a related file for a file outside of the project', async () => {
		const project = await createProject();
		const outside = path.join(await getFixturePath('not-a-project'), 'controllers', 'sample.js');
		expect(await getTargetPath(project, 'xml', outside)).to.equal(undefined);
	});
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileKind, fileRole, route } from '../../core/routing.ts';
import { Project } from '../../core/project.ts';
import { ProjectRegistry } from '../../core/registry.ts';
import { fixturePath } from '../fixtures.ts';

describe('Routing', () => {

	describe('file kind', () => {
		it('should read a VS Code language id', () => {
			assert.equal(fileKind('xml', '/a/b.xml'), 'xml');
			assert.equal(fileKind('tss', '/a/b.tss'), 'tss');
			assert.equal(fileKind('javascript', '/a/b.js'), 'javascript');
			assert.equal(fileKind('typescript', '/a/b.ts'), 'typescript');
		});

		it('should read a grammar name, case insensitively', () => {
			// Pulsar reports its grammar names rather than language ids
			assert.equal(fileKind('Alloy (TSS)', '/a/b.tss'), 'tss');
			assert.equal(fileKind('Alloy (XML)', '/a/b.xml'), 'xml');
			assert.equal(fileKind('ALLOY (XML)', '/a/b.xml'), 'xml');
		});

		it('should not read a TypeScript id as JavaScript', () => {
			assert.equal(fileKind('typescriptreact', '/a/b.tsx'), 'typescript');
			assert.equal(fileKind('javascriptreact', '/a/b.jsx'), 'javascript');
		});

		it('should fall back to the extension when the id says nothing', () => {
			// an editor that has no grammar for TSS reports it as plain text
			assert.equal(fileKind('plaintext', '/a/b.tss'), 'tss');
			assert.equal(fileKind('', '/a/b.xml'), 'xml');
			assert.equal(fileKind('', '/a/b.ts'), 'typescript');
			assert.equal(fileKind('', '/a/b.js'), 'javascript');
		});

		it('should answer unknown for anything else', () => {
			assert.equal(fileKind('json', '/a/b.json'), 'unknown');
			assert.equal(fileKind('', '/a/b'), 'unknown');
		});
	});

	describe('file role in an Alloy project', () => {
		let project: Project;

		const roleOf = async (...segments: string[]): Promise<string> =>
			fileRole(project, path.join(project.filePath, ...segments));

		it('should derive the role from the layout', async () => {
			project = new Project(await fixturePath('alloy-project'));
			await project.load();

			assert.equal(await roleOf('app', 'views', 'index.xml'), 'view');
			assert.equal(await roleOf('app', 'styles', 'index.tss'), 'style');
			assert.equal(await roleOf('app', 'controllers', 'index.js'), 'controller');
			assert.equal(await roleOf('app', 'models', 'thing.js'), 'model');
			assert.equal(await roleOf('app', 'lib', 'thing.js'), 'lib');
			assert.equal(await roleOf('app', 'alloy.js'), 'alloy');
			assert.equal(await roleOf('app', 'i18n', 'en', 'strings.xml'), 'i18n');
			assert.equal(await roleOf('tiapp.xml'), 'tiapp');
		});

		it('should derive the same roles inside a widget', async () => {
			project = new Project(await fixturePath('alloy-project'));
			await project.load();

			assert.equal(await roleOf('app', 'widgets', 'widget-test', 'views', 'widget.xml'), 'view');
			assert.equal(await roleOf('app', 'widgets', 'widget-test', 'styles', 'widget.tss'), 'style');
			assert.equal(await roleOf('app', 'widgets', 'widget-test', 'controllers', 'widget.js'), 'controller');
		});

		it('should answer unknown for a nested view directory that is not one', async () => {
			project = new Project(await fixturePath('alloy-project'));
			await project.load();

			assert.equal(await roleOf('app', 'assets', 'test.png'), 'unknown');
			assert.equal(await roleOf('build', 'views', 'index.xml'), 'unknown');
			assert.equal(await roleOf('app', 'widgets', 'widget-test', 'widget.json'), 'unknown');
		});

		it('should answer unknown for a file outside the project', async () => {
			project = new Project(await fixturePath('alloy-project'));
			await project.load();

			assert.equal(await fileRole(project, path.join(path.dirname(project.filePath), 'elsewhere.xml')), 'unknown');
		});
	});

	describe('file role in a classic project', () => {
		it('should read Resources as source, and know nothing of Alloy', async () => {
			const project = new Project(await fixturePath('classic-project'));
			await project.load();
			const roleOf = async (...segments: string[]): Promise<string> =>
				fileRole(project, path.join(project.filePath, ...segments));

			assert.equal(await roleOf('Resources', 'app.js'), 'source');
			assert.equal(await roleOf('Resources', 'lib', 'http.js'), 'source');
			assert.equal(await roleOf('i18n', 'en', 'strings.xml'), 'i18n');
			assert.equal(await roleOf('tiapp.xml'), 'tiapp');
			// a loose file at the root is not in any of them
			assert.equal(await roleOf('README.md'), 'unknown');
			// a classic project with these directories has them by coincidence, not as Alloy
			assert.equal(await roleOf('app', 'views', 'index.xml'), 'unknown');
		});
	});

	describe('routing a document', () => {
		it('should answer the project, kind and role together', async () => {
			const registry = new ProjectRegistry();
			const root = await fixturePath('alloy-project');
			await registry.add([ root ]);

			const routed = await route(registry, path.join(root, 'app', 'views', 'index.xml'), 'Alloy (XML)');

			assert.equal(routed?.project.filePath, root);
			assert.equal(routed?.kind, 'xml');
			assert.equal(routed?.role, 'view');
		});

		it('should answer nothing for a file in no registered project', async () => {
			const registry = new ProjectRegistry();

			assert.equal(await route(registry, '/somewhere/app/views/index.xml', 'xml'), undefined);
		});
	});
});

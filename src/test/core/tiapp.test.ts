import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { tiappCompletionsAt } from '../../core/tiapp.ts';
import type { InstalledSource } from '../../core/tiapp.ts';
import type { TitaniumInstall } from '../../core/titanium.ts';
import type { ViewCompletion } from '../../core/view.ts';
import { fixturePath } from '../fixtures.ts';

/** Two SDKs, newest first, and the fixture standing in for the Titanium home's modules */
async function machine (): Promise<TitaniumInstall> {
	return {
		sdks: [
			{ version: '13.0.0.GA', path: '/sdk/13.0.0.GA' },
			{ version: '12.4.0.GA', path: '/sdk/12.4.0.GA' },
			{ version: '9.3.2.GA', path: '/sdk/9.3.2.GA' }
		],
		moduleDirectories: [ path.join(await fixturePath('titanium-home'), 'modules') ]
	};
}

const installed = (install: TitaniumInstall): InstalledSource => ({ installed: async () => install });

/**
 * The completions offered where `|` marks the cursor in a project's tiapp.xml
 *
 * @param text - The tiapp.xml source, with `|` marking the cursor
 * @param fixture - The project the tiapp.xml belongs to, whose modules directory is read
 * @param install - What the CLI says is installed
 * @returns {Promise<ViewCompletion[]>} What is offered there
 */
async function completionsAt (text: string, fixture = 'alloy-project', install?: TitaniumInstall): Promise<ViewCompletion[]> {
	return tiappCompletionsAt({
		tiapp: { path: path.join(await fixturePath(fixture), 'tiapp.xml'), text: text.replace('|', '') },
		offset: text.indexOf('|'),
		titanium: installed(install ?? await machine())
	});
}

async function labelsAt (text: string, fixture?: string): Promise<string[]> {
	return (await completionsAt(text, fixture)).map(completion => completion.label);
}

const tiapp = (body: string): string => `<?xml version="1.0" encoding="UTF-8"?>\n<ti:app xmlns:ti="http://ti.appcelerator.org">\n\t${body}\n</ti:app>\n`;

describe('Completion in a tiapp.xml', () => {

	describe('sdk-version', () => {
		it('should offer the installed SDKs, newest first', async () => {
			const found = await completionsAt(tiapp('<sdk-version>|</sdk-version>'));

			assert.deepEqual(found.map(completion => completion.label), [ '13.0.0.GA', '12.4.0.GA', '9.3.2.GA' ]);
			// a client sorts by label without one, and 9.3.2.GA sorts after 13.0.0.GA as a string
			const sorted = [ ...found ].sort((a, b) => (a.sortText as string).localeCompare(b.sortText as string));
			assert.deepEqual(sorted.map(completion => completion.label), [ '13.0.0.GA', '12.4.0.GA', '9.3.2.GA' ]);
			assert.equal(found[0].detail, '/sdk/13.0.0.GA');
		});

		it('should replace the version already written, wherever the cursor is in it', async () => {
			const text = tiapp('<sdk-version>12.4.0.GA</sdk-version>');
			const start = text.indexOf('12.4.0.GA');
			const cursor = start + '12.'.length;

			const [ first ] = await completionsAt(`${text.slice(0, cursor)}|${text.slice(cursor)}`);

			assert.deepEqual(first.range, { start, end: start + '12.4.0.GA'.length });
		});

		it('should replace nothing in an element that is still empty, or still being typed', async () => {
			const empty = tiapp('<sdk-version>\n\t\t|\n\t</sdk-version>');
			const typing = tiapp('<sdk-version>12.|');

			assert.deepEqual((await completionsAt(empty))[0].range, { start: empty.indexOf('|'), end: empty.indexOf('|') });
			assert.deepEqual((await completionsAt(typing))[0].range, { start: typing.indexOf('12.'), end: typing.indexOf('|') });
		});

		it('should offer nothing when the CLI found nothing', async () => {
			// the same posture as a project without types: a smaller answer, not an error
			assert.deepEqual(await completionsAt(tiapp('<sdk-version>|</sdk-version>'), 'alloy-project', { sdks: [], moduleDirectories: [] }), []);
		});

		it('should offer nothing anywhere else', async () => {
			assert.deepEqual(await labelsAt(tiapp('<name>|</name>')), []);
			assert.deepEqual(await labelsAt(tiapp('<sdk-version>12</sdk-version>|')), []);
			assert.deepEqual(await labelsAt(tiapp('<!-- <sdk-version>|</sdk-version> -->')), []);
		});
	});

	describe('module', () => {
		it('should offer the modules installed in the project and globally, once each', async () => {
			const labels = await labelsAt(tiapp('<modules><module>|</module></modules>'));

			assert.deepEqual(labels, [ 'test.awesome', 'ti.cloud', 'ti.map' ]);
		});

		it('should say which platforms and versions each one is installed for, and where', async () => {
			const map = (await completionsAt(tiapp('<modules><module>|</module></modules>'))).find(completion => completion.label === 'ti.map');

			assert.equal(map?.kind, 'module');
			assert.equal(map?.detail, 'android, ios');
			assert.match(map?.documentation ?? '', /android 5\.6\.0 \(global\)/);
			assert.match(map?.documentation ?? '', /ios 7\.3\.1 \(project\)/);
		});

		it('should work the same in a classic project', async () => {
			assert.ok((await labelsAt(tiapp('<modules><module>|</module></modules>'), 'classic-project')).includes('ti.classic'));
		});

		it('should offer only the modules installed for the platform the element names', async () => {
			assert.deepEqual(await labelsAt(tiapp('<modules><module platform="commonjs">|</module></modules>')), [ 'ti.cloud' ]);
			assert.deepEqual(await labelsAt(tiapp('<modules><module platform="android">|</module></modules>')), [ 'test.awesome', 'ti.map' ]);
			// a tiapp writes iphone as often as ios, and the CLI reads them as one
			assert.deepEqual(await labelsAt(tiapp('<modules><module platform="iphone">|</module></modules>')), [ 'ti.map' ]);
		});

		it('should replace the id already written', async () => {
			const text = tiapp('<modules><module>ti.ma</module></modules>');
			const start = text.indexOf('ti.ma');

			const [ first ] = await completionsAt(`${text.slice(0, start + 3)}|${text.slice(start + 3)}`);

			assert.deepEqual(first.range, { start, end: start + 'ti.ma'.length });
		});

		it('should offer the platforms the module is installed for', async () => {
			assert.deepEqual(await labelsAt(tiapp('<modules><module platform="|">ti.map</module></modules>')), [ 'android', 'ios' ]);
			assert.deepEqual(await labelsAt(tiapp('<modules><module platform="|">ti.cloud</module></modules>')), [ 'commonjs' ]);
		});

		it('should offer every installed platform before the module is named', async () => {
			assert.deepEqual(await labelsAt(tiapp('<modules><module platform="|"></module></modules>')), [ 'android', 'commonjs', 'ios' ]);
		});

		it('should offer the versions installed of the module, on the platform named, newest first', async () => {
			const versions = await completionsAt(tiapp('<modules><module version="|">ti.map</module></modules>'));

			assert.deepEqual(versions.map(completion => completion.label), [ '7.3.1', '5.6.0' ]);
			assert.deepEqual(await labelsAt(tiapp('<modules><module platform="android" version="|">ti.map</module></modules>')), [ '5.6.0' ]);
		});

		it('should replace the value and not the quotes around it', async () => {
			const text = tiapp('<modules><module platform="andr">ti.map</module></modules>');
			const start = text.indexOf('andr');

			const [ first ] = await completionsAt(`${text.slice(0, start + 2)}|${text.slice(start + 2)}`);

			assert.deepEqual(first.range, { start, end: start + 'andr'.length });
		});

		it('should offer nothing in an attribute it knows nothing about', async () => {
			assert.deepEqual(await labelsAt(tiapp('<modules><module foo="|">ti.map</module></modules>')), []);
		});

		it('should offer the deploy types, each entry of the list on its own', async () => {
			assert.deepEqual(await labelsAt(tiapp('<modules><module deploy-type="|">ti.map</module></modules>')), [ 'development', 'test', 'production' ]);
			// the build splits the list on commas, and one already listed is not offered again
			assert.deepEqual(await labelsAt(tiapp('<modules><module deploy-type="development,|">ti.map</module></modules>')), [ 'test', 'production' ]);
		});

		it('should replace the entry the cursor is in, and nothing else of the list', async () => {
			const text = tiapp('<modules><module deploy-type="development, test">ti.map</module></modules>');
			const start = text.indexOf('test"');
			const cursor = start + 'te'.length;

			const [ first ] = await completionsAt(`${text.slice(0, cursor)}|${text.slice(cursor)}`);

			assert.deepEqual(first.range, { start, end: start + 'test'.length });
		});

		it('should not ask the CLI for an attribute whose values are not installed ones', async () => {
			// the first request waits for the CLI, which may hang until it times out, and a fixed list
			// has no reason to wait with it
			let asked = 0;
			const counting: InstalledSource = { installed: async () => {
				asked++;
				return machine();
			} };

			for (const attribute of [ 'deploy-type', 'foo' ]) {
				const text = tiapp(`<modules><module ${attribute}="|">ti.map</module></modules>`);
				await tiappCompletionsAt({
					tiapp: { path: path.join(await fixturePath('alloy-project'), 'tiapp.xml'), text: text.replace('|', '') },
					offset: text.indexOf('|'),
					titanium: counting
				});
			}

			assert.equal(asked, 0);
		});

		it('should read a project with no modules directory, and a machine with no global modules', async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ti-ls-tiapp-'));

			const text = tiapp('<modules><module></module></modules>');

			const found = await tiappCompletionsAt({
				tiapp: { path: path.join(root, 'tiapp.xml'), text },
				offset: text.indexOf('</module>'),
				titanium: installed({ sdks: [], moduleDirectories: [] })
			});

			assert.deepEqual(found, []);
		});
	});

	describe('values', () => {
		it('should offer the types a property can be read as', async () => {
			assert.deepEqual(await labelsAt(tiapp('<property name="a" type="|">x</property>')), [ 'string', 'bool', 'int', 'double' ]);
		});

		it('should offer true and false to a bool property, and nothing to any other', async () => {
			assert.deepEqual(await labelsAt(tiapp('<property name="a" type="bool">|</property>')), [ 'true', 'false' ]);
			assert.deepEqual(await labelsAt(tiapp('<property name="a" type="int">|</property>')), []);
			assert.deepEqual(await labelsAt(tiapp('<property name="a">|</property>')), []);
		});

		it('should offer the units both platforms read for ti.ui.defaultunit', async () => {
			const units = [ 'system', 'dp', 'dip', 'px', 'mm', 'cm', 'in' ];

			assert.deepEqual(await labelsAt(tiapp('<property name="ti.ui.defaultunit">|</property>')), units);
			assert.deepEqual(await labelsAt(tiapp('<property name="ti.ui.defaultunit" type="string">|</property>')), units);
		});

		it('should offer the devices a deployment target names, and true or false for each', async () => {
			assert.deepEqual(await labelsAt(tiapp('<deployment-targets><target device="|">true</target></deployment-targets>')), [ 'android', 'iphone', 'ipad' ]);
			assert.deepEqual(await labelsAt(tiapp('<deployment-targets><target device="ipad">|</target></deployment-targets>')), [ 'true', 'false' ]);
		});

		it('should offer true and false to the flags people toggle', async () => {
			for (const flag of [ 'fullscreen', 'navbar-hidden', 'statusbar-hidden' ]) {
				assert.deepEqual(await labelsAt(tiapp(`<${flag}>|</${flag}>`)), [ 'true', 'false' ], flag);
			}
			for (const flag of [ 'use-app-thinning', 'use-autolayout' ]) {
				assert.deepEqual(await labelsAt(tiapp(`<ios><${flag}>|</${flag}></ios>`)), [ 'true', 'false' ], flag);
			}
		});

		it('should replace the value already written', async () => {
			const text = tiapp('<fullscreen>false</fullscreen>');
			const start = text.indexOf('false');
			const cursor = start + 'fa'.length;

			const [ first ] = await completionsAt(`${text.slice(0, cursor)}|${text.slice(cursor)}`);

			assert.deepEqual(first.range, { start, end: start + 'false'.length });
		});

		it('should offer nothing where the element is not where the build reads it', async () => {
			// a target outside deployment-targets, and an ios flag at the top level, are read by nothing
			assert.deepEqual(await labelsAt(tiapp('<target device="|">true</target>')), []);
			assert.deepEqual(await labelsAt(tiapp('<target>|</target>')), []);
			assert.deepEqual(await labelsAt(tiapp('<use-autolayout>|</use-autolayout>')), []);
			assert.deepEqual(await labelsAt(tiapp('<android><fullscreen>|</fullscreen></android>')), []);
			// an element named for something every object has is still an element like any other
			assert.deepEqual(await labelsAt(tiapp('<constructor>|</constructor>')), []);
		});

		it('should offer nothing to a lookalike nested anywhere but where the build reads it', async () => {
			// the build reads property, deployment-targets and ios from the root alone, and an
			// Android manifest has property elements of its own
			assert.deepEqual(await labelsAt(tiapp('<android><manifest><application><property name="a" type="|"/></application></manifest></android>')), []);
			assert.deepEqual(await labelsAt(tiapp('<android><property name="a" type="bool">|</property></android>')), []);
			assert.deepEqual(await labelsAt(tiapp('<android><deployment-targets><target device="|">true</target></deployment-targets></android>')), []);
			assert.deepEqual(await labelsAt(tiapp('<android><ios><use-autolayout>|</use-autolayout></ios></android>')), []);
		});

		it('should offer SDKs and modules only where the build reads them', async () => {
			assert.deepEqual(await labelsAt(tiapp('<ios><sdk-version>|</sdk-version></ios>')), []);
			assert.deepEqual(await labelsAt(tiapp('<module>|</module>')), []);
			assert.deepEqual(await labelsAt(tiapp('<android><modules><module>|</module></modules></android>')), []);
			assert.deepEqual(await labelsAt(tiapp('<android><modules><module platform="|">ti.map</module></modules></android>')), []);
		});
	});
});

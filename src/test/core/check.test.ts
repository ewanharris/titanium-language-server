import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sortRules, styledElements } from '../../core/cascade.ts';
import type { CascadeSource } from '../../core/cascade.ts';
import { findingsInStyle, findingsInView, messageFor, replacementFor, unknownProperties } from '../../core/check.ts';
import { Project } from '../../core/project.ts';
import { SourceCache } from '../../core/references.ts';
import { fixturePath } from '../fixtures.ts';
import type { CheckedView, Finding } from '../../core/check.ts';
import type { ApiMember } from '../../core/typescript/host.ts';

const APP = '/project/app/styles/app.tss';
const INDEX = '/project/app/styles/index.tss';
const VIEW = '/project/app/views/index.xml';

/** The members each type has, by the path into it, for a fake that needs no parsed program */
type Members = Record<string, Record<string, string[]>>;

/**
 * An `ApiSource` that answers from a table.
 *
 * A type the table does not name answers nothing, which is what `ProjectService.membersOf` does
 * for a tag `@types/titanium` has never heard of — the case that has to stay silent.
 *
 * @param members - The members, by type and then by dotted path, `''` for the type's own
 * @returns An api that reads them
 */
function api (members: Members): { membersOf (type: string, path?: string[]): ApiMember[] } {
	return {
		membersOf (type: string, path: string[] = []): ApiMember[] {
			const names = members[type]?.[path.join('.')] ?? [];
			return names.map(name => ({ name, kind: 'property', readonly: false, type: 'any', documentation: '' }));
		}
	};
}

const LABEL = { 'Titanium.UI.Label': { '': [ 'color', 'text', 'width', 'font' ], font: [ 'fontSize', 'fontWeight' ] } };

/**
 * The findings for one view and its stylesheets
 *
 * @param view - The view
 * @param styles - The stylesheets, `app.tss` first
 * @param members - What each type has
 * @returns {Finding[]} The findings
 */
function check (view: string, styles: CascadeSource[], members: Members): Finding[] {
	const source = { path: VIEW, text: view };
	const checked: CheckedView = { view: source, elements: styledElements(source), rules: sortRules(styles) };
	return unknownProperties([ checked ], api(members));
}

describe('core/check', () => {

	describe('stylesheet properties', () => {

		it('says nothing about a property the type has', () => {
			const findings = check('<Alloy><Label id="a"/></Alloy>', [
				{ path: INDEX, text: '"#a": { color: "red", text: "hi" }' }
			], LABEL);

			assert.deepEqual(findings, []);
		});

		it('flags a property the type does not have, where it is written', () => {
			const style = '"#a": { color: "red", widht: 10 }';
			const findings = check('<Alloy><Label id="a"/></Alloy>', [ { path: INDEX, text: style } ], LABEL);

			assert.equal(findings.length, 1);
			assert.equal(findings[0].property, 'widht');
			assert.equal(findings[0].file, INDEX);
			assert.equal(findings[0].selector, '#a');
			assert.equal(style.slice(findings[0].range.start, findings[0].range.end), 'widht');
		});

		it('offers the name it was probably meant to be', () => {
			const findings = check('<Alloy><Label id="a"/></Alloy>', [
				{ path: INDEX, text: '"#a": { widht: 10 }' }
			], LABEL);

			assert.equal(findings[0].suggestion, 'width');
		});

		it('offers the name a wrong case was meant to be', () => {
			const findings = check('<Alloy><Label id="a"/></Alloy>', [
				{ path: INDEX, text: '"#a": { Color: "red" }' }
			], LABEL);

			assert.equal(findings[0].suggestion, 'color');
		});

		it('offers nothing when no name is close', () => {
			const findings = check('<Alloy><Label id="a"/></Alloy>', [
				{ path: INDEX, text: '"#a": { somethingElseEntirely: 10 }' }
			], LABEL);

			assert.equal(findings[0].suggestion, undefined);
		});

		it('reads a nested property against the type the outer one holds', () => {
			const findings = check('<Alloy><Label id="a"/></Alloy>', [
				{ path: INDEX, text: '"#a": { font: { fontSize: 12, fontWieght: "bold" } }' }
			], LABEL);

			assert.equal(findings.length, 1);
			assert.equal(findings[0].property, 'font.fontWieght');
			assert.equal(findings[0].suggestion, 'fontWeight');
		});

		it('checks a rule that only applies on some builds', () => {
			const findings = check('<Alloy><Label id="a"/></Alloy>', [
				{ path: INDEX, text: '"#a[platform=android]": { widht: 10 }' }
			], LABEL);

			assert.equal(findings.length, 1);
			assert.equal(findings[0].property, 'widht');
		});

		it('reports a rule once however many elements it styles', () => {
			const findings = check('<Alloy><Label id="a"/><Label id="b"/><Label id="c"/></Alloy>', [
				{ path: INDEX, text: '"Label": { widht: 10 }' }
			], LABEL);

			assert.equal(findings.length, 1);
			assert.equal(findings[0].selector, 'Label');
		});

		it('reports each stylesheet that writes the same bad name', () => {
			const findings = check('<Alloy><Label id="a"/></Alloy>', [
				{ path: APP, text: '"Label": { widht: 10 }' },
				{ path: INDEX, text: '"#a": { widht: 20 }' }
			], LABEL);

			assert.deepEqual(findings.map(finding => finding.file).sort(), [ APP, INDEX ]);
		});
	});

	describe('view attributes', () => {

		it('flags an attribute the type does not have', () => {
			const view = '<Alloy><Label id="a" colr="red"/></Alloy>';
			const findings = check(view, [], LABEL);

			assert.equal(findings.length, 1);
			assert.equal(findings[0].property, 'colr');
			assert.equal(findings[0].file, VIEW);
			assert.equal(findings[0].selector, undefined);
			assert.equal(view.slice(findings[0].range.start, findings[0].range.end), 'colr');
		});

		it('says nothing about the attributes Alloy reads for itself', () => {
			const findings = check(
				'<Alloy><Label id="a" class="x" platform="ios" if="Alloy.Globals.y" onClick="go" module="m" bindId="b"/></Alloy>',
				[], LABEL
			);

			assert.deepEqual(findings, []);
		});
	});

	describe('what it will not guess at', () => {

		it('says nothing when the project has no types for the element', () => {
			const findings = check('<Alloy><Label id="a"/></Alloy>', [
				{ path: INDEX, text: '"#a": { widht: 10 }' }
			], {});

			assert.deepEqual(findings, []);
		});

		it('keeps a property one of the elements a rule styles does have', () => {
			const findings = check('<Alloy><Label class="c"/><Window class="c"/></Alloy>', [
				{ path: INDEX, text: '".c": { text: "hi", orientationModes: [ 1 ] }' }
			], {
				...LABEL,
				'Titanium.UI.Window': { '': [ 'orientationModes', 'backgroundColor' ] }
			});

			assert.deepEqual(findings, []);
		});

		it('flags a property none of them has', () => {
			const findings = check('<Alloy><Label class="c"/><Window class="c"/></Alloy>', [
				{ path: INDEX, text: '".c": { nonsense: 1 }' }
			], {
				...LABEL,
				'Titanium.UI.Window': { '': [ 'orientationModes', 'backgroundColor' ] }
			});

			assert.equal(findings.length, 1);
			assert.deepEqual(findings[0].types.sort(), [ 'Titanium.UI.Label', 'Titanium.UI.Window' ]);
		});

		it('says nothing when one element a rule styles has no types', () => {
			const findings = check('<Alloy><Label class="c"/><Thing class="c" module="native"/></Alloy>', [
				{ path: INDEX, text: '".c": { strokeWidth: 2 }' }
			], LABEL);

			assert.deepEqual(findings, []);
		});

		it('says nothing about an element inside abstract markup', () => {
			// <ButtonBar> translates <Labels> to BarItemTypes, whose children Alloy turns into a
			// plain `labels` array — so `image` is a property of that array's entries and these
			// were never Label proxies, whatever the tag says
			const findings = check(
				'<Alloy><ButtonBar><Labels><Label image="/a.png"/><Label image="/b.png"/></Labels></ButtonBar></Alloy>',
				[], { ...LABEL, 'Titanium.UI.ButtonBar': { '': [ 'labels', 'index' ] } }
			);

			assert.deepEqual(findings, []);
		});

		it('still checks the element the abstract markup is inside', () => {
			const findings = check(
				'<Alloy><ButtonBar indx="0"><Labels><Label image="/a.png"/></Labels></ButtonBar></Alloy>',
				[], { ...LABEL, 'Titanium.UI.ButtonBar': { '': [ 'labels', 'index' ] } }
			);

			assert.equal(findings.length, 1);
			assert.equal(findings[0].property, 'indx');
			assert.equal(findings[0].suggestion, 'index');
		});

		it('allows the ActionBar properties a Toolbar inherits when it is one', () => {
			// Ti.UI.Toolbar.js hands these to the activity rather than to the proxy
			const findings = check('<Alloy><Window customToolbar="t"><Toolbar id="t"/></Window></Alloy>', [
				{ path: INDEX, text: '"#t": { displayHomeAsUp: true, homeButtonEnabled: true, navigationMode: 1 }' }
			], {
				'Titanium.UI.Toolbar': { '': [ 'barColor', 'items' ] },
				'Titanium.UI.Window': { '': [ 'backgroundColor', 'title' ] }
			});

			assert.deepEqual(findings, []);
		});

		it('allows the attribute Alloy reads off a Window to find its toolbar', () => {
			const findings = check('<Alloy><Window customToolbar="t"><Toolbar id="t"/></Window></Alloy>', [], {
				'Titanium.UI.Toolbar': { '': [ 'barColor', 'items' ] },
				'Titanium.UI.Window': { '': [ 'backgroundColor', 'title' ] }
			});

			assert.deepEqual(findings, []);
		});
	});

	describe('rules shared between elements', () => {

		const SHARED: Members = {
			...LABEL,
			'Titanium.UI.Window': { '': [ 'backgroundColor', 'title' ] },
			'Titanium.UI.Toolbar': { '': [ 'barColor', 'items' ] },
			'Titanium.UI.View': { '': [ 'backgroundColor', 'width' ] }
		};

		it('says nothing about a rule that also styles a <Require>, whose attributes are its controller\'s', () => {
			const findings = check('<Alloy><Label class="s"/><Require src="row" class="s"/></Alloy>', [
				{ path: INDEX, text: '".s": { customOption: 1 }' }
			], SHARED);

			assert.deepEqual(findings, []);
		});

		it('says nothing about a rule that also styles a <Widget>', () => {
			const findings = check('<Alloy><Label class="s"/><Widget src="badge" class="s"/></Alloy>', [
				{ path: INDEX, text: '".s": { customOption: 1 }' }
			], SHARED);

			assert.deepEqual(findings, []);
		});

		it('says nothing about a <Module>, which a native module creates rather than Titanium', () => {
			const findings = check('<Alloy><Window><Module module="ti.map" class="s" region="r"/><Label class="s"/></Window></Alloy>', [
				{ path: INDEX, text: '".s": { mapType: 1 }' }
			], SHARED);

			assert.deepEqual(findings, []);
		});

		it('says nothing about an element a module= attribute hands to a native module', () => {
			// Alloy creates it with require('ti.foo').createView, so it is not a Ti.UI.View
			const findings = check('<Alloy><View module="ti.foo" special="1"/></Alloy>', [], SHARED);

			assert.deepEqual(findings, []);
		});

		it('accepts a property Alloy reads off one element for every element the rule styles, in either order', () => {
			for (const view of [ '<Alloy><Window><Toolbar class="s"/><Label class="s"/></Window></Alloy>', '<Alloy><Window><Label class="s"/><Toolbar class="s"/></Window></Alloy>' ]) {
				assert.deepEqual(check(view, [ { path: INDEX, text: '".s": { displayHomeAsUp: true }' } ], SHARED), []);
			}
			assert.deepEqual(check('<Alloy><Window class="s"><Label class="s"/></Window></Alloy>', [ { path: INDEX, text: '".s": { customToolbar: "t" }' } ], SHARED), []);
		});

		it('finds a misspelt nested name although another element has no such object at all', () => {
			// a Window has no font, which says nothing about whether the Label's is spelt right
			const findings = check('<Alloy><Window class="s"><Label class="s"/></Window></Alloy>', [
				{ path: INDEX, text: '".s": { font: { fntSize: 12 } }' }
			], SHARED);

			assert.deepEqual(findings.map(finding => [ finding.property, finding.suggestion ]), [ [ 'font.fntSize', 'fontSize' ] ]);
		});
	});

	describe('nested properties', () => {

		it('finds a misspelt object name once, where it is written, however much is inside it', () => {
			const style = '"#a": { fnt: { fontSize: 12, fontWeight: "bold" } }';
			const findings = check('<Alloy><Label id="a"/></Alloy>', [ { path: INDEX, text: style } ], LABEL);

			assert.deepEqual(findings.map(finding => [ finding.property, finding.suggestion ]), [ [ 'fnt', 'font' ] ]);
			assert.equal(style.slice(findings[0].range.start, findings[0].range.end), 'fnt');
		});

		it('finds a misspelt object name in a dotted attribute, and points at that name alone', () => {
			const view = '<Alloy><Label id="a" fnt.fontSize="3"/></Alloy>';
			const findings = check(view, [], LABEL);

			assert.deepEqual(findings.map(finding => [ finding.property, finding.suggestion ]), [ [ 'fnt', 'font' ] ]);
			assert.equal(view.slice(findings[0].range.start, findings[0].range.end), 'fnt');
		});

		it('says nothing about an object written where the property holds something else, which is a value', () => {
			const findings = check('<Alloy><Label id="a"/></Alloy>', [ { path: INDEX, text: '"#a": { color: { red: 1 } }' } ], LABEL);

			assert.deepEqual(findings, []);
		});
	});

	describe('in a project', () => {

		const MEMBERS: Members = {
			...LABEL,
			'Titanium.UI.Window': { '': [ 'backgroundColor', 'title', 'width' ] }
		};

		/**
		 * The project, with the files a test writes laid over it as open buffers
		 *
		 * @param buffers - Paths under `app/`, and what each holds
		 * @param fixture - The project
		 * @returns The project, its root and a cache that reads the buffers
		 */
		async function open (buffers: Record<string, string> = {}, fixture = 'alloy-project'): Promise<{ project: Project; root: string; cache: SourceCache }> {
			const root = await fixturePath(fixture);
			const project = new Project(root);
			await project.load();

			const cache = new SourceCache();
			for (const [ name, text ] of Object.entries(buffers)) {
				cache.override(path.join(root, 'app', name), text);
			}

			return { project, root, cache };
		}

		it('reports a view\'s own attributes, and not what its stylesheets get wrong', async () => {
			const view = '<Alloy><Window><Label id="label" colr="red"/></Window></Alloy>';
			const { project, root, cache } = await open({ 'views/index.xml': view, 'styles/index.tss': '"#label": { widht: 1 }' });
			const file = path.join(root, 'app', 'views', 'index.xml');

			const findings = await findingsInView({ project, view: { path: file, text: view }, api: api(MEMBERS), cache });

			assert.deepEqual(findings.map(finding => [ finding.file, finding.property ]), [ [ file, 'colr' ] ]);
			assert.equal(findings[0].suggestion, 'color');
		});

		it('reports a stylesheet\'s properties, and not what its view gets wrong', async () => {
			const style = '"Label": { widht: 1, color: "red" }';
			const { project, root, cache } = await open({ 'views/index.xml': '<Alloy><Window><Label colr="red"/></Window></Alloy>' });
			const file = path.join(root, 'app', 'styles', 'index.tss');

			const findings = await findingsInStyle({ project, style: { path: file, text: style }, api: api(MEMBERS), cache });

			assert.deepEqual(findings.map(finding => [ finding.file, finding.property ]), [ [ file, 'widht' ] ]);
			assert.equal(style.slice(findings[0].range.start, findings[0].range.end), 'widht');
		});

		it('judges app.tss against every view in the project, widgets included', async () => {
			// a Label in one view, a Window in another and a Label in the widget, all of one class
			const style = '".shared": { text: "a", title: "b", bogus: 1 }';
			const { project, root, cache } = await open({
				'views/index.xml': '<Alloy><Label class="shared"/></Alloy>',
				'views/sample.xml': '<Alloy><Window class="shared"/></Alloy>'
			});

			const findings = await findingsInStyle({ project, style: { path: path.join(root, 'app', 'styles', 'app.tss'), text: style }, api: api(MEMBERS), cache });

			assert.deepEqual(findings.map(finding => finding.property), [ 'bogus' ]);
			assert.deepEqual(findings[0].types.toSorted(), [ 'Titanium.UI.Label', 'Titanium.UI.Window' ]);
		});

		it('checks the stylesheet as it is being edited, not as it was saved', async () => {
			const { project, root, cache } = await open({ 'views/index.xml': '<Alloy><Label id="label"/></Alloy>', 'styles/index.tss': '"#label": { color: "red" }' });

			const findings = await findingsInStyle({ project, style: { path: path.join(root, 'app', 'styles', 'index.tss'), text: '"#label": { colr: "red" }' }, api: api(MEMBERS), cache });

			assert.deepEqual(findings.map(finding => finding.property), [ 'colr' ]);
		});

		it('says nothing about a stylesheet no view is styled by', async () => {
			const { project, root, cache } = await open();

			const findings = await findingsInStyle({ project, style: { path: path.join(root, 'app', 'styles', 'nowhere.tss'), text: '"Label": { bogus: 1 }' }, api: api(MEMBERS), cache });

			assert.deepEqual(findings, []);
		});

		it('says nothing about a theme no build selects, since it styles nothing', async () => {
			// config.json picks dark, so light's copy of the view's stylesheet never loads
			const { project, root, cache } = await open({}, 'alloy-themed-project');
			const style = { path: path.join(root, 'app', 'themes', 'light', 'styles', 'index.tss'), text: '"#title": { bogus: 1 }' };

			assert.deepEqual(await findingsInStyle({ project, style, api: api(MEMBERS), cache }), []);
			// and the same rule in the theme that is selected is checked
			const dark = { path: path.join(root, 'app', 'themes', 'dark', 'styles', 'index.tss'), text: style.text };
			assert.deepEqual((await findingsInStyle({ project, style: dark, api: api(MEMBERS), cache })).map(finding => finding.property), [ 'bogus' ]);
		});

		it('says nothing in a classic project', async () => {
			const { project, root } = await open({}, 'classic-project');
			const view = '<Alloy><Label colr="red"/></Alloy>';

			const findings = await findingsInView({ project, view: { path: path.join(root, 'app', 'views', 'index.xml'), text: view }, api: api(MEMBERS), cache: new SourceCache() });

			assert.deepEqual(findings, []);
		});
	});

	describe('the fix for a finding', () => {

		const MEMBERS: Members = LABEL;

		/**
		 * The text a finding's fix leaves behind
		 *
		 * @param style - The stylesheet
		 * @param view - The view
		 * @returns What each fix makes of the file it is in, in the order the findings came
		 */
		function fixed (style: string, view = '<Alloy><Label id="a"/></Alloy>'): (string|undefined)[] {
			const texts: Record<string, string> = { [INDEX]: style, [VIEW]: view };
			return check(view, [ { path: INDEX, text: style } ], MEMBERS).map(finding => {
				const text = texts[finding.file];
				const replacement = replacementFor(finding, text);
				return replacement && text.slice(0, replacement.range.start) + replacement.text + text.slice(replacement.range.end);
			});
		}

		it('replaces the name with the one it was probably meant to be', () => {
			assert.deepEqual(fixed('"#a": { widht: 1 }'), [ '"#a": { width: 1 }' ]);
		});

		it('keeps the quotes a name is written in', () => {
			assert.deepEqual(fixed('"#a": { "widht": 1, \'colr\': "red" }'), [ '"#a": { "width": 1, \'colr\': "red" }', '"#a": { "widht": 1, \'color\': "red" }' ]);
		});

		it('replaces only the last name of a nested property', () => {
			assert.deepEqual(fixed('"#a": { font: { fntSize: 2 } }'), [ '"#a": { font: { fontSize: 2 } }' ]);
		});

		it('replaces only the last name of a dotted attribute', () => {
			assert.deepEqual(fixed('', '<Alloy><Label id="a" font.fntSize="3"/></Alloy>'), [ '<Alloy><Label id="a" font.fontSize="3"/></Alloy>' ]);
		});

		it('has nothing to offer once the file no longer says what was found', () => {
			// the finding was made against one version of the file and the fix asked of another
			const [ finding ] = check('<Alloy><Label id="a"/></Alloy>', [ { path: INDEX, text: '"#a": { widht: 1 }' } ], MEMBERS);

			assert.equal(replacementFor(finding, '"#a": { width: 1 }'), undefined);
			assert.equal(replacementFor(finding, ''), undefined);
		});

		it('has nothing to offer when nothing is close', () => {
			assert.deepEqual(fixed('"#a": { zzzzzz: 1 }'), [ undefined ]);
		});
	});

	describe('the message for a finding', () => {

		const finding = (rest: Partial<Finding>): Finding => ({ file: INDEX, range: { start: 0, end: 1 }, property: 'widht', types: [ 'Titanium.UI.Label' ], ...rest });

		it('names the type, as Titanium code writes it', () => {
			assert.equal(messageFor(finding({})), 'Ti.UI.Label has no property \'widht\'.');
		});

		it('says what it was probably meant to be', () => {
			assert.equal(messageFor(finding({ suggestion: 'width' })), 'Ti.UI.Label has no property \'widht\'. Did you mean \'width\'?');
		});

		it('names every type a rule styles, when none of them has it', () => {
			assert.equal(
				messageFor(finding({ property: 'bogus', types: [ 'Titanium.UI.Label', 'Titanium.UI.Window' ] })),
				'None of the elements this rule styles has a property \'bogus\': Ti.UI.Label, Ti.UI.Window.'
			);
		});
	});
});

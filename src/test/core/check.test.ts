import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sortRules, styledElements } from '../../core/cascade.ts';
import type { CascadeSource } from '../../core/cascade.ts';
import { unknownProperties } from '../../core/check.ts';
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
});

import type { ApiMember } from '../../core/typescript/host.ts';
import type { ApiSource } from '../../core/view.ts';

/**
 * A member, with the fields a test does not care about filled in
 *
 * @param name - Its name
 * @param kind - `property` or `method`
 * @param rest - Whatever the test does care about
 * @returns {ApiMember} The member
 */
function member (name: string, kind: string, rest: Partial<ApiMember> = {}): ApiMember {
	return {
		name,
		kind,
		readonly: rest.readonly ?? false,
		type: rest.type ?? 'string',
		documentation: rest.documentation ?? ''
	};
}

/** The layout properties every view has, as the real package declares them on View */
const layout = [
	member('width', 'property', { type: 'string | number', documentation: 'Width of the view.' }),
	member('height', 'property', { type: 'string | number', documentation: 'Height of the view.' })
];

/**
 * The members of each type the fake knows, keyed by the type and then any path through it, dotted.
 *
 * A type is answered for and nothing else is, which is also what a real project does for a native
 * module's proxies.
 */
const members = new Map<string, ApiMember[]>([
	[ 'Titanium.UI.Label', [
		member('text', 'property', { type: 'string', documentation: 'The text to display' }),
		member('color', 'property', { type: 'string' }),
		member('font', 'property', { type: 'Font', documentation: 'Font to use for the label text.' }),
		member('textAlign', 'property', { type: 'string | number', documentation: 'Text alignment.' }),
		member('lineCount', 'property', { readonly: true, type: 'number' }),
		member('add', 'method', { type: '(view: View) => void' }),
		...layout
	] ],
	// a nested property is read through the same call, with the path of properties it sits in
	[ 'Titanium.UI.Label.font', [
		member('fontFamily', 'property', { documentation: 'Specifies the font family or specific font to use.' }),
		member('fontSize', 'property', { type: 'number | string', documentation: 'Font size, in platform-dependent units.' })
	] ],
	[ 'Titanium.UI.ImageView', [
		member('image', 'property', { type: 'string', documentation: 'Image to display.' }),
		...layout
	] ],
	[ 'Titanium.UI.Window', [
		member('title', 'property', { type: 'string' }),
		member('fullscreen', 'property', { type: 'boolean' }),
		member('backgroundColor', 'property', { type: 'string | Titanium.UI.Color' }),
		member('layout', 'property', { type: 'string' }),
		member('backgroundGradient', 'property', { type: 'Gradient' }),
		...layout
	] ],
	[ 'Titanium.UI.Window.backgroundGradient', [
		member('backfillStart', 'property', { type: 'boolean' }),
		member('type', 'property', { type: 'string' })
	] ],
	[ 'Titanium.UI.View', layout ],
	// an event map is read with the same call, which is how an event carries its documentation
	[ 'Titanium.UI.LabelEventMap', [
		member('click', 'property', { type: 'ClickEvent', documentation: 'Fired when the device detects a click against the view.' })
	] ],
	// a distinct member, so a test can tell the renamed type from the tag as written
	[ 'Titanium.UI.PickerRow', [ member('title', 'property', { type: 'string' }) ] ]
]);

/**
 * A stand-in for the project's types.
 *
 * The real one is `ProjectService`, which needs a parsed program — so a fake keeps these tests
 * about what is composed rather than about what TypeScript can resolve, which `host.test.ts`
 * covers. It answers for one type and nothing for anything else, which is also what a real project
 * does for a native module's proxies.
 */
export const api: ApiSource = {
	titaniumTags: () => [ 'Label', 'View', 'Window' ],
	membersOf: (type, path = []) => members.get([ type, ...path ].join('.')) ?? [],
	eventsOf: type => type === 'Titanium.UI.Label' ? [ 'click', 'longpress' ] : [],
	documentationOf: type => type === 'Titanium.UI.Label' ? 'A text label, with an optional background image.' : '',
	constantsOf: namespace => namespace === 'Titanium.UI'
		? [
			member('FILL', 'const', { readonly: true, documentation: 'FILL behavior for UI layout.' }),
			member('SIZE', 'const', { readonly: true, documentation: 'SIZE behavior for UI layout.' }),
			member('TEXT_ALIGNMENT_CENTER', 'const', { readonly: true, type: 'number | string', documentation: 'Center align text.' }),
			member('TEXT_ALIGNMENT_LEFT', 'const', { readonly: true, type: 'number | string', documentation: 'Left align text.' })
		]
		: []
};

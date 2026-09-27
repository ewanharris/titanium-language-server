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
	membersOf: type => {
		if (type === 'Titanium.UI.Label') {
			return [
				member('text', 'property', { type: 'string', documentation: 'The text to display' }),
				member('color', 'property', { type: 'string' }),
				member('lineCount', 'property', { readonly: true, type: 'number' }),
				member('add', 'method', { type: '(view: View) => void' })
			];
		}
		// an event map is read with the same call, which is how an event carries its documentation
		if (type === 'Titanium.UI.LabelEventMap') {
			return [ member('click', 'property', { type: 'ClickEvent', documentation: 'Fired when the device detects a click against the view.' }) ];
		}
		// a distinct member, so a test can tell the renamed type from the tag as written
		if (type === 'Titanium.UI.PickerRow') {
			return [ member('title', 'property', { type: 'string' }) ];
		}
		return [];
	},
	eventsOf: type => type === 'Titanium.UI.Label' ? [ 'click', 'longpress' ] : [],
	documentationOf: type => type === 'Titanium.UI.Label' ? 'A text label, with an optional background image.' : ''
};

import { union } from './declaration-syntax.ts';

/**
 * What every Titanium project declares, whichever kind it is.
 *
 * `L('…')` is the only one so far, and it is here rather than beside the Alloy declarations for a
 * reason that is easy to get wrong: **`L` is a Titanium global, not an Alloy one.** A classic
 * project has translations too, and keeps them somewhere else — `i18n/` beside `tiapp.xml` rather
 * than `app/i18n` — so an implementation that treated i18n as Alloy's would answer nothing for
 * half the projects it serves and look, from the outside, simply broken.
 *
 * `Project.i18nPath` is what knows where they live; this only turns the keys into a declaration.
 */

/**
 * An `L` overload carrying the project's translation keys, or nothing when it has none.
 *
 * Declared as a pair of overloads: the keys the project has, then the plain `string` one
 * `@types/titanium` already declares. The first is what makes completions offer real keys; the
 * second is what stops `L('notTranslatedYet')` being an error in the user's editor, which matters
 * more here than anywhere — a key is often written before the string is added.
 *
 * @param keys - Every key any locale declares
 * @returns {string} The declaration, or an empty string when there is nothing to declare
 */
export function titaniumDeclaration (keys: string[]): string {
	if (!keys.length) {
		return '';
	}

	return [
		`declare function L (key: ${union(keys)}, hint?: string): string;`,
		'declare function L (key: string, hint?: string): string;'
	].join('\n');
}

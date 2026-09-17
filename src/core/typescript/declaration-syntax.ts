/**
 * The small pieces of TypeScript syntax that both declaration generators write.
 *
 * Here rather than duplicated in each, and deliberately nothing more than this: a generator that
 * needed a real emitter would be a sign the declarations had grown past what they are for.
 */

/** A key that can be written as a bare property name rather than a quoted one */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * A property name, quoted only when it has to be.
 *
 * `Alloy.CFG` and a `strings.xml` both allow keys that are not identifiers — a hyphen, a dot, a
 * leading digit — and `a-key: number` is not legal TypeScript.
 *
 * @param key - The key as the project wrote it
 * @returns {string} The key as a property name
 */
export function quotedKey (key: string): string {
	return IDENTIFIER.test(key) ? key : `"${key}"`;
}

/**
 * A union of string literals, in the order given.
 *
 * Escaped, because a name comes off the file system and a path may legally contain a quote or a
 * backslash — rare, and a syntax error in the declaration takes every answer down with it.
 *
 * @param names - The names
 * @returns {string} The union
 */
export function union (names: string[]): string {
	return names.map(name => `'${name.replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`).join(' | ');
}

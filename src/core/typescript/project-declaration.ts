import type { AlloyConfiguration } from '../config.ts';
import type { ProjectType } from '../project.ts';
import { ALLOY_RUNTIME } from './alloy.ts';

/**
 * The declaration built from the project rather than from a view.
 *
 * Everything a controller writes that is not `$` and not Titanium comes from somewhere in the
 * project's own files: `Alloy.CFG` from `config.json`, `L('…')` from the `strings.xml` files,
 * `Alloy.createController('…')` from what is under `app/controllers`. None of it is in
 * `@types/titanium`, and none of it can be known without reading the project.
 *
 * It is generated as TypeScript for the same reason the `$` declaration is. A completion provider
 * that matched the text before the cursor would have to decide, by looking at characters, whether
 * the cursor is inside a call to `L` — which is the shape of every bug this project inherited.
 * Declaring the types and letting the language service answer means the cursor position is
 * resolved by a parser, hover and go to definition come with it at no extra cost, and there is no
 * second way of answering a completion to keep in step with the first.
 *
 * **Unlike the `$` declaration, exactly one of these is in scope for the whole project and it never
 * swaps.** Nothing here is per file, so there is nothing to swap.
 *
 * Every name it introduces is declared as a **pair of overloads**: the names the project has, and
 * then a plain `string`. The first is what makes completions offer real names; the second is what
 * stops `Alloy.createController('aboutToWriteThis')` being an error in the user's editor. A
 * language server that invents errors is worse than one that says nothing, and the union alone
 * would invent one for every name the user has not created yet.
 */

/** What the declaration is built from, read from the project by whoever calls this */
export interface ProjectFacts {
	type: ProjectType;
	/** The merged `config.json`, or nothing for a classic project */
	config: AlloyConfiguration|undefined;
	/** Every key any locale declares */
	translationKeys: string[];
	/** Controller names, as `Alloy.createController` takes them */
	controllers: string[];
	/** Model names, which are also the collection names */
	models: string[];
	/** Widget names */
	widgets: string[];
}

/** A key that can be written as a bare property name rather than a quoted one */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Generates the project's declaration.
 *
 * Answers an empty string when the project has nothing to declare — a classic project with no
 * translations — rather than an empty namespace, so that nothing is installed when there is
 * nothing to say.
 *
 * @param facts - What was read from the project
 * @returns {string} The declaration, as TypeScript
 */
export function generateProjectDeclaration (facts: ProjectFacts): string {
	const blocks: string[] = [];

	if (facts.type === 'alloy') {
		blocks.push(alloyNamespace(facts));
	}

	// L is a Titanium global rather than an Alloy one, so a classic project gets it too — and
	// classic keeping its translations somewhere else is exactly the difference an Alloy-only
	// implementation gets wrong
	if (facts.translationKeys.length) {
		blocks.push([
			`declare function L (key: ${union(facts.translationKeys)}, hint?: string): string;`,
			'declare function L (key: string, hint?: string): string;'
		].join('\n'));
	}

	return blocks.join('\n\n');
}

/**
 * The `Alloy` namespace, with the runtime types and the names this project has
 *
 * @param facts - What was read from the project
 * @returns {string} The namespace declaration
 */
function alloyNamespace (facts: ProjectFacts): string {
	// the collections a project has are its models: Alloy derives one from each, and there is no
	// separate directory to read them from
	const factories = [
		[ 'createController', facts.controllers, 'Controller' ],
		[ 'createModel', facts.models, 'Model' ],
		[ 'createCollection', facts.models, 'Collection' ],
		[ 'createWidget', facts.widgets, 'Widget' ]
	] as const;

	const members = [
		`\t/** The merged contents of config.json */\n\tinterface Config ${shapeOf(facts.config?.values ?? {}, 1)}`,
		'\tconst CFG: Config;',
		'\t/** Whatever the project puts on it, which is why it is not typed further */\n\tconst Globals: Record<string, unknown>;',
		'\tconst Models: Record<string, Model>;',
		'\tconst Collections: Record<string, Collection>;'
	];

	for (const [ name, names, returns ] of factories) {
		if (names.length) {
			members.push(`\tfunction ${name} (name: ${union(names)}, args?: Record<string, unknown>): ${returns};`);
		}
		members.push(`\tfunction ${name} (name: string, args?: Record<string, unknown>): ${returns};`);
	}

	return `declare namespace Alloy {\n${ALLOY_RUNTIME}\n\n${members.join('\n')}\n}`;
}

/**
 * A union of string literals, in the order given
 *
 * @param names - The names
 * @returns {string} The union
 */
function union (names: string[]): string {
	return names.map(name => `'${name.replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`).join(' | ');
}

/**
 * An object type describing a parsed JSON value.
 *
 * Types are widened rather than pinned to the configured value. `config.json` carries one
 * environment's answer and the build picks another, so `test: "value"` would make a comparison
 * against any other string an error in a file that is perfectly correct.
 *
 * @param value - The object to describe
 * @param depth - How far in, for indentation
 * @returns {string} The type, as TypeScript
 */
function shapeOf (value: Record<string, unknown>, depth: number): string {
	const indent = '\t'.repeat(depth);
	const entries = Object.entries(value).map(([ key, member ]) => {
		const name = IDENTIFIER.test(key) ? key : `"${key}"`;
		return `${indent}\t${name}: ${typeOf(member, depth + 1)};`;
	});

	return entries.length ? `{\n${entries.join('\n')}\n${indent}}` : '{}';
}

/**
 * The TypeScript type for one configured value
 *
 * @param value - The value
 * @param depth - How far in, for indentation
 * @returns {string} The type
 */
function typeOf (value: unknown, depth: number): string {
	if (value === null) {
		return 'null';
	}
	if (Array.isArray(value)) {
		// the elements are whatever the project put there, and guessing from the first one would
		// be wrong for any array that is not homogeneous
		return 'unknown[]';
	}
	if (typeof value === 'object') {
		return shapeOf(value as Record<string, unknown>, depth);
	}

	return typeof value;
}

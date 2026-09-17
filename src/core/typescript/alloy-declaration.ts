import type { AlloyConfiguration } from '../config.ts';
import { quotedKey, union } from './declaration-syntax.ts';

/**
 * What an Alloy project declares that a classic one does not.
 *
 * `Alloy.CFG` from `config.json`, and the names this project's own `createController`,
 * `createModel`, `createCollection` and `createWidget` accept. None of it exists in a classic
 * project, which has no `Alloy` namespace at all — so this module is never reached for one, and
 * the type system says so: `AlloyFacts` is what a caller has only when it has an Alloy project.
 *
 * The runtime types this adds to — `Controller`, `Model`, `Collection` — are not here. They ship
 * as `assets/alloy.d.ts` and are loaded by the language service, because they are the same for
 * every project and nothing about them has to be discovered. This is only the part that does.
 * Both go into a `declare namespace Alloy` block and TypeScript merges them.
 */

/** What an Alloy project says about itself */
export interface AlloyFacts {
	/** The merged `config.json`, empty when there was nothing readable in it */
	config: AlloyConfiguration;
	/** Controller names, as `Alloy.createController` takes them */
	controllers: string[];
	/** Model names, which are also the collection names */
	models: string[];
	/** Widget names */
	widgets: string[];
}

/**
 * The `Alloy` namespace members this project has.
 *
 * Every factory is declared as a pair of overloads: the names the project has, then a plain
 * `string`. The first is what makes completions offer real names; the second is what stops
 * `Alloy.createController('aboutToWriteThis')` being an error in the user's editor. A language
 * server that invents errors is worse than one that says nothing, and the union alone would invent
 * one for every name the user has not created yet.
 *
 * @param facts - What was read from the project
 * @returns {string} The declaration, as TypeScript
 */
export function alloyDeclaration (facts: AlloyFacts): string {
	// the collections a project has are its models: Alloy derives one from each, and there is no
	// separate directory to read them from
	const factories = [
		[ 'createController', facts.controllers, 'Controller' ],
		[ 'createModel', facts.models, 'Model' ],
		[ 'createCollection', facts.models, 'Collection' ],
		[ 'createWidget', facts.widgets, 'Widget' ]
	] as const;

	const members = [
		`\t/** The merged contents of config.json */\n\tinterface Config ${shapeOf(facts.config.values, 1)}`,
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

	return `declare namespace Alloy {\n${members.join('\n')}\n}`;
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
	const entries = Object.entries(value).map(([ key, member ]) => `${indent}\t${quotedKey(key)}: ${typeOf(member, depth + 1)};`);

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

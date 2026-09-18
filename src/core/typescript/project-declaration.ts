import { alloyDeclaration } from './alloy-declaration.ts';
import type { AlloyFacts } from './alloy-declaration.ts';
import { titaniumDeclaration } from './titanium-declaration.ts';

/**
 * The declaration built from the project rather than from a view.
 *
 * Some of what a file writes cannot be known from `@types/titanium`, because it comes from the
 * project's own files: the keys of `Alloy.CFG`, the keys `L('…')` takes, the names
 * `Alloy.createController('…')` accepts. This turns what was read out of those files into
 * TypeScript, and the language service answers from it.
 *
 * Generated rather than matched. A completion provider that looked at the characters before the
 * cursor would have to decide, by reading text, whether the cursor is inside a call to `L` — which
 * is the shape of every bug this project inherited. Declaring the types instead means the cursor
 * is located by a parser, hover and go to definition come with it at no extra cost, and there is
 * no second way of answering a completion to keep in step with the first.
 *
 * **Split by project type, and the split is in the type rather than in a comment.** The two halves
 * are genuinely different things and were previously intermingled:
 *
 * - `titanium-declaration.ts` is what **every** Titanium project has. `L` lives there because it
 *   is a Titanium global: a classic project has translations too, in `i18n/` beside `tiapp.xml`
 *   rather than under `app/`.
 * - `alloy-declaration.ts` is what **only** an Alloy project has, and `AlloyFacts` is what a
 *   caller holds only when it has one. A classic project cannot carry a controller list here,
 *   because `alloy` is simply absent — where before it was an empty array, which is a convention
 *   a reader has to know rather than something the compiler enforces.
 *
 * There is no `type` field for the same reason. `alloy === undefined` *is* the project type, so
 * the two cannot disagree.
 *
 * **Unlike the `$` declaration, exactly one of these is in scope for the whole project and it never
 * swaps.** Nothing here is per file, so there is nothing to swap.
 */

/** What the declaration is built from, read from the project by whoever calls this */
export interface ProjectFacts {
	/** Every key any locale declares. Both project types have translations */
	translationKeys: string[];
	/** What Alloy adds, or nothing at all for a classic project */
	alloy: AlloyFacts|undefined;
}

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
	return [
		facts.alloy && alloyDeclaration(facts.alloy),
		titaniumDeclaration(facts.translationKeys)
	].filter(Boolean).join('\n\n');
}

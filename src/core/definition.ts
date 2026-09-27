import { Project } from './project.ts';
import { applicableStyles } from './related.ts';
import { ReferenceIndex } from './references.ts';
import type { SourceCache, SourceFile } from './references.ts';

/**
 * Where an answer points, in the file it points into.
 *
 * Offsets rather than line and character pairs: core deals in offsets throughout, and turning one
 * into a protocol position needs the target document, which is the server layer's to hold.
 */
export interface CoreLocation {
	path: string;
	range: { start: number; end: number };
}

/**
 * The stylesheet rules that style whatever the cursor is on in a view.
 *
 * Only the stylesheets Alloy would actually apply are searched. That is the paired one — the same
 * path under `styles/` — and, for a view in the app rather than in a widget, `app/styles/app.tss`.
 * Searching every stylesheet in the project would find rules for a class of the same name in an
 * unrelated screen, which is not a definition of anything.
 *
 * @param project - The project the view belongs to
 * @param view - The view, as text rather than as a path, so an unsaved buffer answers
 * @param offset - Where the cursor is
 * @param cache - Where the stylesheets are read from
 * @returns {Promise<CoreLocation[]>} The rules that style it, the specific stylesheet before the global one
 */
export async function styleDefinitionAt (project: Project, view: SourceFile, offset: number, cache: SourceCache): Promise<CoreLocation[]> {
	if (await project.type() !== 'alloy') {
		return [];
	}

	const styles = await applicableStyles(project, view.path, cache);
	const index = new ReferenceIndex({ views: [ view ], styles });

	// the index has already split a class list into one usage per name, so the usage under the
	// cursor is the one class asked about rather than the whole attribute
	const usage = index.usages.find(candidate =>
		(candidate.kind === 'id' || candidate.kind === 'class')
		&& offset >= candidate.range.start
		&& offset <= candidate.range.end);

	if (!usage) {
		return [];
	}

	return index.stylesDefining(usage.kind, usage.name)
		.map(definition => ({ path: definition.file, range: definition.range }));
}

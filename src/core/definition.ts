import path from 'node:path';
import ts from 'typescript';
import { pathExists } from './fs.ts';
import { readTranslations, translationKeyAt } from './i18n.ts';
import { Project } from './project.ts';
import { applicableStyles, relatedFile } from './related.ts';
import { ReferenceIndex } from './references.ts';
import type { SourceCache, SourceFile } from './references.ts';
import { RESERVED_EVENT_REGEX } from './view.ts';
import { nodeAt, parseXml } from './xml.ts';
import type { XmlElement } from './xml.ts';

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

/**
 * Where whatever the cursor is on in a view is defined.
 *
 * One question per thing a view can name, each answered from where Alloy itself would look:
 *
 * - a class or an id — the stylesheet rules that style it, as `styleDefinitionAt` answers
 * - a tag name — the rules for that tag, from the same stylesheets
 * - an event handler — the function in the view's own controller
 * - a translation key — the string that declares it, in every locale that does
 * - a `<Require>`, `<Widget>`, `<Model>` or `<Collection>` `src` — the files it names
 * - a `module` — the library file under `app/lib`
 *
 * A file named as a whole is answered at its start. A name with nothing behind it answers nothing
 * rather than a guess, and so does a native module: there is no source to go to.
 *
 * @param project - The project the view belongs to
 * @param view - The view, as text rather than as a path, so an unsaved buffer answers
 * @param offset - Where the cursor is
 * @param cache - Where everything else is read from
 * @returns {Promise<CoreLocation[]>} Where it is defined
 */
export async function viewDefinitionAt (project: Project, view: SourceFile, offset: number, cache: SourceCache): Promise<CoreLocation[]> {
	if (await project.type() !== 'alloy') {
		return [];
	}

	const document = parseXml(view.text);

	// first, because `L('` inside a value is a key whatever the attribute it is written into
	const key = translationKeyAt(document, view.text, offset);
	if (key) {
		return (await readTranslations(project, cache))
			.filter(translation => translation.key === key.key)
			.map(translation => ({ path: translation.path, range: translation.range }));
	}

	const at = nodeAt(document, offset);

	if (at?.kind === 'tag' && at.element.tag) {
		const index = new ReferenceIndex({ views: [], styles: await applicableStyles(project, view.path, cache) });
		return index.stylesDefining('tag', at.element.tag).map(definition => ({ path: definition.file, range: definition.range }));
	}

	if (at?.kind === 'attributeValue' && at.attribute?.value) {
		const { element, attribute } = at;
		const value = attribute.value ?? '';

		if (RESERVED_EVENT_REGEX.test(attribute.name)) {
			return handlerDefinition(project, view.path, value, cache);
		}
		if (attribute.name === 'src') {
			return wholeFiles(await sourcesNamed(project, view.path, element, value));
		}
		if (attribute.name === 'module') {
			return wholeFiles(await existing(path.join(project.filePath, 'app', 'lib'), value, [ '.ts', '.js' ]));
		}
	}

	return styleDefinitionAt(project, view, offset, cache);
}

/**
 * Where an event handler is declared.
 *
 * Alloy writes the value into the controller verbatim — `$.addListener(view, 'click', doClick)` —
 * so it is an expression in the controller's scope. The two forms anyone writes are a name the
 * controller declares and a member it assigns on `$`, and both are looked for at the top level of
 * the controller, which is the scope Alloy wraps into the controller's function.
 *
 * @param project - The project
 * @param viewPath - The view the handler is written in
 * @param handler - The attribute's value
 * @param cache - Where the controller is read from, so an unsaved one answers
 * @returns {Promise<CoreLocation[]>} The declaration, or nothing
 */
async function handlerDefinition (project: Project, viewPath: string, handler: string, cache: SourceCache): Promise<CoreLocation[]> {
	const controller = await relatedFile(project, 'controller', viewPath);
	if (!controller) {
		return [];
	}

	const member = /^\$\.([A-Za-z_$][\w$]*)$/.exec(handler.trim());
	const name = member ? member[1] : handler.trim();

	const { text } = await cache.read(controller);
	const kind = controller.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
	const source = ts.createSourceFile(controller, text, ts.ScriptTarget.Latest, true, kind);

	const found = source.statements.flatMap(statement => member ? assignedOnDollar(statement, name) : declaredAs(statement, name));

	return found.map(node => ({ path: controller, range: { start: node.getStart(source), end: node.getEnd() } }));
}

/**
 * The name a top-level statement declares, when it is the one asked for
 *
 * @param statement - A statement at the top of the controller
 * @param name - The handler's name
 * @returns {ts.Node[]} The identifier that declares it, or nothing
 */
function declaredAs (statement: ts.Statement, name: string): ts.Node[] {
	if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
		return [ statement.name ];
	}

	if (ts.isVariableStatement(statement)) {
		return statement.declarationList.declarations
			.map(declaration => declaration.name)
			.filter(declared => ts.isIdentifier(declared) && declared.text === name);
	}

	return [];
}

/**
 * The member a top-level `$.name = …` assigns, when it is the one asked for
 *
 * @param statement - A statement at the top of the controller
 * @param name - The member's name
 * @returns {ts.Node[]} The member's name where it is assigned, or nothing
 */
function assignedOnDollar (statement: ts.Statement, name: string): ts.Node[] {
	if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) {
		return [];
	}

	const { left, operatorToken } = statement.expression;
	const assigned = operatorToken.kind === ts.SyntaxKind.EqualsToken
		&& ts.isPropertyAccessExpression(left)
		&& ts.isIdentifier(left.expression)
		&& left.expression.text === '$'
		&& left.name.text === name;

	return assigned ? [ left.name ] : [];
}

/**
 * The files a `src` names, which depends on the tag it is written on.
 *
 * - `<Require>` names a controller and the view beside it, and one inside a widget names the
 *   widget's own — Alloy resolves it against the widget it is compiled for
 * - `<Widget>`, and a `<Require type="widget">`, name a widget, whose `name` picks the controller
 *   and defaults to `widget`
 * - `<Model>` and `<Collection>` name a model, again the widget's own inside one
 *
 * @param project - The project
 * @param viewPath - The view the element is in
 * @param element - The element
 * @param src - What it names
 * @returns {Promise<string[]>} The files that exist
 */
async function sourcesNamed (project: Project, viewPath: string, element: XmlElement, src: string): Promise<string[]> {
	const attribute = (name: string): string|undefined => element.attributes.find(candidate => candidate.name === name)?.value;
	const base = componentRoot(project, viewPath);

	if (element.tag === 'Widget' || (element.tag === 'Require' && attribute('type') === 'widget')) {
		const widget = path.join(project.filePath, 'app', 'widgets', src);
		const name = attribute('name') || 'widget';

		// the widget's own directory is the boundary: a src that climbs out of app/widgets is not
		// a widget, however the path resolves
		if (!inside(path.join(project.filePath, 'app', 'widgets'), widget)) {
			return [];
		}

		return [
			...await existing(path.join(widget, 'controllers'), name, [ '.ts', '.js' ]),
			...await existing(path.join(widget, 'views'), name, [ '.xml' ])
		];
	}

	if (element.tag === 'Require') {
		return [
			...await existing(path.join(base, 'controllers'), src, [ '.ts', '.js' ]),
			...await existing(path.join(base, 'views'), src, [ '.xml' ])
		];
	}

	if (element.tag === 'Model' || element.tag === 'Collection') {
		return existing(path.join(base, 'models'), src, [ '.ts', '.js' ]);
	}

	return [];
}

/**
 * The directory a view's controllers, views and models sit under: the widget's own for a view in
 * a widget, and `app/` for the app's
 *
 * @param project - The project
 * @param viewPath - The view
 * @returns {string} The directory
 */
function componentRoot (project: Project, viewPath: string): string {
	const app = path.join(project.filePath, 'app');
	const segments = path.relative(app, viewPath).split(path.sep);

	return segments[0] === 'widgets' && segments.length > 2 ? path.join(app, 'widgets', segments[1]) : app;
}

/**
 * The file a name resolves to under a directory, taking the first extension that exists
 *
 * @param directory - Where names are resolved from
 * @param name - The name, with forward slashes and no extension
 * @param extensions - In preference order
 * @returns {Promise<string[]>} The file, or nothing
 */
async function existing (directory: string, name: string, extensions: string[]): Promise<string[]> {
	for (const extension of extensions) {
		const candidate = path.join(directory, `${name}${extension}`);

		// a name that climbs out of the directory is not one Alloy would resolve there
		if (inside(directory, candidate) && await pathExists(candidate)) {
			return [ candidate ];
		}
	}

	return [];
}

function inside (directory: string, candidate: string): boolean {
	const relative = path.relative(directory, candidate);
	return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function wholeFiles (files: string[]): CoreLocation[] {
	return files.map(file => ({ path: file, range: { start: 0, end: 0 } }));
}

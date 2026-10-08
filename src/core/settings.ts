/**
 * What a user can configure, and what it means.
 *
 * The names are vscode-titanium's, so a user who customised them there keeps them: the settings
 * live under a `titanium` section, `codeTemplates` holds the four templates a generated style or
 * handler is written from, and `project.defaultI18nLanguage` names the locale a project falls back
 * to. The defaults are vscode-titanium's too, escapes and all — see `expandTemplate`.
 *
 * How the section reaches the server is the adapter's business. This reads whatever arrived, which
 * may be anything at all: a client answers what its user typed, and neovim answers null for a
 * section it has nothing for.
 */

/** The templates a generated style or handler is written from, `${text}` standing for the name */
export interface CodeTemplates {
	/** An event handler in a controller */
	jsFunction: string;
	/** A class rule in a stylesheet */
	tssClass: string;
	/** An id rule */
	tssId: string;
	/** A tag rule */
	tssTag: string;
}

export interface Settings {
	codeTemplates: CodeTemplates;
	project: {
		/** The locale under i18n a project falls back to, and so the one answered first */
		defaultI18nLanguage: string;
	};
}

/** vscode-titanium's defaults, as its package.json declares them */
const DEFAULTS: Settings = {
	codeTemplates: {
		jsFunction: '\\nfunction ${text}(e){\\n}\\n',
		tssClass: '\\n\'.${text}\': {\\n}\\n',
		tssId: '\\n\'#${text}\': {\\n}\\n',
		tssTag: '\\n\'${text}\': {\\n}\\n'
	},
	project: { defaultI18nLanguage: 'en' }
};

/**
 * A locale is one directory under i18n — `en`, `en-GB`, `zh-Hans` — and a generated string is
 * written into it, so anything that could name a path is refused rather than followed
 */
const LANGUAGE = /^[\w-]+$/;

/**
 * The settings in a `titanium` section, with whatever it does not set taken from a fallback.
 *
 * Setting by setting rather than all or nothing: a client that answers one setting has not unset
 * the others, and the adapter passes what arrived at initialize as the fallback, so configuration
 * overrides it without discarding it. A value that is not a non-empty string is not a setting,
 * which is also how vscode-titanium treats an empty template.
 *
 * @param section - The `titanium` section, as the client sent it
 * @param fallback - Where each setting the section does not supply comes from
 * @returns {Settings} The settings, every one present
 */
export function readSettings (section: unknown, fallback: Settings = DEFAULTS): Settings {
	const templates = field(section, 'codeTemplates');
	const project = field(section, 'project');

	const template = (name: keyof CodeTemplates): string => text(field(templates, name)) ?? fallback.codeTemplates[name];
	const language = text(field(project, 'defaultI18nLanguage'));

	return {
		codeTemplates: {
			jsFunction: template('jsFunction'),
			tssClass: template('tssClass'),
			tssId: template('tssId'),
			tssTag: template('tssTag')
		},
		project: {
			defaultI18nLanguage: language && LANGUAGE.test(language) ? language : fallback.project.defaultI18nLanguage
		}
	};
}

/**
 * The `titanium` section of a whole settings tree, which is what `initializationOptions` and a
 * pushed `workspace/didChangeConfiguration` carry
 *
 * @param tree - The settings, keyed by section
 * @returns {unknown} The section, or undefined when there is none
 */
export function titaniumSection (tree: unknown): unknown {
	return field(tree, 'titanium');
}

/**
 * What a template writes for a name.
 *
 * vscode-titanium's defaults spell a line break as a backslash and an `n`, because that is how a
 * user types one into a settings field, so both are expanded here as they are there. The name goes
 * in as it is: a replacement string would give `$&` in it a meaning.
 *
 * @param template - The template, `${text}` standing for the name
 * @param name - What it is written for
 * @returns {string} The text to insert
 */
export function expandTemplate (template: string, name: string): string {
	return template.replaceAll('\\n', '\n').replaceAll('${text}', () => name);
}

/**
 * A property of something that may not be an object
 *
 * @param value - Anything a client sent
 * @param name - The property
 * @returns {unknown} The property, or undefined when there is no object to read it from
 */
function field (value: unknown, name: string): unknown {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)[name]
		: undefined;
}

/**
 * A setting's value, when it is one
 *
 * @param value - What the client sent
 * @returns {string|undefined} It, when it is a string with something in it
 */
function text (value: unknown): string|undefined {
	return typeof value === 'string' && value.length ? value : undefined;
}

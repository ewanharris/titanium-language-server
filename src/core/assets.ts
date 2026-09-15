import path from 'node:path';
import { findFiles } from './fs.ts';
import { Project } from './project.ts';

/**
 * The images a project can name, and which properties name one.
 *
 * Unlike everything else the language features answer, this cannot be done by declaring types. An
 * image is a bare string in an arbitrary position — `image:`, `backgroundImage:`, `icon:` — and
 * `@types/titanium` types every one of them as `string`. Declaration merging cannot narrow a
 * property that already exists, so there is nothing to attach a union of paths to. What decides
 * whether a string literal is an image path is the property it is being written into, and that is
 * a question about the syntax tree rather than about a type.
 *
 * So this is the one answer in the project that is not generated TypeScript. The part that would
 * otherwise be a text match — "is the cursor in an image property" — is still answered by the
 * parser rather than by looking at characters: `ProjectService.stringLiteralAt` finds the literal
 * and its property, and this decides what to offer for it.
 */

/**
 * The properties that take an image path.
 *
 * Derived from `@types/titanium` rather than from memory: every property whose name mentions an
 * image or an icon and whose declared type admits a `string`. That filter is what keeps
 * `preventDefaultImage` (a boolean), `maxImages` (a number) and `toImage` (a method) out, each of
 * which reads like an image property and is not one.
 *
 * A list rather than a pattern, because the pattern is exactly what produces those three: a name
 * ending in `Image` says nothing reliable about whether it holds a path.
 */
const IMAGE_PROPERTIES = new Set([
	'activeIcon', 'activeTabBackgroundImage', 'alertLaunchImage', 'backButtonTitleImage',
	'backgroundDisabledImage', 'backgroundFocusedImage', 'backgroundImage', 'backgroundSelectedImage',
	'barImage', 'bigLargeIcon', 'decrementDisabledImage', 'decrementImage', 'defaultImage',
	'disabledLeftTrackImage', 'disabledRightTrackImage', 'disabledThumbImage',
	'fieldBackgroundDisabledImage', 'fieldBackgroundImage', 'highlightedLeftTrackImage',
	'highlightedRightTrackImage', 'highlightedThumbImage', 'icon', 'image', 'incrementDisabledImage',
	'incrementImage', 'largeIcon', 'leftImage', 'leftTrackImage', 'navigationIcon', 'overflowIcon',
	'preferredIndicatorImage', 'rightImage', 'rightTrackImage', 'selectedBackgroundImage',
	'selectedImage', 'selectedLeftTrackImage', 'selectedRightTrackImage', 'selectedThumbImage',
	'shadowImage', 'tabsBackgroundImage', 'thumbImage', 'titleImage'
]);

/** What Titanium will actually load as an image */
const IMAGE_EXTENSIONS = [ '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp' ];

/**
 * The platform directories an asset may be filed under.
 *
 * Alloy builds `app/assets/iphone/images/x.png` to `Resources/iphone/images/x.png`, and the
 * runtime picks the one for the platform it is on. The code names it `/images/x.png` either way —
 * the directory is how the file is selected, not part of what it is called.
 */
const PLATFORMS = new Set([ 'android', 'iphone', 'ios', 'windows' ]);

/** An Android density directory, which is chosen at run time the same way a platform is */
const DENSITY_DIRECTORY = /^res-[a-z0-9-]+$/;

/** A density suffix on the file itself, as iOS writes it: `logo@2x.png`, `logo@1.5x.png` */
const DENSITY_SUFFIX = /@[0-9]+(\.[0-9]+)?x$/;

/**
 * Whether a property holds an image path
 *
 * @param name - The property name, or nothing when the literal is not in one
 * @returns {boolean} Whether to offer image paths for it
 */
export function isImageProperty (name: string|undefined): boolean {
	return name !== undefined && IMAGE_PROPERTIES.has(name);
}

/**
 * The image paths a project can name, for a given property.
 *
 * Answers nothing rather than everything when the property does not take an image, so a caller can
 * hand over whatever it found at the cursor without deciding first.
 *
 * Paths are absolute within the app — `/images/logo.png` — which is the form Titanium resolves
 * from the resource root and the form that works wherever it is written. Each image appears once,
 * under the name the code should write: the density variants and the platform and density
 * directories all collapse onto it, because offering `/images/res-hdpi/logo@2x.png` would be
 * offering a path the runtime cannot load.
 *
 * @param project - The project to read
 * @param property - The property the literal is being written into
 * @returns {Promise<string[]>} The paths, sorted and distinct
 */
export async function imagePathsFor (project: Project, property: string|undefined): Promise<string[]> {
	if (!isImageProperty(property)) {
		return [];
	}

	// app/assets for Alloy, Resources for classic — a classic project has no assets directory at
	// all, which is where both the previous implementation and vscode-titanium looked
	const root = await project.assetPath();
	const found = await findFiles(root, IMAGE_EXTENSIONS);

	const paths = found.map(file => imagePath(path.relative(root, file)));

	return [ ...new Set(paths) ].sort();
}

/**
 * The name the code writes for an asset, from its path under the resource root
 *
 * @param relative - The path relative to the asset root
 * @returns {string} The path as it should be written
 */
function imagePath (relative: string): string {
	const segments = relative.split(path.sep);

	// a leading platform directory, then any density directory anywhere below it: both select a
	// file rather than name one
	const kept = segments
		.filter((segment, index) => !(index === 0 && PLATFORMS.has(segment)))
		.filter(segment => !DENSITY_DIRECTORY.test(segment));

	const file = kept[kept.length - 1];
	const extension = path.extname(file);
	const base = file.slice(0, file.length - extension.length).replace(DENSITY_SUFFIX, '');

	return `/${[ ...kept.slice(0, -1), `${base}${extension}` ].join('/')}`;
}

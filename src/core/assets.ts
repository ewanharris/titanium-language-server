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
 * parser rather than by looking at characters: `ProjectService.stringLiteralAt` finds the literal,
 * its property and whether that property could hold a string at all, and this decides what to
 * offer for it.
 */

/**
 * A property named for an image or an icon.
 *
 * The singular, anchored at the end: `image`, `icon`, `backgroundImage`, `activeIcon`. A plural or
 * a prefix is deliberately not a match — `maxImages` holds a boolean and `imageUrl` is not a path
 * this project can resolve, and neither then needs a type to rule it out.
 *
 * This replaced a list of the forty-two properties `@types/titanium` declares. The list was
 * accurate and immediately going stale: every property Titanium adds, and every one a native
 * module brings, would have had to be added by hand. The suffix holds for all of them.
 */
const IMAGE_NAME = /^(image|icon)$|(Image|Icon)$/;

/** What Titanium will actually load as an image */
const IMAGE_EXTENSIONS = [ '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp' ];

/**
 * The platform directories an asset may be filed under.
 *
 * Alloy builds `app/assets/iphone/images/x.png` to `Resources/iphone/images/x.png`, and the
 * runtime picks the one for the platform it is on. The code names it `/images/x.png` either way —
 * the directory is how the file is selected, not part of what it is called.
 *
 * No `windows`: Titanium dropped the Windows platform, so a project with that directory is one
 * nothing can build.
 */
const PLATFORMS = new Set([ 'android', 'iphone', 'ios' ]);

/** An Android density directory, which is chosen at run time the same way a platform is */
const DENSITY_DIRECTORY = /^res-[a-z0-9-]+$/;

/** A density suffix on the file itself, as iOS writes it: `logo@2x.png`, `logo@1.5x.png` */
const DENSITY_SUFFIX = /@[0-9]+(\.[0-9]+)?x$/;

/**
 * Whether a property holds an image path.
 *
 * Two questions, because neither answers alone. The **name** says a property is probably a path,
 * and on its own it is wrong: `@types/titanium` declares `preventDefaultImage: boolean` on
 * `ImageView`, right beside `image`. The **type** says whether a string could go there at all, and
 * on its own it is far too broad — every title and every label is a string.
 *
 * The type is only ever used to rule a property out, never to rule one in. A plain object literal
 * handed to `createImageView` later has no contextual type at all, and knowing nothing about a
 * property is not the same as knowing it is wrong.
 *
 * @param name - The property name, or nothing when the literal is not in one
 * @param typeExcludesString - Whether the type of what is being written into positively cannot be
 *   a string. False when there is no type to ask.
 * @returns {boolean} Whether to offer image paths for it
 */
export function isImageProperty (name: string|undefined, typeExcludesString: boolean): boolean {
	return name !== undefined && IMAGE_NAME.test(name) && !typeExcludesString;
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
 * @param typeExcludesString - Whether that property's type positively cannot hold a string
 * @returns {Promise<string[]>} The paths, sorted and distinct
 */
export async function imagePathsFor (project: Project, property: string|undefined, typeExcludesString = false): Promise<string[]> {
	if (!isImageProperty(property, typeExcludesString)) {
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
 * The files a path written in the code loads.
 *
 * The reverse of `imagePathsFor`: every asset whose name collapses onto the one written, which is
 * the file itself, its density variants and its copies under platform directories. The file named
 * exactly comes first, since it is the one a reader expects to see, and the rest in path order.
 *
 * @param project - The project to read
 * @param written - The path as the code writes it, with or without its leading slash
 * @returns {Promise<string[]>} The files, which may be none at all
 */
export async function imageFilesFor (project: Project, written: string): Promise<string[]> {
	const root = await project.assetPath();
	const wanted = written.startsWith('/') ? written : `/${written}`;
	const exact = path.join(root, ...wanted.split('/'));

	const files = (await findFiles(root, IMAGE_EXTENSIONS)).filter(file => imagePath(path.relative(root, file)) === wanted);

	return files.sort((left, right) => Number(right === exact) - Number(left === exact) || left.localeCompare(right));
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

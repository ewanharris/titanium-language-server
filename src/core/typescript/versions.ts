/**
 * Which release of `@types/titanium` answers for a project's SDK.
 *
 * DefinitelyTyped publishes majors 3, 7, 8, 9, 12 and 13 — there is no 10.x or 11.x — so a project
 * on an SDK in that gap has to resolve to something older. The rule is nearest major at or below,
 * which is survivable because the Titanium API is additive: older types describe a subset of what
 * the SDK offers, so every answer they give is still true. Resolving upwards would not be safe,
 * since it would offer members the project's SDK does not have.
 *
 * The same rule covers the ordinary case rather than only the gap. The types trail the SDK even on
 * a supported major — SDK 13.4.1.GA against types 13.3.0 — so almost every project falls back a
 * little. That is why the outcome is classified rather than reported as a bare version: crossing a
 * major is worth telling the user about, and trailing inside one is not.
 */

/** How well the selected types match the SDK, which is what decides how loudly to say so */
export type TypesMatch =
	/** The SDK's own major, possibly an older release of it */
	| 'matched'
	/** A different major, because the SDK's own is not published */
	| 'older-major'
	/** Nothing at or below the SDK, so the type-dependent features have no data */
	| 'none';

export interface TypesVersionSelection {
	/** The release to use, or nothing when none answers */
	version: string|undefined;
	kind: TypesMatch;
	/** The SDK version this was resolved for, so a message can name it */
	sdkVersion: string;
}

/** Leading numeric components, so a `.GA` or `.v20240117144104` qualifier is ignored */
const versionPattern = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/;

/**
 * The major version a Titanium SDK version names.
 *
 * A tiapp's sdk-version carries a qualifier the semantic part does not — `12.4.0.GA` for a release,
 * `13.0.0.v20240117144104` for a build from master — so only the leading numbers are read.
 *
 * @param version - The version, as written in the tiapp.xml
 * @returns {number|undefined} The major, or nothing when this is not a version at all
 */
export function majorOf (version: string): number|undefined {
	const match = versionPattern.exec(version.trim());
	return match ? Number(match[1]) : undefined;
}

/**
 * Picks the release of `@types/titanium` to use for an SDK version.
 *
 * @param sdkVersion - The tiapp's sdk-version, as written
 * @param available - Every version published, in any order
 * @returns {TypesVersionSelection} The release to use and how well it matches
 */
export function selectTypesVersion (sdkVersion: string, available: string[]): TypesVersionSelection {
	const nothing: TypesVersionSelection = { version: undefined, kind: 'none', sdkVersion };

	const wanted = majorOf(sdkVersion);
	if (wanted === undefined) {
		return nothing;
	}

	const releases = available
		// a prerelease is published to be tried rather than depended on, and DefinitelyTyped does
		// not ship them for consumption
		.filter(version => !version.includes('-'))
		.map(version => ({ version, parts: componentsOf(version) }))
		.filter(release => release.parts.length > 0);

	if (!releases.length) {
		return nothing;
	}

	// nearest major at or below: the highest major that does not exceed the SDK's
	const major = Math.max(...releases.map(release => release.parts[0]).filter(candidate => candidate <= wanted), -1);
	if (major < 0) {
		return nothing;
	}

	const newest = releases
		.filter(release => release.parts[0] === major)
		.sort((a, b) => compare(b.parts, a.parts))[0];

	return {
		version: newest.version,
		kind: major === wanted ? 'matched' : 'older-major',
		sdkVersion
	};
}

/**
 * A version as its numeric components.
 *
 * Compared numerically rather than as strings throughout, because `9.2.2` sorts above `13.3.0`
 * lexicographically and `8.0.5` above `10.0.0`.
 *
 * @param version - A version string
 * @returns {number[]} Its major, minor and patch, or nothing when it is not a version
 */
function componentsOf (version: string): number[] {
	const match = versionPattern.exec(version.trim());
	return match ? [ Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0) ] : [];
}

/**
 * Orders two versions by their components
 *
 * @param a - The first version's components
 * @param b - The second version's components
 * @returns {number} Negative when a sorts first, positive when b does
 */
function compare (a: number[], b: number[]): number {
	for (let index = 0; index < Math.max(a.length, b.length); index++) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference) {
			return difference;
		}
	}
	return 0;
}

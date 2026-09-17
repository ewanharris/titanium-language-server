import path from 'node:path';

/**
 * Where the Alloy runtime declarations ship.
 *
 * The language service loads `assets/alloy.d.ts` as a library root, the same way it loads
 * `@types/titanium`. That file declares the `Alloy` namespace — `Controller`, `Model`,
 * `Collection` — which the generated declarations then add this project's own `CFG` and
 * `create…` names to.
 *
 * Resolved relative to this module rather than to the working directory, because the working
 * directory is the user's project and this file is in the package. The relative depth is the same
 * from the sources and from the build — `src/core/typescript` and `out/core/typescript` are both
 * three levels below the package root — so one path serves the test run and the published package
 * without a build step to copy anything.
 */

/**
 * The absolute path to the shipped Alloy declarations
 *
 * @returns {string} The path, which is a real file in the package
 */
export function alloyLibraryPath (): string {
	return path.join(import.meta.dirname, '..', '..', '..', 'assets', 'alloy.d.ts');
}

import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The built package, as a consumer sees it.
 *
 * These tests are the one tier that runs against `out/` rather than against the sources, because
 * what they assert is only true of the artifact: the bin's shebang, the exports map, the path
 * `serverPath` names. Everything else in the suite runs from source through Node's type stripping.
 *
 * The built module is reached through a dynamic import rather than a static one. A static import
 * would need `out/index.d.ts` to exist while tsc is compiling this file, which is the same build
 * that produces it — so a clean tree would fail once and then work, which is worse than a cast.
 */

const packageRoot = path.join(import.meta.dirname, '..', '..', '..');

export const outDir = path.join(packageRoot, 'out');

/** The server the bin points at */
export const builtServer = path.join(outDir, 'server.js');

export { packageRoot };

interface BuiltPackage {
	serverPath: string;
	CustomRequests: Record<string, unknown>;
}

/**
 * Loads the built package's entry point
 *
 * @returns {Promise<BuiltPackage>} What it exports
 */
export async function builtPackage (): Promise<BuiltPackage> {
	return await import(pathToFileURL(path.join(outDir, 'index.js')).href) as BuiltPackage;
}

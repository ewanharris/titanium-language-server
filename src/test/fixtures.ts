import path from 'node:path';
import { pathExists } from '../core/fs.js';

/**
 * Fixtures are read from the source tree rather than the build output, because they are project
 * layouts rather than compiled code — tsconfig excludes them so a fixture that happens to be
 * TypeScript is not compiled as part of the package.
 */
const fixtures = path.join(import.meta.dirname, '..', '..', 'src', 'test', 'fixtures');

/**
 * The absolute path to a fixture.
 *
 * Fails loudly rather than returning a path that does not exist, so a renamed or missing fixture
 * reads as a missing fixture and not as whatever the code under test does with a bad path.
 *
 * @param name - The fixture directory name
 * @returns {Promise<string>} The absolute path to it
 */
export async function fixturePath (name: string): Promise<string> {
	const target = path.join(fixtures, name);
	if (!await pathExists(target)) {
		throw new Error(`No fixture named ${name} at ${target}`);
	}
	return target;
}

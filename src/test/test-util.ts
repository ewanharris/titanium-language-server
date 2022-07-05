import fs from 'fs-extra';
import path from 'path';

const fixtures = path.join(__dirname, 'fixtures')

export async function getFixture (fixtureName: string): Promise<string> {

	const fixturePath = path.join(fixtures, fixtureName);

	if (!await fs.pathExists(fixturePath)) {
		throw new Error(`Cannot find ${fixtureName} at ${fixturePath}`);
	}

	return fs.readFile(fixturePath, 'utf-8');

}

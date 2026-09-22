import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { imageSize, previewImage } from '../../core/images.ts';
import { Project } from '../../core/project.ts';
import { fixturePath } from '../fixtures.ts';

/**
 * Bytes from a list of numbers and strings, so a header reads as the format describes it
 *
 * @param parts - Each a byte, or a run of ASCII characters
 * @returns {Uint8Array} The bytes
 */
function bytes (...parts: (number|string)[]): Uint8Array {
	return Uint8Array.from(parts.flatMap(part => typeof part === 'string' ? [ ...part ].map(character => character.charCodeAt(0)) : [ part ]));
}

describe('An image, as hover shows it', () => {

	describe('its size, read from its header', () => {

		it('should read a PNG', () => {
			// the signature, then IHDR's length and name, then width and height big endian
			const png = bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 'IHDR', 0, 0, 1, 0x2c, 0, 0, 0, 0xc8);

			assert.deepEqual(imageSize(png), { width: 300, height: 200 });
		});

		it('should read a GIF', () => {
			// width and height little endian, straight after the version
			assert.deepEqual(imageSize(bytes('GIF89a', 0x2c, 0x01, 0xc8, 0x00)), { width: 300, height: 200 });
		});

		it('should read a JPEG, past the segments before its frame header', () => {
			const jpeg = bytes(
				0xff, 0xd8,
				// an APP0 segment of six bytes, which has to be stepped over by its length
				0xff, 0xe0, 0x00, 0x06, 'JFIF',
				// a baseline frame header: length, precision, then height and width big endian
				0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0xc8, 0x01, 0x2c
			);

			assert.deepEqual(imageSize(jpeg), { width: 300, height: 200 });
		});

		it('should read a progressive JPEG', () => {
			assert.deepEqual(imageSize(bytes(0xff, 0xd8, 0xff, 0xc2, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03)), { width: 3, height: 2 });
		});

		it('should read a BMP, whose height is negative when it is stored top down', () => {
			const header = new Uint8Array(26);
			header.set(bytes('BM'));
			const view = new DataView(header.buffer);
			view.setInt32(18, 300, true);
			view.setInt32(22, -200, true);

			assert.deepEqual(imageSize(header), { width: 300, height: 200 });
		});

		it('should answer nothing for a format it does not read, or a header cut short', () => {
			assert.equal(imageSize(bytes('RIFF', 0, 0, 0, 0, 'WEBP')), undefined);
			assert.equal(imageSize(bytes(0x89, 'PNG')), undefined);
			assert.equal(imageSize(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x40)), undefined);
			assert.equal(imageSize(bytes('not an image')), undefined);
		});
	});

	describe('its preview', () => {

		const alloy = async (): Promise<Project> => {
			const project = new Project(await fixturePath('alloy-project'));
			await project.load();
			return project;
		};

		it('should embed a small image as a data URI, with its size and dimensions', async () => {
			const project = await alloy();
			const preview = await previewImage(project, '/images/logo.png');

			assert.equal(preview?.file, path.join(project.filePath, 'app', 'assets', 'images', 'logo.png'));
			assert.equal(preview?.bytes, 73);
			assert.equal(preview?.width, 3);
			assert.equal(preview?.height, 2);
			assert.match(preview?.dataUri ?? '', /^data:image\/png;base64,iVBORw0KGgo/);
		});

		it('should leave out the data URI for an image over the limit, and keep the rest', async () => {
			// 211KB against a 100KB limit — a hover is a tooltip, and an unbounded one is a stall
			const preview = await previewImage(await alloy(), '/test.png');

			assert.equal(preview?.dataUri, undefined);
			assert.equal(preview?.width, 1024);
			assert.ok((preview?.bytes ?? 0) > 100 * 1024);
		});

		it('should take its limit as an argument', async () => {
			assert.equal((await previewImage(await alloy(), '/images/logo.png', 10))?.dataUri, undefined);
		});

		it('should still embed a file whose header it cannot read, without dimensions', async () => {
			// banner.jpg is a placeholder rather than a JPEG; the client decides what to render
			const preview = await previewImage(await alloy(), '/images/banner.jpg');

			assert.equal(preview?.width, undefined);
			assert.match(preview?.dataUri ?? '', /^data:image\/jpeg;base64,/);
		});

		it('should answer nothing for a path with no file behind it', async () => {
			assert.equal(await previewImage(await alloy(), '/images/missing.png'), undefined);
		});
	});
});

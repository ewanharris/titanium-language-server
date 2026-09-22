import fs from 'node:fs/promises';
import path from 'node:path';
import { imageFilesFor } from './assets.ts';
import { Project } from './project.ts';

/**
 * An image as hover shows it: the file a path loads, how big it is, and the image itself.
 *
 * The image travels as a data URI rather than as a link to the file. Whether a client renders a
 * `file://` image in a hover varies, and where it does not the user gets a broken-image icon —
 * which is worse than no preview at all. A data URI renders wherever markdown images do.
 *
 * It is bounded, because a hover is a tooltip. A client asks for one as the pointer passes over
 * the text, and a megabyte of base64 on every pass is a stall rather than a preview.
 */

/**
 * The largest file embedded, in bytes.
 *
 * 100KB, which is a third more once encoded. It is comfortably past the icons and the 1x and 2x
 * artwork that make up nearly every value a view names, and well short of the splash screens and
 * photographs that would make a hover lag.
 */
export const PREVIEW_LIMIT = 100 * 1024;

export interface ImagePreview {
	/** The file the path loads */
	file: string;
	/** Its size on disk */
	bytes: number;
	/** Its dimensions in pixels, when its header could be read */
	width?: number;
	height?: number;
	/** The image itself, absent when it is over the limit */
	dataUri?: string;
}

/** The media type for each extension `assets.ts` treats as an image */
const MEDIA_TYPES: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.bmp': 'image/bmp',
	'.webp': 'image/webp'
};

/**
 * The preview for a path a view or a controller writes.
 *
 * @param project - The project the path resolves in
 * @param written - The path as written, such as `/images/logo.png`
 * @param limit - The largest file to embed, in bytes
 * @returns {Promise<ImagePreview|undefined>} The preview, or nothing when no file is behind the path
 */
export async function previewImage (project: Project, written: string, limit = PREVIEW_LIMIT): Promise<ImagePreview|undefined> {
	const [ file ] = await imageFilesFor(project, written);
	if (!file) {
		return;
	}

	const contents = await fs.readFile(file);
	const preview: ImagePreview = { file, bytes: contents.length, ...imageSize(contents) };

	if (contents.length <= limit) {
		preview.dataUri = `data:${MEDIA_TYPES[path.extname(file).toLowerCase()]};base64,${contents.toString('base64')}`;
	}

	return preview;
}

/**
 * An image's dimensions, read from its header.
 *
 * PNG, GIF, JPEG and BMP — the formats whose headers state it plainly. Anything else, or a header
 * cut short, answers nothing, and the preview goes without dimensions rather than guessing them.
 *
 * @param contents - The file, or at least the start of it
 * @returns The width and height in pixels, or nothing
 */
export function imageSize (contents: Uint8Array): { width: number; height: number }|undefined {
	const view = new DataView(contents.buffer, contents.byteOffset, contents.byteLength);
	const has = (offset: number, ...expected: number[]): boolean =>
		contents.length >= offset + expected.length && expected.every((byte, index) => contents[offset + index] === byte);

	// the signature, then IHDR — which the format requires to be the first chunk
	if (has(0, 0x89, 0x50, 0x4e, 0x47) && contents.length >= 24) {
		return { width: view.getUint32(16), height: view.getUint32(20) };
	}

	if (has(0, 0x47, 0x49, 0x46, 0x38) && contents.length >= 10) {
		return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
	}

	if (has(0, 0x42, 0x4d) && contents.length >= 26) {
		// negative for a bitmap stored top down, which is the same number of rows
		return { width: view.getInt32(18, true), height: Math.abs(view.getInt32(22, true)) };
	}

	if (has(0, 0xff, 0xd8)) {
		return jpegSize(contents, view);
	}
}

/**
 * A JPEG's dimensions, from its frame header.
 *
 * The frame header is not at a fixed place: it comes after whatever application segments the
 * encoder wrote, so the segments are walked by their lengths until one of the start-of-frame
 * markers — `C0` to `CF`, less `C4`, `C8` and `CC`, which are tables rather than frames.
 *
 * @param contents - The file
 * @param view - The same bytes, for reading multi-byte values
 * @returns The width and height, or nothing when no frame header is reached
 */
function jpegSize (contents: Uint8Array, view: DataView): { width: number; height: number }|undefined {
	let offset = 2;

	while (offset + 4 <= contents.length && contents[offset] === 0xff) {
		const marker = contents[offset + 1];
		const frame = marker >= 0xc0 && marker <= 0xcf && ![ 0xc4, 0xc8, 0xcc ].includes(marker);

		if (frame) {
			return offset + 9 <= contents.length
				? { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) }
				: undefined;
		}

		offset += 2 + view.getUint16(offset + 2);
	}
}

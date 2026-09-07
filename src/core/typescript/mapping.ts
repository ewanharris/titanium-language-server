/**
 * Turning a position in what the language service read into a position in what the user wrote.
 *
 * Some of what the service reads is not a file. #13 generates a `$` declaration from a view, and
 * the language service answers about the declaration — but an editor must never be pointed into
 * it: the user would jump to a file that does not exist, at a line that means nothing. Every
 * answer maps back to source, and this is the artefact that does it, so each feature does not
 * re-derive the same arithmetic and get it subtly different.
 *
 * A real file gets an identity mapping rather than a special case at every call site. That is the
 * whole reason this is one type with two constructors: callers map unconditionally and never ask
 * whether the thing they are holding is generated.
 */

export interface MappedPosition {
	path: string;
	offset: number;
}

export interface MappedRange {
	path: string;
	range: { start: number; end: number };
}

/** A run of generated text that came from somewhere real, character for character */
export interface MappingSegment {
	/** Where it sits in the generated content */
	generated: { start: number; length: number };
	/** Where it came from in the source */
	source: { start: number };
}

export interface PositionMap {
	/** The file positions map back into */
	readonly source: string;
	/** Whether the content this describes is generated rather than a file on disk */
	readonly generated: boolean;
	/** Where an offset came from, or nothing when it came from nowhere the user wrote */
	position (offset: number): MappedPosition|undefined;
	/** Where a span came from, clamped to the run it starts in */
	range (range: { start: number; end: number }): MappedRange|undefined;
}

/**
 * The mapping for content that is a real file, where every offset is already a source offset
 */
export class IdentityMapping implements PositionMap {

	public readonly source: string;
	public readonly generated = false;

	constructor (path: string) {
		this.source = path;
	}

	/**
	 * Where an offset came from, which for a real file is where it already is
	 *
	 * @param offset - An offset into the file
	 * @returns {MappedPosition} The same offset
	 * @memberof IdentityMapping
	 */
	public position (offset: number): MappedPosition {
		return { path: this.source, offset };
	}

	/**
	 * Where a span came from, which for a real file is where it already is
	 *
	 * @param range - A span in the file
	 * @returns {MappedRange} The same span
	 * @memberof IdentityMapping
	 */
	public range (range: { start: number; end: number }): MappedRange {
		return { path: this.source, range };
	}
}

/**
 * The mapping for generated content.
 *
 * Only the runs that were copied from the source map at all. Everything else — the scaffolding a
 * generator emits around them — deliberately maps to nothing, because there is no honest answer
 * for "where in the view is `interface IndexViews {`".
 */
export class GeneratedMapping implements PositionMap {

	public readonly source: string;
	public readonly generated = true;

	/** In generated order, so the segment an offset falls in can be found by scanning */
	private segments: MappingSegment[];

	constructor (source: string, segments: MappingSegment[]) {
		this.source = source;
		this.segments = [ ...segments ].sort((a, b) => a.generated.start - b.generated.start);
	}

	/**
	 * Where an offset came from
	 *
	 * @param offset - An offset into the generated content
	 * @returns {MappedPosition|undefined} Where in the source, or nothing when it came from nowhere
	 * @memberof GeneratedMapping
	 */
	public position (offset: number): MappedPosition|undefined {
		const segment = this.segmentAt(offset);
		if (!segment) {
			return;
		}

		return { path: this.source, offset: segment.source.start + (offset - segment.generated.start) };
	}

	/**
	 * Where a span came from, clamped to the run it starts in.
	 *
	 * A span that runs past the end of its segment is clamped rather than dropped: the answer is
	 * still about the thing the segment names, and a shorter highlight is better than none.
	 *
	 * @param range - A span in the generated content
	 * @returns {MappedRange|undefined} Where in the source, or nothing when it came from nowhere
	 * @memberof GeneratedMapping
	 */
	public range (range: { start: number; end: number }): MappedRange|undefined {
		const segment = this.segmentAt(range.start);
		if (!segment) {
			return;
		}

		const offset = range.start - segment.generated.start;
		const length = Math.min(range.end - range.start, segment.generated.length - offset);

		return {
			path: this.source,
			range: { start: segment.source.start + offset, end: segment.source.start + offset + length }
		};
	}

	/**
	 * The segment an offset falls in.
	 *
	 * The end of a segment counts as inside it, because that is where an exclusive range ends and
	 * refusing there would drop the mapping for every span that reaches the last character.
	 *
	 * @param offset - An offset into the generated content
	 * @returns {MappingSegment|undefined} The segment, if the offset is in one
	 * @memberof GeneratedMapping
	 */
	private segmentAt (offset: number): MappingSegment|undefined {
		return this.segments.find(segment => offset >= segment.generated.start && offset <= segment.generated.start + segment.generated.length);
	}
}

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
 *
 * @param path - The file
 * @returns {PositionMap} A mapping that changes nothing
 */
export function identityMapping (path: string): PositionMap {
	return {
		source: path,
		generated: false,
		position: offset => ({ path, offset }),
		range: range => ({ path, range: { start: range.start, end: range.end } })
	};
}

/**
 * The mapping for generated content.
 *
 * Only the runs that were copied from the source map at all. Everything else — the scaffolding a
 * generator emits around them — deliberately maps to nothing, because there is no honest answer
 * for "where in the view is `interface IndexViews {`".
 *
 * @param source - The file the content was generated from
 * @param segments - The runs that came from it, which need not be sorted
 * @returns {PositionMap} The mapping
 */
export function generatedMapping (source: string, segments: MappingSegment[]): PositionMap {
	const ordered = [ ...segments ].sort((a, b) => a.generated.start - b.generated.start);

	/**
	 * The segment an offset falls in.
	 *
	 * The end of a segment counts as inside it, because that is where an exclusive range ends and
	 * refusing there would drop the mapping for every span that reaches the last character.
	 *
	 * @param offset - An offset into the generated content
	 * @returns {MappingSegment|undefined} The segment, if the offset is in one
	 */
	function segmentAt (offset: number): MappingSegment|undefined {
		return ordered.find(segment => offset >= segment.generated.start && offset <= segment.generated.start + segment.generated.length);
	}

	return {
		source,
		generated: true,

		position (offset: number): MappedPosition|undefined {
			const segment = segmentAt(offset);
			if (!segment) {
				return;
			}
			return { path: source, offset: segment.source.start + (offset - segment.generated.start) };
		},

		range (range: { start: number; end: number }): MappedRange|undefined {
			const segment = segmentAt(range.start);
			if (!segment) {
				return;
			}

			// a span that runs past the segment it started in describes generated text the source
			// has no counterpart for, so it stops at the end of the run rather than reaching into
			// whatever the next segment happens to describe
			const end = Math.min(range.end, segment.generated.start + segment.generated.length);
			const start = segment.source.start + (range.start - segment.generated.start);

			return { path: source, range: { start, end: start + (end - range.start) } };
		}
	};
}

/**
 * A parser for Alloy's TSS.
 *
 * TSS is a JSON dialect: unquoted keys, optional commas between top level rules, comments, single
 * quotes, and a handful of expression forms — `Ti.UI.SIZE`, `L('key')`, `WPATH('x')`, `$.args.foo`
 * and bitwise combinations of those.
 *
 * Alloy parses it with a PEG grammar (Alloy/grammar/tss.pegjs) whose actions discard positions. We
 * cannot reuse it for two reasons, and the second is the one that matters: a PEG parser throws on
 * the first thing it cannot match, and a language server sees a half-typed document on every
 * keystroke. Our own sample.tss fixture — a property with no value, a bare word with no colon, an
 * unterminated string — would fail on its second line.
 *
 * So this is hand written to keep going. It never throws, records what it could not read as
 * diagnostics, and gives every node a source range so answers map back to what the user typed.
 */

/** A half-open span of the source text, in character offsets */
export interface TssRange {
	start: number;
	end: number;
}

export interface TssSelector {
	/** The selector without its quotes, e.g. `.container`, `#label`, `Label[platform=android]` */
	text: string;
	range: TssRange;
}

export interface TssProperty {
	name: string;
	nameRange: TssRange;
	/** Absent while the value is still being typed */
	value?: TssValue;
	range: TssRange;
}

export type TssValue =
	| { kind: 'string'; value: string; terminated: boolean; range: TssRange }
	| { kind: 'number'; value: number; range: TssRange }
	| { kind: 'boolean'; value: boolean; range: TssRange }
	| { kind: 'null'; range: TssRange }
	| { kind: 'undefined'; range: TssRange }
	| { kind: 'object'; properties: TssProperty[]; range: TssRange }
	| { kind: 'array'; elements: TssValue[]; range: TssRange }
	| {
		kind: 'expression';
		/** What the author wrote, with comments removed */
		text: string;
		/** Alloy's own reading of it: whitespace outside strings collapsed, Locale.getString as L */
		normalised: string;
		range: TssRange;
	};

export interface TssRule {
	selector: TssSelector;
	properties: TssProperty[];
	/** The block's braces, absent when the rule has not been given one yet */
	bodyRange?: TssRange;
	range: TssRange;
}

export interface TssDiagnostic {
	message: string;
	range: TssRange;
}

export interface TssDocument {
	rules: TssRule[];
	diagnostics: TssDiagnostic[];
}

/** What sits at an offset, which is what a provider asks before deciding what to offer */
export interface TssNodeAt {
	kind: 'selector' | 'propertyName' | 'value' | 'body';
	rule: TssRule;
	property?: TssProperty;
}

const BARE = /[a-zA-Z0-9_$]/;
const DIGIT = /[0-9]/;
const BITWISE = [ '>>>', '>>', '<<<', '<<', '&', '|', '^' ];

/**
 * Parses TSS, recovering rather than failing.
 *
 * @param text - The document contents
 * @returns {TssDocument} The rules it could read, and what it could not
 */
export function parseTss (text: string): TssDocument {
	const strict = new TssParser(text, false).parse();

	// A block that never closed swallows everything after it. That is what the text says, and it
	// is useless: the rules below a typo would answer nothing. So anything that did not read
	// cleanly is read again, treating a name back at column zero as the end of the block.
	//
	// The trigger is any diagnostic rather than an unterminated block specifically, because a
	// later stray brace can close the wrong block and leave the parse silently wrong instead of
	// visibly unfinished. A document that reads cleanly is never read twice, which is what keeps
	// valid TSS written without indentation safe from the heuristic.
	if (strict.diagnostics.length === 0) {
		return strict;
	}

	return new TssParser(text, true).parse();
}

const UNTERMINATED_BLOCK = 'Unterminated block';

class TssParser {

	private offset = 0;

	private readonly rules: TssRule[] = [];
	private readonly diagnostics: TssDiagnostic[] = [];

	constructor (private readonly text: string, private readonly dedentClosesBlocks: boolean) {}

	public parse (): TssDocument {
		for (;;) {
			this.skipTrivia();
			if (this.atEnd()) {
				break;
			}

			const before = this.offset;
			this.parseRule();

			// nothing consumed means an unrecognised character; step over it so the loop ends
			if (this.offset === before) {
				this.report(`Unexpected ${JSON.stringify(this.text[this.offset])}`, this.offset, this.offset + 1);
				this.offset++;
			}
		}

		return { rules: this.rules, diagnostics: this.diagnostics };
	}

	private parseRule (): void {
		const start = this.offset;
		const selector = this.parseName();
		if (!selector) {
			return;
		}

		this.skipTrivia();
		if (this.peek() === ':') {
			this.offset++;
			this.skipTrivia();
		}

		let properties: TssProperty[] = [];
		let bodyRange: TssRange|undefined;

		// a selector with no block yet is still a rule — the user is part way through writing one
		if (this.peek() === '{') {
			const bodyStart = this.offset;
			properties = this.parseBlock();
			bodyRange = { start: bodyStart, end: this.offset };
		}

		this.rules.push({
			selector: { text: selector.text, range: selector.range },
			properties,
			bodyRange,
			range: { start, end: this.offset }
		});
	}

	/**
	 * The contents of a `{ ... }` block
	 *
	 * @returns {TssProperty[]} Its properties, including any that are still being typed
	 */
	private parseBlock (): TssProperty[] {
		const open = this.offset;
		this.offset++;

		const properties: TssProperty[] = [];

		for (;;) {
			this.skipTrivia();

			if (this.atEnd()) {
				this.report(UNTERMINATED_BLOCK, open, this.offset);
				return properties;
			}

			if (this.peek() === '}') {
				this.offset++;
				return properties;
			}

			// a name back at column zero, in a document already known to be missing a brace
			if (this.dedentClosesBlocks && this.atLineStart()) {
				this.report(UNTERMINATED_BLOCK, open, this.offset);
				return properties;
			}

			const before = this.offset;
			const property = this.parseProperty();
			if (property) {
				properties.push(property);
			}

			if (this.offset === before) {
				this.report(`Unexpected ${JSON.stringify(this.text[this.offset])}`, this.offset, this.offset + 1);
				this.offset++;
			}
		}
	}

	private parseProperty (): TssProperty|undefined {
		const start = this.offset;
		const name = this.parseName();
		if (!name) {
			return;
		}

		this.skipTrivia();

		// a bare word with no colon is a property name mid-keystroke, which is exactly what a
		// completion request needs to see
		if (this.peek() !== ':') {
			return { name: name.text, nameRange: name.range, range: { start, end: name.range.end } };
		}

		this.offset++;
		this.skipTrivia();

		// the value cannot be back at column zero on a later line: in a document already missing a
		// brace that is the next rule, not this property's value
		if (this.dedentClosesBlocks && this.atLineStart()) {
			return { name: name.text, nameRange: name.range, range: { start, end: name.range.end } };
		}

		const value = this.parseValue();
		return {
			name: name.text,
			nameRange: name.range,
			value,
			range: { start, end: value ? value.range.end : name.range.end }
		};
	}

	/**
	 * A quoted or bare name, used for both selectors and property names
	 *
	 * @returns {{ text: string, range: TssRange }|undefined} The name, or nothing if there is none here
	 */
	private parseName (): { text: string; range: TssRange }|undefined {
		const character = this.peek();

		if (character === '"' || character === "'") {
			const string = this.readString();
			return { text: string.value, range: string.range };
		}

		if (character && BARE.test(character)) {
			const start = this.offset;
			while (!this.atEnd() && BARE.test(this.text[this.offset])) {
				this.offset++;
			}
			return { text: this.text.slice(start, this.offset), range: { start, end: this.offset } };
		}
	}

	private parseValue (): TssValue|undefined {
		const character = this.peek();
		if (!character) {
			return;
		}

		if (character === '"' || character === "'") {
			const string = this.readString();
			if (!string.terminated) {
				this.report('Unterminated string', string.range.start, string.range.end);
			}
			return this.withOperators({ kind: 'string', value: string.value, terminated: string.terminated, range: string.range });
		}

		if (character === '{') {
			const start = this.offset;
			const properties = this.parseBlock();
			return { kind: 'object', properties, range: { start, end: this.offset } };
		}

		if (character === '[') {
			return this.parseArray();
		}

		if (DIGIT.test(character) || (character === '-' && DIGIT.test(this.text[this.offset + 1] ?? ''))) {
			return this.withOperators(this.readNumber());
		}

		if (BARE.test(character)) {
			return this.withOperators(this.readWordValue());
		}
	}

	private parseArray (): TssValue {
		const start = this.offset;
		this.offset++;

		const elements: TssValue[] = [];

		for (;;) {
			this.skipTrivia();

			if (this.atEnd()) {
				this.report('Unterminated array', start, this.offset);
				break;
			}

			if (this.peek() === ']') {
				this.offset++;
				break;
			}

			const before = this.offset;
			const element = this.parseValue();
			if (element) {
				elements.push(element);
			}

			if (this.offset === before) {
				this.report(`Unexpected ${JSON.stringify(this.text[this.offset])}`, this.offset, this.offset + 1);
				this.offset++;
			}
		}

		return { kind: 'array', elements, range: { start, end: this.offset } };
	}

	/**
	 * A bare word value: a keyword, or an expression such as `Ti.UI.SIZE`, `L('key')` or `$.args.x`.
	 *
	 * Rewinds and yields nothing when the word turns out to be the next property's name — `width:`
	 * followed by `height: 10` means width has no value yet, not that its value is `height`.
	 *
	 * @returns {TssValue|undefined} The value, or nothing if the word belongs to what comes next
	 */
	private readWordValue (): TssValue|undefined {
		const start = this.offset;

		while (!this.atEnd() && (BARE.test(this.text[this.offset]) || this.text[this.offset] === '.')) {
			this.offset++;
		}

		// a call such as L('key') or WPATH('x'): take everything up to the matching close paren
		if (this.peek() === '(') {
			this.skipBalancedParens();
		}

		const end = this.offset;
		const word = this.text.slice(start, end);

		const after = this.offset;
		this.skipTrivia();
		if (this.peek() === ':') {
			this.offset = start;
			return;
		}
		this.offset = after;

		const range = { start, end };

		switch (word) {
			case 'true':
				return { kind: 'boolean', value: true, range };
			case 'false':
				return { kind: 'boolean', value: false, range };
			case 'null':
				return { kind: 'null', range };
			case 'undefined':
				return { kind: 'undefined', range };
			default:
				return expression(this.text.slice(range.start, range.end), range);
		}
	}

	/**
	 * Extends a value across bitwise operators, which Alloy allows between constants
	 *
	 * @param left - The value parsed so far
	 * @returns {TssValue} The value, widened to an expression if operators followed it
	 */
	private withOperators (left: TssValue|undefined): TssValue|undefined {
		if (!left) {
			return left;
		}

		let end = left.range.end;

		for (;;) {
			const resume = this.offset;
			this.skipTrivia();

			const operator = BITWISE.find(candidate => this.text.startsWith(candidate, this.offset));
			if (!operator) {
				this.offset = resume;
				break;
			}

			this.offset += operator.length;
			this.skipTrivia();

			const right = this.parseValue();
			if (!right) {
				this.offset = resume;
				break;
			}
			end = right.range.end;
		}

		if (end === left.range.end) {
			return left;
		}

		const range = { start: left.range.start, end };
		return expression(this.text.slice(range.start, range.end), range);
	}

	/**
	 * Reads a quoted string.
	 *
	 * An unclosed quote stops at the end of the line rather than running to the end of the file,
	 * so a string the user is part way through does not swallow the rest of the document.
	 *
	 * @returns {{ value: string, terminated: boolean, range: TssRange }} The string and whether it closed
	 */
	private readString (): { value: string; terminated: boolean; range: TssRange } {
		const start = this.offset;
		const quote = this.text[this.offset];
		this.offset++;

		let value = '';
		let terminated = false;

		while (!this.atEnd()) {
			const character = this.text[this.offset];

			if (character === '\n' || character === '\r') {
				break;
			}

			if (character === '\\' && this.offset + 1 < this.text.length) {
				// ALOY-793: Alloy doubles a run of backslashes surrounded by whitespace before
				// parsing, so its own unescaping leaves them intact. Treating such a run as literal
				// reaches the same value without a rewrite that would shift every later offset
				const run = this.backslashRun();
				if (run) {
					value += run;
					this.offset += run.length;
					continue;
				}

				const next = this.text[this.offset + 1];
				if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(this.text.slice(this.offset + 2, this.offset + 6))) {
					value += String.fromCharCode(parseInt(this.text.slice(this.offset + 2, this.offset + 6), 16));
					this.offset += 6;
					continue;
				}

				value += unescape(next);
				this.offset += 2;
				continue;
			}

			this.offset++;

			if (character === quote) {
				terminated = true;
				break;
			}

			value += character;
		}

		return { value, terminated, range: { start, end: this.offset } };
	}

	/**
	 * A run of backslashes with whitespace on both sides, which Alloy treats as literal
	 *
	 * @returns {string|undefined} The run, if this is one
	 */
	private backslashRun (): string|undefined {
		const before = this.text[this.offset - 1];
		if (before !== undefined && !/\s/.test(before)) {
			return;
		}

		let end = this.offset;
		while (end < this.text.length && this.text[end] === '\\') {
			end++;
		}

		const after = this.text[end];
		return after !== undefined && /\s/.test(after) ? this.text.slice(this.offset, end) : undefined;
	}

	private readNumber (): TssValue {
		const start = this.offset;

		if (this.peek() === '-') {
			this.offset++;
		}
		while (!this.atEnd() && DIGIT.test(this.text[this.offset])) {
			this.offset++;
		}
		if (this.peek() === '.' && DIGIT.test(this.text[this.offset + 1] ?? '')) {
			this.offset++;
			while (!this.atEnd() && DIGIT.test(this.text[this.offset])) {
				this.offset++;
			}
		}
		if (this.peek() === 'e' || this.peek() === 'E') {
			const resume = this.offset;
			this.offset++;
			if (this.peek() === '+' || this.peek() === '-') {
				this.offset++;
			}
			if (DIGIT.test(this.peek() ?? '')) {
				while (!this.atEnd() && DIGIT.test(this.text[this.offset])) {
					this.offset++;
				}
			} else {
				this.offset = resume;
			}
		}

		const range = { start, end: this.offset };
		return { kind: 'number', value: Number(this.text.slice(start, this.offset)), range };
	}

	private skipBalancedParens (): void {
		let depth = 0;

		while (!this.atEnd()) {
			const character = this.text[this.offset];

			if (character === '"' || character === "'") {
				this.readString();
				continue;
			}

			this.offset++;

			if (character === '(') {
				depth++;
			} else if (character === ')') {
				depth--;
				if (depth === 0) {
					return;
				}
			}
		}
	}

	/** Whitespace, commas and comments, which separate everything and mean nothing */
	private skipTrivia (): void {
		for (;;) {
			while (!this.atEnd() && /[\s,]/.test(this.text[this.offset])) {
				this.offset++;
			}

			if (this.text.startsWith('//', this.offset)) {
				while (!this.atEnd() && this.text[this.offset] !== '\n') {
					this.offset++;
				}
				continue;
			}

			if (this.text.startsWith('/*', this.offset)) {
				const end = this.text.indexOf('*/', this.offset + 2);
				this.offset = end === -1 ? this.text.length : end + 2;
				continue;
			}

			return;
		}
	}

	/** Whether the cursor sits at the first column of a line */
	private atLineStart (): boolean {
		return this.offset === 0 || this.text[this.offset - 1] === '\n';
	}

	private peek (): string|undefined {
		return this.text[this.offset];
	}

	private atEnd (): boolean {
		return this.offset >= this.text.length;
	}

	private report (message: string, start: number, end: number): void {
		this.diagnostics.push({ message, range: { start, end: Math.min(end, this.text.length) } });
	}
}

/**
 * Builds an expression value, carrying both what was written and Alloy's reading of it
 *
 * @param raw - The source text the expression spans
 * @param range - Where it sits in the document
 * @returns {TssValue} The expression
 */
function expression (raw: string, range: TssRange): TssValue {
	const text = stripComments(raw);
	return { kind: 'expression', text, normalised: normalise(text), range };
}

/**
 * Removes comments, which are not part of an expression even when written inside one
 *
 * @param text - The source text
 * @returns {string} The text without its comments
 */
function stripComments (text: string): string {
	return mapOutsideStrings(text, segment => segment.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''));
}

/**
 * Alloy's own reading of an expression: it joins the parts of a call or a bitwise chain without
 * separators, and treats `Ti.Locale.getString` and its longer spellings as `L`
 *
 * @param text - The expression text
 * @returns {string} The normalised form
 */
function normalise (text: string): string {
	const collapsed = mapOutsideStrings(text, segment => segment.replace(/\s+/g, ''));
	return collapsed.replace(/^(?:Titanium|Ti|Alloy)\.Locale\.getString/, 'L');
}

/**
 * Applies a transform to the parts of some text that are not inside a quoted string, so that
 * rewriting never reaches into a string literal's contents
 *
 * @param text - The text to walk
 * @param transform - Applied to each run of text outside a string
 * @returns {string} The rewritten text
 */
function mapOutsideStrings (text: string, transform: (segment: string) => string): string {
	let out = '';
	let outside = '';
	let quote: string|undefined;

	for (let index = 0; index < text.length; index++) {
		const character = text[index];

		if (quote) {
			out += character;
			if (character === quote && text[index - 1] !== '\\') {
				quote = undefined;
			}
			continue;
		}

		if (character === '"' || character === "'") {
			out += transform(outside) + character;
			outside = '';
			quote = character;
			continue;
		}

		outside += character;
	}

	return out + transform(outside);
}

/**
 * Unescapes one character following a backslash
 *
 * @param character - The escaped character
 * @returns {string} What it stands for
 */
function unescape (character: string): string {
	switch (character) {
		case 'n': return '\n';
		case 'r': return '\r';
		case 't': return '\t';
		case 'b': return '\b';
		case 'f': return '\f';
		default: return character;
	}
}

/**
 * What sits at an offset in a parsed document.
 *
 * This is what replaces scanning backwards from the cursor for quote characters: a provider asks
 * where it is and gets an answer derived from the parse rather than from a regular expression.
 *
 * @param document - The parsed document
 * @param offset - A character offset into the source
 * @returns {TssNodeAt|undefined} What is there, if anything
 */
export function nodeAt (document: TssDocument, offset: number): TssNodeAt|undefined {
	for (const rule of document.rules) {
		if (!contains(rule.range, offset)) {
			continue;
		}

		if (contains(rule.selector.range, offset)) {
			return { kind: 'selector', rule };
		}

		const found = inProperties(rule, rule.properties, offset);
		if (found) {
			return found;
		}

		return { kind: 'body', rule };
	}
}

/**
 * Searches a property list, descending into nested objects so the innermost match wins
 *
 * @param rule - The rule the properties belong to
 * @param properties - The properties to search
 * @param offset - A character offset into the source
 * @returns {TssNodeAt|undefined} What is there, if anything
 */
function inProperties (rule: TssRule, properties: TssProperty[], offset: number): TssNodeAt|undefined {
	for (const property of properties) {
		if (property.value?.kind === 'object' && contains(property.value.range, offset)) {
			const nested = inProperties(rule, property.value.properties, offset);
			if (nested) {
				return nested;
			}
			return { kind: 'value', rule, property };
		}

		if (contains(property.nameRange, offset)) {
			return { kind: 'propertyName', rule, property };
		}

		if (property.value && contains(property.value.range, offset)) {
			return { kind: 'value', rule, property };
		}
	}
}

/**
 * Whether an offset falls within a range, counting the position just past its end so that a cursor
 * sitting at the end of a word is still in that word
 *
 * @param range - The range to test
 * @param offset - A character offset into the source
 * @returns {boolean} Whether it is inside
 */
function contains (range: TssRange, offset: number): boolean {
	return offset >= range.start && offset <= range.end;
}

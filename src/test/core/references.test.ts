import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ReferenceIndex, SourceCache } from '../../core/references.ts';

/** A view and a stylesheet that reference each other, as the fixtures do */
const view = {
	path: '/app/views/index.xml',
	text: '<Alloy>\n\t<Window class="container">\n\t\t<Label id="label" class="big title">Hi</Label>\n\t\t<Label id="other"/>\n\t</Window>\n</Alloy>'
};

const style = {
	path: '/app/styles/index.tss',
	text: '".container": {\n\tbackgroundColor: "white"\n}\n\n"#label": {\n\tcolor: "#000"\n}\n\n"Label[platform=android]": {\n\tcolor: "red"\n}'
};

const appStyle = {
	path: '/app/styles/app.tss',
	text: '".big": {\n\tfontSize: 20\n}'
};

describe('core/references', () => {

	describe('what a view uses', () => {

		it('should record every id, class and tag a view names', () => {
			const index = new ReferenceIndex({ views: [ view ], styles: [] });
			const kinds = (kind: string): string[] => index.usages.filter(usage => usage.kind === kind).map(usage => usage.name);

			assert.deepEqual(kinds('id'), [ 'label', 'other' ]);
			// a class attribute holds a whitespace separated list, as in HTML
			assert.deepEqual(kinds('class'), [ 'container', 'big', 'title' ]);
			assert.deepEqual(kinds('tag'), [ 'Alloy', 'Window', 'Label', 'Label' ]);
		});

		it('should point each usage at where it was written', () => {
			const index = new ReferenceIndex({ views: [ view ], styles: [] });
			const big = index.usages.find(usage => usage.kind === 'class' && usage.name === 'big');

			assert.equal(big?.file, view.path);
			// the range covers just that one class within the attribute, not the whole value
			assert.equal(view.text.slice(big!.range.start, big!.range.end), 'big');
		});

		it('should skip an id or class attribute that has no value yet', () => {
			// `<Label id>` names nothing, so there is nothing to link it to
			const index = new ReferenceIndex({ views: [ { path: '/v.xml', text: '<Alloy><Label id class="real"/></Alloy>' } ], styles: [] });

			assert.deepEqual(index.idsIn('/v.xml'), []);
			assert.deepEqual(index.usages.filter(usage => usage.kind === 'class').map(usage => usage.name), [ 'real' ]);
		});

		it('should list the ids in one view', () => {
			const index = new ReferenceIndex({ views: [ view ], styles: [] });
			assert.deepEqual(index.idsIn(view.path), [ 'label', 'other' ]);
		});
	});

	describe('what a stylesheet defines', () => {

		it('should record each selector with its kind and qualifiers', () => {
			const index = new ReferenceIndex({ views: [], styles: [ style ] });

			assert.deepEqual(index.definitions.map(definition => [ definition.kind, definition.name ]), [
				[ 'class', 'container' ], [ 'id', 'label' ], [ 'tag', 'Label' ]
			]);
			assert.deepEqual(index.definitions[2].queries, { platform: [ 'android' ] });
		});

		it('should point each definition at its selector', () => {
			const index = new ReferenceIndex({ views: [], styles: [ style ] });
			const label = index.definitions.find(definition => definition.kind === 'id');

			assert.equal(style.text.slice(label!.range.start, label!.range.end), '"#label"');
		});
	});

	describe('linking the two', () => {

		it('should find where a class used in a view is defined', () => {
			const index = new ReferenceIndex({ views: [ view ], styles: [ style, appStyle ] });

			assert.deepEqual(index.stylesDefining('class', 'container').map(definition => definition.file), [ style.path ]);
			// app.tss participates like any other stylesheet, which is what vscode-titanium does
			assert.deepEqual(index.stylesDefining('class', 'big').map(definition => definition.file), [ appStyle.path ]);
		});

		it('should find nothing for a class no stylesheet defines', () => {
			const index = new ReferenceIndex({ views: [ view ], styles: [ style ] });
			assert.deepEqual(index.stylesDefining('class', 'title'), []);
		});

		it('should find where a selector is used', () => {
			const index = new ReferenceIndex({ views: [ view ], styles: [ style ] });
			const usages = index.viewsUsing('id', 'label');

			assert.equal(usages.length, 1);
			assert.equal(usages[0].file, view.path);
		});

		it('should not confuse a class with a tag of the same name', () => {
			const views = [ { path: '/v.xml', text: '<Alloy><Label class="Label"/></Alloy>' } ];
			const styles = [ { path: '/s.tss', text: '"Label": { color: "red" }' } ];
			const index = new ReferenceIndex({ views, styles });

			assert.deepEqual(index.stylesDefining('class', 'Label'), []);
			assert.equal(index.stylesDefining('tag', 'Label').length, 1);
		});
	});

	describe('documents being typed', () => {

		it('should index what it can from a half written view', () => {
			const index = new ReferenceIndex({ views: [ { path: '/v.xml', text: '<Alloy>\n\t<Window class="container">\n\t\t<Label id="lab' } ], styles: [] });
			assert.deepEqual(index.idsIn('/v.xml'), [ 'lab' ]);
		});

		it('should index what it can from a half written stylesheet', () => {
			const index = new ReferenceIndex({ views: [], styles: [ { path: '/s.tss', text: '".a": {\n\tcolor:\n\n".b": { color: "red" }' } ] });
			assert.deepEqual(index.definitions.map(definition => definition.name), [ 'a', 'b' ]);
		});

		it('should skip a selector Alloy would reject rather than inventing one', () => {
			const index = new ReferenceIndex({ views: [], styles: [ { path: '/s.tss', text: '"": { color: "red" }\n".ok": {}' } ] });
			assert.deepEqual(index.definitions.map(definition => definition.name), [ 'ok' ]);
		});
	});

	describe('the source cache', () => {
		it('should treat two spellings of one path as one file', async () => {
			// the server hands it paths derived from URIs and core hands it paths built with
			// path.join. On Windows those differ in separator for the same file, and an overlay
			// keyed under one spelling is invisible to a reader using the other.
			const cache = new SourceCache();
			const canonical = path.join(path.sep, 'projects', 'app', 'Resources', 'app.js');
			const spelled = `${path.sep}projects${path.sep}app${path.sep}.${path.sep}Resources${path.sep}app.js`;

			cache.override(canonical, 'const a = 1;');

			assert.equal(cache.peek(spelled), 'const a = 1;');
			assert.equal((await cache.read(spelled)).text, 'const a = 1;');
			assert.notEqual(cache.version(spelled), '0');

			cache.forget(spelled);
			assert.equal(cache.peek(canonical), undefined);
		});

		let root: string;
		let file: string;

		before(async () => {
			root = await fs.mkdtemp(path.join(os.tmpdir(), 'ti-ls-cache-'));
			file = path.join(root, 'index.tss');
			await fs.writeFile(file, '".one": {}');
		});

		it('should read a file and serve it again without re-reading', async () => {
			const cache = new SourceCache();

			assert.equal((await cache.read(file)).text, '".one": {}');
			assert.equal((await cache.read(file)).text, '".one": {}');
			assert.equal(cache.reads, 1);
		});

		it('should re-read once the file changes on disk', async () => {
			const cache = new SourceCache();
			await cache.read(file);

			// mtime has a coarse resolution on some filesystems, so the size changes too
			await fs.writeFile(file, '".one": {}\n".two": {}');
			assert.equal((await cache.read(file)).text, '".one": {}\n".two": {}');
			assert.equal(cache.reads, 2);
		});

		it('should prefer an override over what is on disk', async () => {
			// the editor's buffer is the truth for a file being typed in, and an unsaved edit
			// never changes mtime, so the override has to win outright
			const cache = new SourceCache();
			await cache.read(file);
			cache.override(file, '".buffer": {}');

			assert.equal((await cache.read(file)).text, '".buffer": {}');
			assert.equal(cache.reads, 1);
		});

		it('should go back to disk once an override is dropped', async () => {
			const cache = new SourceCache();
			cache.override(file, '".buffer": {}');
			cache.forget(file);

			assert.equal((await cache.read(file)).text, '".one": {}\n".two": {}');
		});

		it('should yield empty text for a file that is not there', async () => {
			const cache = new SourceCache();
			assert.equal((await cache.read(path.join(root, 'missing.tss'))).text, '');
		});
	});

	describe('reading an open buffer synchronously', () => {
		// TypeScript's LanguageServiceHost reads snapshots synchronously, so the host cannot await
		// `read`. It still must see the same open buffers everything else does: two overlays that
		// can disagree is a bug that only shows up mid-edit.
		//
		// Nothing here touches the disk, so these need no fixture: `peek` answers about buffers
		// and only about buffers.
		const file = path.join('/project', 'app', 'controllers', 'index.js');

		it('should peek an override without awaiting', () => {
			const cache = new SourceCache();
			cache.override(file, '".buffer": {}');

			assert.equal(cache.peek(file), '".buffer": {}');
		});

		it('should peek nothing for a file with no override, rather than reading the disk', () => {
			// the host falls back to its own synchronous disk read; the cache only owns buffers
			const cache = new SourceCache();

			assert.equal(cache.peek(file), undefined);
		});

		it('should peek nothing once an override is dropped', () => {
			const cache = new SourceCache();
			cache.override(file, '".buffer": {}');
			cache.forget(file);

			assert.equal(cache.peek(file), undefined);
		});

		it('should peek an empty buffer as empty rather than as absent', () => {
			// a user who has selected all and deleted has an empty buffer, not an unopened file
			const cache = new SourceCache();
			cache.override(file, '');

			assert.equal(cache.peek(file), '');
		});
	});

	describe('buffer versions', () => {
		// if the version does not move when the buffer does, the language service serves cached
		// answers forever and it looks like flakiness rather than a bug
		const file = path.join('/project', 'app', 'controllers', 'index.js');

		it('should move the version on every override', () => {
			const cache = new SourceCache();
			cache.override(file, 'one');
			const first = cache.version(file);
			cache.override(file, 'two');

			assert.notEqual(cache.version(file), first);
		});

		it('should move the version even when the text is unchanged', () => {
			// an edit that lands back on the same text is still an edit, and the service has no
			// way to know the snapshot is equivalent without being told to look
			const cache = new SourceCache();
			cache.override(file, 'same');
			const first = cache.version(file);
			cache.override(file, 'same');

			assert.notEqual(cache.version(file), first);
		});

		it('should move the version when an override is dropped', () => {
			// closing the editor swaps the buffer back for whatever is on disk, which is a change
			const cache = new SourceCache();
			cache.override(file, 'buffer');
			const open = cache.version(file);
			cache.forget(file);

			assert.notEqual(cache.version(file), open);
		});

		it('should version files independently', () => {
			const cache = new SourceCache();
			const other = path.join('/project', 'app', 'controllers', 'other.js');
			cache.override(file, 'one');
			const untouched = cache.version(other);
			cache.override(file, 'two');

			assert.equal(cache.version(other), untouched);
		});

		it('should give a stable version to a file that was never overridden', () => {
			const cache = new SourceCache();

			assert.equal(cache.version('/project/never-opened.js'), cache.version('/project/never-opened.js'));
		});
	});
});

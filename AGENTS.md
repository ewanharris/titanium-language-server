# Repository Guidelines

A language server for Titanium, providing language features for **both classic and Alloy**
projects, usable by any editor that speaks LSP.

## Project types

Both are supported and neither is an afterthought.

- **Classic** — JavaScript under `Resources/`. No views, no styles, no `$`.
- **Alloy** — the MVC triad under `app/`: XML views, TSS styles, JS controllers, plus widgets,
  models and `alloy.js`.

Anything Alloy-specific must be gated on project type. Path resolution differs: `require` resolves
against `Resources/` vs `app/lib/`, and i18n lives at `<project>/i18n` vs `<project>/app/i18n`.

## Hard constraints

These are expensive to rediscover. Do not relax them without reading why they exist.

### Dependency pins

- **`@xmldom/xmldom` at `~0.8`.** 0.9 throws a fatal `ParseError` on malformed XML; 0.8 recovers
  and reports warnings. A language server sees half-typed documents on every keystroke, so error
  recovery is not optional.

  Three things worth knowing before trying again. **`onError` does not help** — it receives the
  fatal and the `ParseError` still propagates, so there is no option that turns recovery back on.
  Throwing on more cases is the **stated intent** of 0.9 rather than a regression, so upstream will
  not restore it. And `0.8` is not an abandoned branch: it carries npm's `lts` dist-tag and ships
  the same day as 0.9 (0.8.15 with 0.9.12, 0.8.14 with 0.9.11, and so on), so the pin sits on a
  maintained line rather than a frozen one.

  Alloy 3 pins `^0.8.5`, which is an independent reason to stay: parsing a view differently from
  the compiler that consumes it means answering about a document Alloy would reject.

  If 0.9 ever becomes necessary, the options are repairing the document before parsing, or a
  tolerant parser for views only — not a config flag.
- **`typescript` at `^6`. Never `latest`.** `latest` on npm is 7.x — the Go port — whose CommonJS
  entry exports only `version` and `versionMajorMinor`. No `createLanguageService`, no `sys`. 6.x
  is the last JavaScript-based line and has the full compiler API.

### Dependencies

Prefer the platform. Node covers what this project needs, so there is no `fs-extra` and no
directory-walking library — `node:fs/promises` provides `cp`, `rm`, recursive `mkdir` and recursive
`readdir`, and `core/fs.ts` wraps the two patterns we actually use. There is no test framework,
assertion library, mocking library or coverage tool either — `node:test` and `node:assert/strict`
are the whole test stack. Only one XML parser: `@xmldom/xmldom` handles views, `tiapp.xml` and
`strings.xml` alike.

Before adding a dependency, check whether Node already does it.

`engines` is `>=22`, and that is a floor rather than a preference — Node 20 reached end of life on
2026-04-30. The supported LTS lines are 22 (until 2027-04-30) and 24 (until 2028-04-30), which is
what CI covers. Anything below 22 is unsupported and should not be worked around in code.

### Modules

The package is **ESM** (`"type": "module"`, `module: nodenext`), so relative imports carry a `.js`
extension. Every runtime dependency is still CommonJS and is imported by name — Node's interop
handles all of them, `typescript` included.

ESM is what keeps the test stack current: `mocha`, `chai` and `sinon` are all ESM-only now, and
staying CommonJS meant freezing them. The platform runner made that moot, but the constraint stands
for anything else.

A CommonJS extension host cannot always `import` this package — `require(esm)` needs Node 20.19 or
22.12, and VS Code has shipped older. It does not need to: `require.resolve` does not run the
module, so `require.resolve('titanium-language-server/server')` gets the same path as `serverPath`
on any Node.

There is **one server artifact, not two**. `bin` points straight at `out/server.js`, which carries
the shebang from `server.ts` — tsc preserves it — and starts a server when it is the process entry
point. So the command, `serverPath` and `require.resolve` all reach the same file, and npm handles
the mode bit and the Windows `.cmd` shim. A separate `bin` script would be a fourth thing to keep
working, unchecked by tsc and ESLint, and it broke twice while it existed.

### Protocol discipline

- **stdout carries JSON-RPC and nothing else.** `vscode-languageserver` does not patch the global
  console, so a single `console.log` corrupts the stream and desyncs the client. All logging goes
  through `logger`, which uses the connection's `RemoteConsole` and falls back to stderr before a
  connection exists. `no-console` is an ESLint error for this reason.
- **Zero custom protocol.** No custom requests, no client-side command handlers. Every one is a
  thing each editor must implement before anything works there. Code actions carry a
  `WorkspaceEdit` rather than a `Command`.
- **Gate every client capability.** Never assume `completionItem.snippetSupport`,
  `window.showDocument.support` or `codeAction.codeActionLiteralSupport`. Editors differ, and a
  missing snippet engine means literal `${1}` inserted into a user's code.

### Architecture

- **`core/` imports nothing from `vscode-languageserver`.** All analysis lives there — parsing, the
  project model, cross-referencing, declaration generation. `server/` is a thin adapter that
  translates between the protocol and core. This keeps analysis testable without a protocol
  harness.
- **Answers map back to source positions**, never to positions in generated or virtual content.

## Commands

- `npm run build` — compile to `out/`
- `npm run watch` — rebuild on change
- `npm run lint` — ESLint over `src/`
- `npm test` — build output under coverage; fails below the coverage floor

## Testing

- **Write the test first.** Red, green, refactor: the failing test comes before the code that
  satisfies it, and a test that has never been seen to fail has not been shown to test anything.
  When a change fixes a bug, reproduce it as a failing test before fixing it.
- Tests land with the change. The test corpus is the specification — a feature without a corpus
  entry is not done.
- The test stack is `node:test` plus `node:assert/strict`, run over the build output. Coverage,
  mocking and fake timers are all part of it — do not reach for a library.
- Coverage floor is 90% lines and functions, 80% branches, passed to `node --test` as thresholds so
  the run exits non-zero below them. CI enforces it.
- `node --test` collects coverage from spawned children, so the end-to-end server tests count
  towards the floor rather than needing an ignore pragma. It only reports files something loaded,
  though: a module no test and no source file imports is invisible to the gate.
- The protocol layer is covered by an end-to-end client that speaks LSP over stdio and **rejects
  anything that is not a `Content-Length` framed message**. That strictness is what catches stray
  writes to stdout, which are otherwise invisible until a real client desyncs.
- Both project types need coverage. An Alloy-only fixture hides real bugs in classic path
  resolution.
- **Check TSS against Alloy's own parser after changing the TSS parser.** Alloy ships a generated
  `Alloy/grammar/tss.js` and 419 `.tss` files, 246 of them regression fixtures under
  `test/apps/testing` named for the tickets that produced them. Clone `tidev/alloy`, parse every
  one with both parsers and compare selectors, property names and values. Deliberately a manual
  check rather than a dependency, so it has to be remembered.

  It is worth remembering: the first run found `\uXXXX` escapes unimplemented (ALOY-813), comments
  left inside call expressions, and that Alloy doubles a whitespace-delimited run of backslashes
  before parsing (ALOY-793) so those backslashes survive its own unescaping. None of those were
  reachable from fixtures written by hand.

  Two traps when comparing. Alloy stores strings JSON-quoted and expressions behind an
  `__ALLOY_EXPR__--` prefix, so both sides need normalising into one vocabulary first — and do not
  collapse whitespace on Alloy's side, because it already emits its normalised form and a blunt
  regex reaches inside string literals. Alloy also wraps a file in braces before parsing when it is
  not already wrapped, which `styler.js` does and a comparison must do too.

## Style

TypeScript with `strict` enabled. Tabs, semicolons, single quotes. `camelCase` for functions and
variables, `PascalCase` for types. Run `npm run lint` before opening a pull request.

## Commits and pull requests

Conventional Commits, for example `feat(tss): …`, `fix(view): …`, `test: …`. Issue references go in
the commit body rather than the subject.

Every pull request body **closes its issues with GitHub's keyword syntax** — `Closes #9`, one per
issue — so merging shuts them automatically. `Refs #9` only links, and leaves someone to close it by
hand later; use it only for an issue the pull request genuinely does not finish.

Work on a branch and open a pull request. Nothing is pushed to `main` directly. Where several
changes are in flight, stack the branches.

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
  recovery is not optional. Alloy pins the same range.
- **`typescript` at `^6`. Never `latest`.** `latest` on npm is 7.x — the Go port — whose CommonJS
  entry exports only `version` and `versionMajorMinor`. No `createLanguageService`, no `sys`. 6.x
  is the last JavaScript-based line and has the full compiler API.

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

- Tests land with the change. The test corpus is the specification — a feature without a corpus
  entry is not done.
- Coverage floor is 90% lines, statements and functions. CI enforces it.
- The protocol layer is covered by an end-to-end client that speaks LSP over stdio and **rejects
  anything that is not a `Content-Length` framed message**. That strictness is what catches stray
  writes to stdout, which are otherwise invisible until a real client desyncs.
- Both project types need coverage. An Alloy-only fixture hides real bugs in classic path
  resolution.

## Style

TypeScript with `strict` enabled. Tabs, semicolons, single quotes. `camelCase` for functions and
variables, `PascalCase` for types. Run `npm run lint` before opening a pull request.

## Commits

Conventional Commits, for example `feat(tss): …`, `fix(view): …`, `test: …`.

# titanium-language-server

A language server for [Titanium](https://titaniumsdk.com), providing language features for both
classic and Alloy projects in any editor that speaks LSP.

> **Status: in development.** Not yet published, and not yet feature complete. See the
> [phase 1 issue](https://github.com/ewanharris/titanium-language-server/issues/3) for what is
> being built.

## Why

The same language features are currently implemented twice — once in
[vscode-titanium](https://github.com/tidev/vscode-titanium), once in
[pulsar-titanium](https://github.com/tidev/pulsar-titanium) — and neither can serve any other
editor. This is one implementation, so the editor plugins become thin clients and Zed, neovim and
anything else with an LSP client get the same features.

## Project types

| | Classic | Alloy |
| --- | --- | --- |
| Source | `Resources/` | `app/` |
| Views and styles | — | `.xml`, `.tss` |
| i18n | `<project>/i18n` | `<project>/app/i18n` |

Both are supported.

## Development

```sh
npm install
npm run build      # or: npm run watch
npm run lint
npm test
npm run test:e2e   # reaches the npm registry
```

Requires Node 22 or newer.

See [AGENTS.md](./AGENTS.md) for the project's constraints — dependency pins and the reasons
behind them, protocol discipline, and the architectural split. Read it before contributing.

## Types

JavaScript features come from `@types/titanium`. A project that installs it gets exactly that copy.
One that does not gets a version matched to its tiapp's `sdk-version`, fetched from npm into
`~/.titanium/types/<version>` and reused from there, offline included. Set
`TITANIUM_LANGUAGE_SERVER_TYPES_CACHE` to keep that cache somewhere else.

## Settings

The settings live under a `titanium` section, with vscode-titanium's names and defaults, so a
setting customised there carries over unchanged.

| Setting | Default | What it does |
| --- | --- | --- |
| `codeTemplates.jsFunction` | `\nfunction ${text}(e){\n}\n` | A generated event handler |
| `codeTemplates.tssClass` | `\n'.${text}': {\n}\n` | A generated class rule |
| `codeTemplates.tssId` | `\n'#${text}': {\n}\n` | A generated id rule |
| `codeTemplates.tssTag` | `\n'${text}': {\n}\n` | A generated tag rule |
| `project.defaultI18nLanguage` | `en` | The locale listed first when a translation is shown or jumped to |

In a template, `${text}` is the name being generated for, and `\n` written as two characters is a
line break.

A client that answers `workspace/configuration` is asked for the section, and asked again whenever
it sends `workspace/didChangeConfiguration`. A client that cannot be asked can send the section in
`initializationOptions` and push changes in `workspace/didChangeConfiguration`. Either way the
section sits under a `titanium` key:

```json
{ "titanium": { "project": { "defaultI18nLanguage": "fr" } } }
```

`initializationOptions` are the base the other two are read over, setting by setting, so a client
that answers for some settings and not others keeps the rest of what it sent at startup.

## Licence

Apache-2.0. See [LICENSE.md](./LICENSE.md).

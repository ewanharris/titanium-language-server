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
```

Requires Node 20 or newer.

See [AGENTS.md](./AGENTS.md) for the project's constraints — dependency pins and the reasons
behind them, protocol discipline, and the architectural split. Read it before contributing.

## Licence

Apache-2.0. See [LICENSE.md](./LICENSE.md).

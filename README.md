# titanium-language-server

A language server for [Titanium](https://titaniumsdk.com). It gives classic and Alloy projects
completion, hover, go to definition and code actions in any editor that speaks the
[Language Server Protocol](https://microsoft.github.io/language-server-protocol/).

> **Status: in development, not yet published.** [Phase 1](https://github.com/ewanharris/titanium-language-server/issues/3)
> tracks replacing the language features in vscode-titanium, which will bundle the server.

## Why

The same language features were implemented twice, once in
[vscode-titanium](https://github.com/tidev/vscode-titanium) and once in
[pulsar-titanium](https://github.com/tidev/pulsar-titanium), and neither could serve any other
editor. This is one implementation: the editor plugins become thin clients, and Zed, Neovim and
anything else with an LSP client get the same features.

## What it does

The server works out what a file is from where it sits in the project, so the same `.js` is a
controller under `app/controllers` and plain JavaScript under `Resources`.

### Alloy views

- **Completion** of tags, attributes and events, from the types of the element each tag creates,
  plus Alloy's own attributes such as `id`, `class`, `platform` and `bindId`. Read-only properties
  are left out, and so is anything the element already has.
- **Hover** on a tag gives the type it creates and every style the element ends up with, and the
  rule each comes from, including `app.tss`, themes and platform folders. Hover on an attribute
  gives its type and documentation. Hover on an image path shows the image.
- **Go to definition** from a class, an id or a tag to the rule that styles it, from an event
  handler to the function in the controller, from a `<Require>` to the file it names, and from a
  translation key to the strings that declare it.
- **Code actions** generate a missing style for a class, id or tag, generate a missing handler in
  the controller, add a missing translation, and extract an element's attributes into a new style.

### Alloy stylesheets

- **Completion** of selectors from the tags, classes and ids of the view the stylesheet styles,
  and of the properties a rule's elements actually take. Values complete too: booleans, colour
  names, layouts and Titanium constants, image paths, translation keys inside `L()` and the keys of
  `Alloy.CFG`.
- **Hover** and **go to definition** from a rule back to the elements it styles.

### Controllers and JavaScript

Controllers, `alloy.js`, `app/lib` and classic `Resources/` code get completion, hover and go to
definition from TypeScript and the Titanium types. In an Alloy controller `$` knows the ids of its
view and the type each one creates, and `Alloy.CFG` knows the keys in `config.json`. `require`
resolves the way Titanium does, and translation keys and image paths complete where they are
written.

### tiapp.xml

`<sdk-version>` completes from the SDKs the Titanium CLI reports. `<module>`, and its `platform`
and `version`, complete from the modules installed in the project and globally. A short list of
values completes where the build reads a fixed set:

- a `<property>`'s `type`, and `true` or `false` in one whose type is `bool`
- the units `ti.ui.defaultunit` takes on both platforms
- a deployment `<target>`'s `device`, and `true` or `false` in it
- `true` or `false` in `<fullscreen>`, `<navbar-hidden>` and `<statusbar-hidden>`, and in
  `<use-app-thinning>` and `<use-autolayout>` under `<ios>`
- a `<module>`'s `deploy-type`, one entry of the list at a time

## Requirements

- **The Titanium CLI** (`ti`) on the `PATH` for SDK completion in `tiapp.xml` and for globally
  installed modules. Without it, everything else still works.
- **npm and a network connection** the first time a project needs a given version of the
  Titanium types — see [Types](#types).

## Using it in VS Code

The [Titanium extension](https://marketplace.visualstudio.com/items?itemName=TiDev.titanium-sdk)
will bundle the server from its next release, so there is nothing to install. Open a folder with a
Titanium project in it, or the folder directly above one.

For that release, the `titanium.languageServer.enabled` setting switches back to the extension's
previous built-in features. It takes effect after reloading the window.

## Types

JavaScript features come from `@types/titanium`. A project that installs it gets exactly that copy.
One that does not gets a version matched to its tiapp's `sdk-version`, fetched from npm into
`~/.titanium/types/<version>` and reused from there, offline included. Set
`TITANIUM_LANGUAGE_SERVER_TYPES_CACHE` to keep that cache somewhere else.

## Troubleshooting

The server logs to the **Titanium Language Server** output channel in VS Code. It says which
projects it registered, which version of the types each one uses, and why a `tiapp.xml` was
turned away.

- **Nothing in JavaScript files:** look for a line saying no `@types/titanium` could be resolved.
  The first open of a project needs the network to fetch them.
- **Nothing at all:** check that a `tiapp.xml` with an `<sdk-version>` is in the workspace folder
  or the folder directly inside it.

## Development

```sh
npm install
npm run build          # or: npm run watch
npm run lint
npm test               # from source, under coverage
npm run test:package   # builds, then checks the published artifact
npm run test:e2e       # reaches the npm registry
```

Development needs Node 22.18 or newer, because the tests run the TypeScript sources directly.
The published package is compiled JavaScript and runs on 20.18.

Read [AGENTS.md](./AGENTS.md) before contributing. It covers the project's constraints, the
reasons for its dependency pins, its protocol discipline and its architecture.

## Licence

Apache-2.0. See [LICENSE.md](./LICENSE.md).

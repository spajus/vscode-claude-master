# Contributing

Thanks for helping out. Bug reports are most useful with the versions and the **Claude Master** output channel log that the issue form asks for.

## Build and test

You need Node.js 22 or newer.

```sh
npm install
npm test          # compile + unit tests
npm run package   # produces claude-master-<version>.vsix
code --install-extension claude-master-<version>.vsix
```

Or open the folder in VS Code and press F5 to run it in an Extension Development Host.

The unit tests cover the pure logic in `src/core/`, which has no VS Code dependency. Everything that touches VS Code or the file system lives in the other files under `src/`.

## Icon

`media/icon.png` is rendered from `media/icon.svg`. After editing the SVG, regenerate the PNG:

```sh
npx --yes @resvg/resvg-js-cli --fit-width 256 media/icon.svg media/icon.png
```

`media/sessions.svg` is the monochrome activity-bar icon and is used as is.

## Releasing

1. Bump `version` in `package.json` (`npm version <patch|minor|major> --no-git-tag-version`).
2. Move the entries under `## [Unreleased]` in `CHANGELOG.md` into a section for the new version, and update the compare links at the bottom.
3. Commit, then tag and push:

   ```sh
   git tag v<version>
   git push origin master v<version>
   ```

The **Release** workflow checks that the tag matches `package.json`, runs the tests, attaches the `.vsix` to a GitHub Release with that version's changelog section as notes, and publishes to the VS Code Marketplace and Open VSX. The one-time setup for publishing is in [docs/publishing.md](docs/publishing.md).

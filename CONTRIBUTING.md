# Contributing to Kificut

Thanks for taking the time to help. This page covers setup, the layout of the code and what we look for in pull requests.

## Getting set up

```sh
git clone https://github.com/Kificut-app/kificut.git
cd kificut
npm install
npm run dev
```

Node.js 20.19 or newer is required. The dev server reloads the renderer on save; changes to the main process or preload restart the app.

On Linux you may need the usual Electron runtime libraries (GTK 3, NSS, ALSA). Any desktop install of Ubuntu or Fedora already has them.

## Where things live

```
src/
  main/        Electron main process: windows, menus, dialogs, FFmpeg, file access
  preload/     The bridge that exposes window.kificut to the renderer
  shared/      Code used by both sides: the project model, IPC contract, time helpers,
               layer geometry and the FFmpeg filter graph builder
  renderer/
    src/
      store/       Zustand stores, undo history and every editing action
      engine/      Playback, the WebGL and canvas compositors, text rendering, export
      lib/         Pure helpers: timeline operations, factories, media utilities
      components/  React UI, grouped by panel
      styles/      CSS, with design tokens in tokens.css
```

`docs/ARCHITECTURE.md` explains how preview and export fit together.

## Checks

Run these before opening a pull request. CI runs the same ones.

```sh
npm run lint
npm run typecheck
npm test
```

`npm test` includes integration tests that render small projects through the bundled FFmpeg. They take around ten seconds and are skipped automatically if the binaries are missing.

If you change anything in `src/shared/ffmpeg-graph.ts` or `src/renderer/src/lib/timeline.ts`, please add or update a test. Those two files hold most of the logic that is easy to break without noticing.

## Code style

- TypeScript in strict mode everywhere. Avoid `any`; the IPC contract in `src/shared/ipc.ts` is typed end to end.
- Prettier handles formatting (`npm run format`). Single quotes, no semicolons, 110 columns.
- Keep components small and keep state changes in `store/actions.ts`, so they stay undoable and reusable from menus and shortcuts.
- Every edit to the project goes through `commit()` or a gesture (`beginGesture`, `updateGesture`, `endGesture`). That is what makes undo work.
- Comments should explain why something is done, not restate the code.
- UI text uses sentence case and plain words. Shortcuts shown in tooltips use the `Label|Key` format of `data-tip`.

## Pull requests

- Keep each pull request focused on one change. Smaller ones get reviewed faster.
- Describe what you changed and how you tested it. Screenshots help for anything visual.
- If you are planning something large, open an issue first so we can agree on the approach.

## Reporting bugs

Open an issue with your OS, the Kificut version (Help > About), what you did and what happened. If a specific file causes the problem, the container and codec details are very useful, and a short sample is even better.

## Good places to start

- Anything on the roadmap in the README
- Making the preview handle more formats without a proxy
- Accessibility of the timeline for keyboard and screen reader users
- Translations, once the strings are extracted

By contributing you agree that your work is released under the MIT license.

# Architecture

This document describes how Kificut is put together, for people who want to change it.

## Processes

Kificut follows the standard Electron split.

- **Main** (`src/main`) owns the window, the native menu, file dialogs, the file system and every FFmpeg process. Nothing in the renderer touches Node APIs directly.
- **Preload** (`src/preload`) exposes a typed API as `window.kificut`. The renderer runs with `contextIsolation` and `sandbox` enabled.
- **Renderer** (`src/renderer`) is a React app that holds the project, draws the UI and plays back the timeline.

`src/shared/ipc.ts` defines the full API and channel names, so both sides are checked against the same types.

## Project model

`src/shared/types.ts` is the source of truth. A few conventions:

- All times are seconds as floating point numbers. Edits snap them to the project frame rate.
- A clip has a `start` and `duration` on the timeline, an `inPoint` in the source, and a `speed`. The source range it uses is `inPoint` to `inPoint + duration * speed`.
- Tracks are stored in compositing order. Video tracks earlier in the array are drawn first, which puts them at the bottom. The timeline shows video tracks reversed so the top track is on top.
- Clips that share a `linkId` (usually the picture and sound from one file) are selected, moved, trimmed and split together.
- Project files are JSON (`.kificut`). On save, the main process also stores each media path relative to the project file so a moved project can find its media again.

## State and undo

The renderer keeps the project in a Zustand store (`store/editor.ts`). Projects are immutable; every change goes through Immer.

- `commit(recipe, coalesceKey?)` applies a change and pushes the previous project onto the undo stack. Changes with the same coalesce key within a short window merge into one step, which is how slider drags stay a single undo.
- `beginGesture`, `updateGesture` and `endGesture` are used for pointer drags. Each update is applied to the project as it was when the gesture began, which keeps the math simple (always "original position plus delta") and produces one undo step at the end.
- The project is dirty whenever it is not the same object as the last saved one, so undoing back to the saved state clears the dirty flag.

Editing operations that do not depend on the store (overwrite, split, ripple delete, snapping) live in `lib/timeline.ts` and are unit tested.

## Preview

`engine/player.ts` drives the program monitor.

1. For each clip within a couple of seconds of the playhead it keeps a media element (`<video>`, `<audio>` or `<img>`). Elements far from the playhead are released.
2. A master clock based on `performance.now()` advances the playhead. Active elements are started at the right source time and re-seeked if they drift more than a fifth of a second.
3. Audio elements go through Web Audio: one gain node per clip for volume and fades, then a master bus with analysers for the meter. Video elements are muted, because sound comes from the linked audio clips.
4. Every frame while playing, or after a seek while paused, visible layers are drawn bottom to top by the compositor.

The compositor (`engine/compositor.ts`) is a single WebGL 2 shader that draws each layer as a textured quad. Its color math mirrors FFmpeg's `eq` filter: contrast, brightness and gamma act on luma and saturation scales chroma. Layer geometry (fit, scale, crop, rotation) comes from `src/shared/geometry.ts`, which the export uses as well. If WebGL 2 is not available, `engine/canvas-compositor.ts` draws the same geometry with a 2D canvas.

Local files are served to the renderer through the `media://` protocol registered in `src/main/protocol.ts`. It handles HTTP range requests, which video elements need to seek.

## Media

When files are imported, the main process runs FFprobe (`src/main/media.ts`) to read duration, size, frame rate, codecs and rotation. It also produces, on demand and cached under the user data folder:

- a poster frame for the media panel,
- a strip of thumbnails for the timeline,
- a waveform as 100 peaks per second,
- an H.264 preview copy for footage Chromium cannot decode.

Whether a file needs a preview copy is decided in `lib/media.ts` from the container and codecs, and can be forced for large footage in Settings.

## Export

1. The renderer rasterizes every text clip in the export range to a PNG using the same code as the preview (`engine/text.ts`), and sends the project, settings and PNGs to the main process.
2. `buildRenderPlan` in `src/shared/ffmpeg-graph.ts` turns the timeline into FFmpeg inputs and one filter graph:
   - a `color` source as the background canvas,
   - per visual clip: trim with input seeking, speed with `setpts`, `hflip`/`vflip`, `crop`, `scale`, `eq`, `rotate`, opacity with `colorchannelmixer`, fades with `fade` on the alpha channel, then `overlay` at the computed position,
   - per audio clip: `atempo` for speed, `volume`, `afade`, `adelay` to place it in time, then `amix` for all of them.
3. The graph is written to a temporary file and passed with `-/filter_complex` (or `-filter_complex_script` on FFmpeg 6 and older) so very large projects do not run into command line limits on Windows.
4. Progress comes from `-progress pipe:1` and is forwarded to the export dialog and the taskbar or dock icon.

`src/shared/ffmpeg-graph.integration.test.ts` renders a project with every kind of layer through the real FFmpeg in each output format.

## Adding a clip property

1. Add the field to `Clip` in `src/shared/types.ts` and a default in `lib/factory.ts`.
2. Fill it in for older files in `lib/project-io.ts`.
3. Add a control in `components/inspector/Inspector.tsx` that changes it through `updateClips` with a coalesce key.
4. Apply it in the preview in `engine/player.ts` (and the compositors if it affects drawing).
5. Apply it in the export in `src/shared/ffmpeg-graph.ts`, with a test.

## Adding an export format

1. Add it to `EXPORT_FORMATS` in `src/shared/export-formats.ts`.
2. Add encoder arguments in `videoCodecArgs` and `audioCodecArgs` in `src/shared/ffmpeg-graph.ts`.
3. Add a case to the integration test.

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

## Assistant connector

Assistants such as Claude edit through a fixed set of tools defined once in `src/shared/ai-tools.ts`. Each tool has a JSON Schema for its input and MCP hints such as `readOnlyHint`.

```
Claude Desktop -- stdio (MCP) --> connector (connectors/claude) -- TCP 127.0.0.1 --> Kificut main -- IPC --> renderer tools
```

- **Kificut** (`src/main/connector.ts`) listens on a random port on 127.0.0.1 and writes the port and a fresh 256 bit token to `connector.json` in its user data folder, readable only by the user. A client must send the token before anything else. Calls are forwarded to the renderer, which runs them one at a time in `src/renderer/src/ai/tools.ts` and replies with MCP content (text and JPEG images). Turning off **Let Claude edit in Kificut** stops the listener and marks the file as disabled.
- **The connector** (`connectors/claude/src`) is an MCP server built on the official SDK. It lists the tools, reads `connector.json`, starts Kificut through the recorded launch command when it is closed, and relays calls. `scripts/build-connector.mjs` bundles it into one file with Vite, writes the manifest from the same tool list and packs it with `mcpb`. The bundle ships inside the app (for the Settings button) and with each release.
- **Tools** reuse the editor's own actions, so every change is one undo step and shows up live. Edits that span several actions run inside a gesture. `view_frame` renders the composited frame through the player once all visible video has seeked, and `inspect_media` and `analyze_media` use FFmpeg in the main process (frame sampling, `select=gt(scene,0.3)` and `silencedetect`), cached per file.

To add a tool, define it in `ai-tools.ts`, implement it in `ai/tools.ts` (a test checks both lists match), and rebuild the connector with `npm run build:connector`.

## Local AI models

Kokoro (text to speech) and Whisper (speech to text) run in a module worker in the renderer (`src/renderer/src/local-ai/worker.ts`) with transformers.js and ONNX Runtime Web.

- **Install** (`src/main/models.ts`): the registry in `src/shared/models.ts` pins each model to a Hugging Face commit. The main process asks the Hub API for the file list at that revision, downloads with `net.fetch` through `src/main/download.ts` (which retries dropped connections and resumes with range requests), checks every file against its published SHA-256 (LFS files) or git blob SHA-1, writes through `.part` files and finishes with a marker file. Models live in `<userData>/models`, laid out by repository id.
- **Loading**: the privileged `models://store/` scheme serves that folder to the renderer. transformers.js is pointed at it with remote models turned off, and the worker refuses any other network request, so inference never goes online.
- **eSpeak NG**: kokoro-js imports `phonemizer`, which embeds the GPL licensed eSpeak NG. Vite aliases that import to `local-ai/phonemizer.ts`, which loads the copy downloaded with the model from `models://`. Nothing GPL is bundled.
- **Threads**: Kificut turns on `SharedArrayBuffer` (it only ever shows its own pages) so ONNX Runtime can use several threads.
- **Whisper language**: transformers.js does not detect the spoken language and falls back to English, so the worker scores Whisper's language tokens after the start token on the first 30 seconds and passes the winner on.
- **Features** (`local-ai/features.ts`): voiceovers are encoded to WAV and saved through the main process; transcripts are cached per file, model and language; `captionsForClip` maps source time segments onto a clip with its trims and speed. The same functions back the Voice tab, the Generate Captions menu item and the `generate_voiceover`, `transcribe_media` and `add_captions` tools. Nothing is bundled with the app: `list_ai_models` and `install_ai_model` let an assistant install a model on request.

## In-app assistant

The Assistant tab runs a provider loop in the main process (`src/main/assistant`), so API keys never reach the renderer. Tool calls go to the renderer through the same `callTool` path as the connector.

- `settings.ts` stores provider settings in `assistant.json`; keys are encrypted with `safeStorage`. On Linux without a keyring, keys are kept for the session only.
- `anthropic.ts` uses the official SDK's tool runner with streaming, `eager_input_streaming` tools, a cached system prompt and `fallbacks: "default"` on models that take it. Tool errors go back as `is_error` results.
- `openai.ts` speaks OpenAI style chat completions over SSE for OpenAI, Gemini, OpenRouter, Ollama, LM Studio and custom servers. Tool arguments split across chunks are joined, unreadable arguments are answered with an `INVALID_JSON` error instead of being run, and images from tools follow as a user message (retried without them for models that reject images).
- Each session keeps its own history; stopping keeps the finished tool rounds so the next message continues from there. `providers.test.ts` runs both adapters against local mock servers.

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

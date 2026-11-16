# Kificut

A free and open source video editor for Windows and macOS.

![Kificut editing a short reel](docs/screenshot.png)

Kificut is a multi-track editor built on Electron and FFmpeg. The preview is drawn on the GPU in real time and exports go straight through FFmpeg, so what you see while editing is what ends up in the file. It also runs on Linux, though Windows and macOS are the main targets.

## Features

**Editing**

- Multi-track timeline with video, audio, image, title and color layers
- Video with sound is placed as a linked pair that moves, trims and splits together (and can be unlinked)
- Trim by dragging clip edges, split with the razor tool or at the playhead, ripple delete, duplicate, copy and paste
- Overwrite editing: dropping or moving a clip onto occupied space trims whatever was there
- Snapping to clip edges, the playhead, markers and in/out points
- Markers, in and out points, and an export range
- Full undo history, autosave, and projects that remember where their media lives

**Picture and sound**

- Position, scale, rotation, opacity, flip and crop, editable in the inspector or directly on the preview
- Brightness, contrast, saturation and gamma
- Titles in any installed font with outlines, background boxes and drop shadows
- Fade in and out on any clip, per clip volume in dB, speed from 10% to 1600% with pitch kept
- Stereo output meter

**Media and export**

- Imports anything FFmpeg can read. Footage the preview cannot decode directly (ProRes, DNxHD, AVI, MPEG-2 and so on) gets a lightweight preview copy in the background, and exports always use the original file
- Filmstrip thumbnails and waveforms on the timeline
- Export to MP4 (H.264 or HEVC), WebM (VP9), QuickTime ProRes 422, animated GIF, MP3 and WAV, at the project size or smaller, with progress and time remaining

## Download

Installers for Windows and macOS are attached to each [release](https://github.com/Kificut-app/kificut/releases).

Release builds are not code signed yet. On macOS, try to open the app once, then go to System Settings > Privacy & Security and choose Open Anyway. On Windows, choose "More info" and then "Run anyway" if SmartScreen asks.

## Building from source

You need [Node.js](https://nodejs.org) 20.19 or newer (22 LTS recommended) and Git.

```sh
git clone https://github.com/Kificut-app/kificut.git
cd kificut
npm install
npm run dev
```

`npm install` downloads FFmpeg for your platform through `ffmpeg-static`, and `scripts/fetch-ffprobe.mjs` fetches the matching FFprobe from the same release into `vendor/`.

| Command              | What it does                                         |
| -------------------- | ---------------------------------------------------- |
| `npm run dev`        | Start the app with hot reload                        |
| `npm run build`      | Compile main, preload and renderer into `out/`       |
| `npm start`          | Run the compiled app                                 |
| `npm test`           | Unit tests plus export tests against the real FFmpeg |
| `npm run lint`       | ESLint                                               |
| `npm run typecheck`  | TypeScript, all three projects                       |
| `npm run dist:win`   | Windows installer in `release/`                      |
| `npm run dist:mac`   | macOS DMG and ZIP in `release/`                      |
| `npm run dist:linux` | Linux AppImage in `release/`                         |

### Packaging notes

Build each installer on the operating system it targets, because the bundled FFmpeg binary is platform specific. To build for Intel Macs from an Apple Silicon machine, reinstall with `npm_config_arch=x64 npm ci` and run `npm run dist:mac -- --x64`.

Signing is handled by electron-builder. Set `CSC_LINK` and `CSC_KEY_PASSWORD` for Windows and macOS certificates, and the `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` variables to notarize on macOS. The CI workflow in `.github/workflows/ci.yml` builds unsigned installers for every tag that starts with `v`.

## How it works

The renderer process holds the project in a Zustand store with immutable snapshots, which keeps undo and redo cheap. Playback uses one media element per clip near the playhead, synced to a master clock and composited with a small WebGL 2 shader. The shader uses the same math as FFmpeg's `eq` filter, so color adjustments look the same in the preview and in the export. Machines without WebGL 2 fall back to a 2D canvas.

When you export, text layers are rendered to PNG in the renderer and the main process turns the timeline into a single FFmpeg filter graph. The graph builder is a pure function in `src/shared/ffmpeg-graph.ts` with its own tests.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) goes into more detail.

## Keyboard shortcuts

| Action                          | Shortcut                                          |
| ------------------------------- | ------------------------------------------------- |
| Play or pause                   | Space                                             |
| Shuttle back, stop, forward     | J, K, L                                           |
| Step one frame                  | Left, Right                                       |
| Previous or next edit           | Up, Down                                          |
| Split at playhead               | S or Ctrl+K (Cmd+K)                               |
| Selection and razor tools       | V, C                                              |
| Delete, ripple delete           | Delete, Shift+Delete                              |
| Set in and out                  | I, O                                              |
| Add marker                      | M                                                 |
| Zoom timeline                   | = and -, Shift+Z to fit, Ctrl+scroll at the mouse |
| Duplicate a clip while dragging | Hold Alt (Option)                                 |

The full list is under Help > Keyboard Shortcuts.

## Roadmap

These are not in yet. Help is welcome on any of them.

- Keyframes for transform, opacity and volume
- Transitions between neighbouring clips on the same track
- Audio effects such as EQ, compression and noise reduction
- Hardware encoders (NVENC, Quick Sync, VideoToolbox) without a custom FFmpeg build
- Subtitle import and export (SRT, VTT)
- Translations

## Contributing

Bug reports, ideas and pull requests are all welcome. [CONTRIBUTING.md](CONTRIBUTING.md) explains how to get set up and where things live.

## License

Kificut is released under the [MIT license](LICENSE).

The installers include FFmpeg and FFprobe builds published by the `ffmpeg-static` project. They run as separate programs and are distributed under their own license (GPL, since the builds include x264 and x265); a copy is included with the app and the source is available from [ffmpeg.org](https://ffmpeg.org). The Inter typeface is used under the SIL Open Font License.

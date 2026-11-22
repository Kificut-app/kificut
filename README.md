# Kificut

A free and open source video editor for Windows, macOS and Linux.

![Kificut editing a short reel](docs/screenshot.png)

Kificut is a multi-track editor built on Electron and FFmpeg. The preview is drawn on the GPU in real time and exports go straight through FFmpeg, so what you see while editing is what ends up in the file. It runs on Windows, macOS and Linux.

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

**Recording**

- Record the screen, a camera, or both at once, straight into the timeline. With both, the camera lands as a picture in picture over the screen, on its own track, so it stays movable and editable
- A whole screen, one window, or an area you drag out; up to 4K or full resolution at 30 or 60 fps
- Microphone with a level meter and noise reduction, plus the computer's own sound on Windows
- Countdown, pause and resume, a floating control bar, a tray icon and global shortcuts, so recording can be stopped from anywhere
- The screen and the camera are separate MP4 files (H.264 and AAC) in sync with each other, saved as they record so a crash loses only the last couple of seconds

**AI, on your terms**

- Voiceovers from a script with Kokoro, 28 natural English voices, or in your own voice from a recording of 10 to 20 seconds, generated on your computer
- Captions from speech with Whisper in about 100 languages, also on your computer. Right click a clip and choose Generate Captions
- An assistant panel that edits with you. Bring your own key for Anthropic, OpenAI, Google Gemini or OpenRouter, or use a local model through Ollama, LM Studio or any OpenAI compatible server
- Connect Claude Desktop and ask for edits in plain language: "make a 30 second reel from the clips in my Trip folder with a title and some music". See [Use Kificut from Claude](#use-kificut-from-claude)

See [AI features](#ai-features) for what runs where.

**Media and export**

- Imports anything FFmpeg can read. Footage the preview cannot decode directly (ProRes, DNxHD, AVI, MPEG-2 and so on) gets a lightweight preview copy in the background, and exports always use the original file
- Filmstrip thumbnails and waveforms on the timeline
- Export to MP4 (H.264 or HEVC), WebM (VP9), QuickTime ProRes 422, animated GIF, MP3 and WAV, at the project size or smaller, with progress and time remaining

## Download

Installers for Windows and macOS, and an AppImage for Linux, are attached to each [release](https://github.com/Kificut-app/kificut/releases).

Release builds are not code signed yet. On macOS, try to open the app once, then go to System Settings > Privacy & Security and choose Open Anyway. On Windows, choose "More info" and then "Run anyway" if SmartScreen asks.

On Linux, make the AppImage executable and run it:

```sh
chmod +x Kificut-*-linux-x86_64.AppImage
./Kificut-*-linux-x86_64.AppImage
```

It runs on most 64-bit distributions from the last few years and updates itself like the other versions. It uses FUSE to mount itself (the `fusermount` command, which desktop installs include); without FUSE, start it with `--appimage-extract-and-run`. On systems that block Chromium's sandbox (such as Ubuntu 24.04 and later), it starts without it automatically.

When it starts, Kificut adds itself to your applications menu with its icon and opens `.kificut` projects on a double click: it writes `kificut.desktop`, icons and the project file type under `~/.local/share`, and keeps them pointing at the AppImage when an update renames it. Wayland desktops also need this entry before they let an app record the screen or use global shortcuts. If the AppImage is deleted, the menu entry hides itself. To skip this, start Kificut with `KIFICUT_NO_DESKTOP_INTEGRATION=1`; an entry you wrote yourself is never changed.

## Recording

Click the red dot in the top bar, choose **Record** on the start screen, or press Ctrl+Shift+R (Cmd+Shift+R).

- **Screen**: pick a whole screen or a window from live thumbnails. For a screen, **Select Area…** lets you drag out the part to record.
- **Camera**: pick a camera and see it before you start.
- **Screen and Camera**: both at once. Pick the corner and size the camera goes in; you can change both later in the editor like any clip.

Choose a microphone (with a level meter), whether to reduce background noise, and on Windows whether to record the computer's sound. Quality settings cover the screen resolution (full, 4K, 1440p, 1080p or 720p), the camera resolution, 30 or 60 fps, and standard or high quality. The dialog shows the free disk space and roughly how many hours fit at those settings.

While recording, a small bar shows the time and the microphone level, with pause, stop and discard. The same controls are in the tray (the menu bar on macOS, with the time next to the icon) and on global shortcuts that work in any app: **Ctrl+Shift+1** (Cmd+Shift+1) to pause or resume and **Ctrl+Shift+2** (Cmd+Shift+2) to stop. Kificut can minimize itself while it records the screen, keeps the display awake, and stops and saves on its own if the disk is nearly full.

When you stop, the recording is added at the playhead, or as a new project the size of the recording if none is open. The screen, the camera and the sound go on free tracks, so nothing already in the project is overwritten, and they are linked so they move, trim and split together (unlink them to move one alone).

Files are saved in `Documents/Kificut/Recordings`: one MP4 for the screen and one for the camera (H.264 video at the frame rate you chose, AAC sound), all starting at the same instant. The microphone is recorded with the camera, or with the screen when there is no camera. They are written while you record, so if Kificut or the computer stops unexpectedly, the next start saves what was recorded and tells you.

Notes:

- On Windows 10 (2004 and later) and Windows 11, the control bar and the camera preview stay out of screen recordings. macOS and Linux cannot keep them out, so when you record a whole screen there Kificut turns them off by default; use the tray icon or the shortcuts instead, or record a window.
- macOS asks once for permission to record the screen, the camera and the microphone. If you said no, turn Kificut on under System Settings > Privacy & Security, then open it again.
- On Linux, recording works on X11 and on Wayland (the default on Ubuntu and Fedora). On Wayland your desktop's own dialog asks which screen or window to record when you start, so Kificut shows no list of screens, recording an area is not available, and Wayland decides where the control bar goes. The tray icon needs a desktop that shows tray icons (GNOME needs the AppIndicator extension, which Ubuntu includes); the top bar of the Kificut window always has Stop and Pause too.
- Recording the computer's sound needs Windows; Electron cannot capture it on macOS or Linux yet.

## AI features

Everything AI in Kificut is optional, and nothing is downloaded or sent anywhere until you turn it on. Open it with the sparkle button in the top bar.

**Models on this computer**

| Model                                                                  | Used for                                               | Download | License                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------ | -------- | ----------------------------------- |
| [Kokoro 82M](https://huggingface.co/hexgrad/Kokoro-82M)                | Voiceovers (Voice tab)                                 | 108 MB   | Apache-2.0, eSpeak NG under GPL-3.0 |
| [Chatterbox Turbo](https://huggingface.co/ResembleAI/chatterbox-turbo) | Voiceovers in your own voice (Voice tab, My voices)    | 725 MB   | MIT                                 |
| [Whisper Base](https://huggingface.co/openai/whisper-base)             | Captions, transcripts                                  | 81 MB    | MIT                                 |
| [Whisper Small](https://huggingface.co/openai/whisper-small)           | Better captions                                        | 254 MB   | MIT                                 |
| [RNNoise](https://github.com/GregorR/rnnoise-models) (speech model)    | Reduce Noise on dialogue                               | 0.3 MB   | Public domain                       |
| [CLIP](https://huggingface.co/openai/clip-vit-base-patch32)            | Search inside footage by description                   | 157 MB   | MIT                                 |
| [MODNet](https://github.com/ZHKKKe/MODNet)                             | Remove Background behind people, in video and pictures | 26 MB    | Apache-2.0                          |
| [ORMBG](https://github.com/schirrmacher/ormbg)                         | Remove Background from any subject in pictures         | 44 MB    | Apache-2.0                          |

None of these models ship with Kificut. Install the ones you want from **AI > Models on this computer**, or ask your assistant to do it ("install the voice model"): Claude Desktop and the Assistant tab can list the models and install one with the `install_ai_model` tool, and they are told to check with you first because of the download size. They are downloaded from Hugging Face at a pinned revision, every file is checked against its published hash, and they run inside Kificut with ONNX Runtime on the CPU. Your footage and scripts never leave the computer, and the models work offline once installed. Generated voiceovers are saved as WAV files in `Documents/Kificut/Generated`.

What each one does in Kificut:

- **Voice tab**: type a script and add a voiceover at the playhead (Kokoro).
- **My voices** in the Voice tab: record yourself for 10 to 20 seconds, use the selected clip where someone speaks, or pick a file, and Kificut reads any script in that voice. Nothing is trained or uploaded; the trimmed recording is kept in Kificut's settings folder until you delete the voice. It is slower than Kokoro, a minute or two for 30 seconds of speech, and English only (Chatterbox Turbo). Not available on Intel Macs yet.
- **Generate Captions** and **Generate English Captions** in the clip menu: timed captions from speech, with the language detected automatically; the English version translates speech in other languages (Whisper).
- **Reduce Noise** in the clip menu: writes a cleaned copy of the sound, with fans, air conditioning and hum removed, and switches the clip to it (RNNoise, through FFmpeg).
- **Search inside footage**: the scan button next to the media search box. Describe a shot ("dog running on the beach") and add the matching moment to the timeline. Each file is indexed once and the index is kept (CLIP).
- **Remove Background** in the clip menu: for pictures it makes a transparent PNG; for video it makes a WebM with transparency, so anything on a lower track shows through. Video works on people and takes a few seconds of work per second of footage (MODNet, ORMBG).

Kokoro uses eSpeak NG to turn text into phonemes. eSpeak NG is GPL licensed, so it is downloaded together with the model instead of being part of Kificut.

Only use your own voice for My voices, or a voice you have the speaker's permission for, and do not pass off what it says as their real words. Kificut asks you to confirm this for every voice, and assistants can use your voices but cannot add new ones.

**Assistant with your own key**

The Assistant tab next to the Inspector is a chat that edits the open project with the same tools as the Claude connector. Pick a provider under **AI > Assistant**:

- **Anthropic** (Claude Opus 5.5 by default), **OpenAI**, **Google Gemini** or **OpenRouter** with your API key
- **Ollama** or **LM Studio** to run a model on your own computer, no key needed
- **Other**: any server with an OpenAI style `/chat/completions` endpoint, such as vLLM or LiteLLM

Keys are encrypted with the system key store (Keychain on macOS, DPAPI on Windows) and stay in Kificut's main process; the window that draws the interface never sees them. While you chat, your messages, the project details and any frames the assistant looks at go to the provider you chose. With Claude models that support it, Kificut turns on Anthropic's default refusal fallback, so a request Claude declines can be answered by another Claude model. Usage is billed by your provider to your account.

## Use Kificut from Claude

Kificut works with [Claude Desktop](https://claude.ai/download) and [Claude Code](https://claude.com/claude-code). Once connected, Claude can work in Kificut on your behalf: look through your footage, find scene changes and silences, place and trim clips, add titles and music, check frames, and export. You watch the timeline change as it works, and every change can be undone with Ctrl+Z (Cmd+Z on a Mac).

**Claude Desktop**

1. Install Claude Desktop and sign in.
2. In Kificut, open Settings and click **Install in Claude Desktop** under Claude. (You can also download `Kificut-<version>-claude.mcpb` from the [release](https://github.com/Kificut-app/kificut/releases) and double-click it.)
3. Confirm the install in Claude Desktop.

**Claude Code**

1. In Kificut, open Settings and click **Connect Claude Code** under Claude. Kificut finds Claude Code (the terminal version or the one inside VS Code, Cursor or Windsurf) and adds itself with `claude mcp add` for all your projects.
2. Start a new Claude Code session and ask it to edit in Kificut. Run `/mcp` to see the connection.

If Kificut cannot find Claude Code, it shows the command to paste into a terminal instead. Click **Connect Claude Code** again if you move Kificut to another folder.

**Try asking**

- "Look at the videos in ~/Movies/Lisbon and make a one minute highlight reel with a title at the start."
- "Cut the silent parts out of interview.mp4."
- "Add lower thirds with each speaker's name, then export a 1080p MP4 to my Desktop."

**Good to know**

- Kificut needs to be installed. If it is closed, the connector opens it.
- Claude sees the project details, file names and the frames it asks for. Nothing else on your computer is shared through the connector.
- It can only edit through the tools Kificut provides. Saves and exports never replace existing files, and Claude asks you before it uses a tool unless you allow it.
- You can turn access off at any time in Settings, under Claude.

## Updates and unsaved work

Kificut checks for new versions in the background (you can turn this off in Settings, under Updates, or check by hand from the Help menu, or the Kificut menu on a Mac).

- **Windows**: the update downloads while you work. Click **Restart to Update** in the top bar, or just quit, and it installs itself. No new installer to download.
- **Linux** (AppImage): the same as Windows. The AppImage is replaced with the new version when you restart.
- **macOS**: until release builds are signed with an Apple Developer ID, macOS does not let the app replace itself. Kificut downloads the right installer for your Mac, checks it, and opens it when you click **Install Update**; drag Kificut into Applications to finish.

Either way you do not lose work. While you edit, Kificut keeps a recovery copy of unsaved changes and brings them back after an update, without asking. If Kificut closes unexpectedly (a crash, a power cut), it offers to recover the work the next time it starts. The copy is removed when you save or choose **Don't Save**.

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

Build each installer on the operating system it targets, because the bundled FFmpeg binary is platform specific. The installer also includes ONNX Runtime's native library for its platform (from `onnxruntime-node`, 43 to 64 MB) for custom voices; `electron-builder.yml` leaves out the other platforms and the GPU providers, and `.npmrc` stops `npm install` from downloading CUDA libraries on Linux. Intel Mac builds have no custom voices, because onnxruntime-node has no build for them. To build for Intel Macs from an Apple Silicon machine, reinstall with `npm_config_arch=x64 npm ci` and run `npm run dist:mac -- --x64`.

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
| New recording                   | Ctrl+Shift+R (Cmd+Shift+R)                        |
| Pause or stop a recording       | Ctrl+Shift+1, Ctrl+Shift+2, in any app            |

The full list is under Help > Keyboard Shortcuts.

## Roadmap

These are not in yet. Help is welcome on any of them.

- Keyframes for transform, opacity and volume
- Transitions between neighbouring clips on the same track
- Audio effects such as EQ, compression and noise reduction
- Hardware encoders (NVENC, Quick Sync, VideoToolbox) without a custom FFmpeg build
- Subtitle import and export (SRT, VTT)
- Editing by transcript (select words to cut them)
- More voices and languages for voiceovers
- A ChatGPT connector
- Translations

## Contributing

Bug reports, ideas and pull requests are all welcome. [CONTRIBUTING.md](CONTRIBUTING.md) explains how to get set up and where things live.

## License

Kificut is released under the [MIT license](LICENSE).

Recordings are written with [Mediabunny](https://github.com/Vanilagy/mediabunny), used unmodified under the Mozilla Public License 2.0; its license is included with the app. The installers include FFmpeg and FFprobe builds published by the `ffmpeg-static` project. They run as separate programs and are distributed under their own license (GPL, since the builds include x264 and x265); a copy is included with the app and the source is available from [ffmpeg.org](https://ffmpeg.org). The Inter typeface is used under the SIL Open Font License.

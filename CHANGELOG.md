# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [semantic versioning](https://semver.org/).

## [Unreleased]

## [0.5.0]

Shapes, borders, shadows and effects for clips.

### Added

- Shapes: cut any clip to a rectangle with rounded corners, an oval, a circle, a heart, a star, a triangle, a diamond or a hexagon, with size, position, rotation, roundness, feather and invert
- Border and drop shadow for any clip, following its shape and transparency
- Effects that stack in any order: Blur, Sharpen, Pixelate, Glow, Vignette, Film Grain, RGB Split, Camera Shake, Black and White, Sepia, Invert, Hue Shift and Chroma Key with spill removal. The preview and the export use the same math
- Temperature and Tint in the Color section
- Clips with a shape or effects show fx on the timeline
- Tools for assistants: `update_clip` sets shapes, borders, shadows and effects, and `get_project` reports them

## [0.4.0]

Kificut for Linux, voiceovers in your own voice, screen and camera recording, and generated scenes and pictures.

### Added

- Linux release: an AppImage for x86_64 attached to each release, with in-app updates. It uses the static AppImage runtime, so it does not need libfuse2, and starts without Chromium's sandbox where the system blocks it
- The Linux AppImage adds itself to the applications menu with its icon and the .kificut file type, and keeps the entry pointing at the AppImage after updates. Wayland desktops need this before they allow screen recording and global shortcuts. Set `KIFICUT_NO_DESKTOP_INTEGRATION=1` to skip it
- Recording and custom voices on Linux: screen, camera and both on X11 and Wayland (where the desktop's own dialog picks the screen or window), in the AppImage
- Claude Code on Linux: the AppImage runs the connector itself with `--mcp-server`, and Kificut points Claude Code at the new file when an update or a move changes the AppImage's path
- My voices: voiceovers in your own voice, or a voice you have permission to use, from a recording of 10 to 20 seconds. Record in the Voice tab, use the selected clip or pick a file, confirm the voice may be used, and pick it for any script. Chatterbox Turbo (725 MB, MIT) runs on this computer in a background process with the native ONNX Runtime; nothing is trained or uploaded. Not available on Intel Macs yet
- Tools for assistants: `list_voices`, and `generate_voiceover` takes the user's own voices
- Generate scenes and pictures: the Generate tab in the media panel makes short video scenes and pictures from a description with Google (Gemini Omni Flash, Nano Banana), fal.ai (Wan, Kling, FLUX or any fal.ai model) or your own ComfyUI, optionally starting from the frame at the playhead or a picture. The expected cost is shown first, jobs run in the background and can be cancelled, and the result lands on a free track at the playhead. Set up in AI > Generation
- Tools for assistants: `generate_media`, which reports the cost and only spends money once the user agreed, and `list_generations`
- Recording: the screen, a camera, or both at once, from the red dot in the top bar, the start screen or Ctrl+Shift+R. Record a whole screen, a window or an area you drag out, at up to 4K or full resolution and 30 or 60 fps, with a microphone (level meter, noise reduction) and, on Windows, the computer's sound. A countdown, pause and resume, a floating control bar, a tray icon and global shortcuts (Ctrl+Shift+1 to pause, Ctrl+Shift+2 to stop). The screen and the camera are separate MP4 files in sync with each other; the recording is added to the timeline with the camera as a picture in picture over the screen, on free tracks and linked. Files are written while recording, and a recording cut short by a crash is saved at the next start

### Fixed

- `list_ai_models` named the transcription tools as the users of every model other than Kokoro

## [0.3.0]

More local AI models for editing: noise reduction, footage search and background removal.

### Added

- More models to install, each with a feature: RNNoise for Reduce Noise on dialogue, CLIP to search inside footage by description, and MODNet and ORMBG for Remove Background on pictures and on people in video
- Generate English Captions, which translates speech in other languages with Whisper
- Video with transparency (VP8 or VP9 WebM with alpha) previews and exports with its transparency
- Tools for assistants: `find_shots`, `reduce_noise` and `remove_background`, and `translate_to_english` on `transcribe_media` and `add_captions`

## [0.2.0]

AI features (all optional and off until you turn them on), Claude Code support, in-app updates and recovery of unsaved work.

### Added

- Claude connector: install it in Claude Desktop from Settings and let Claude import media, look at frames, find scene changes and silences, build the timeline, add titles and export. Every change is a normal undo step, and access can be turned off in Settings
- The connector is attached to each release as a `.mcpb` file
- AI models on this computer: install Kokoro for voiceovers and Whisper Base or Small for speech to text from the new AI window. Downloads are pinned and hash checked, and the models run offline
- Voice tab: type a script, pick one of 28 voices and add the voiceover at the playhead
- Generate Captions on any clip with speech, with automatic language detection
- Assistant tab: chat with an AI that edits the project, using your own key for Anthropic, OpenAI, Google Gemini or OpenRouter, or a local model through Ollama, LM Studio or any OpenAI compatible server. Keys are encrypted with the system key store
- New assistant tools: `generate_voiceover`, `transcribe_media` and `add_captions`, plus `list_ai_models` and `install_ai_model` so Claude or the Assistant can install a model when you ask. No model ships with the app
- Model downloads retry and resume when the connection drops or the network changes
- Claude Code support: Settings > Claude > Connect Claude Code adds Kificut to Claude Code, from the terminal or the VS Code, Cursor and Windsurf extensions
- In-app updates. On Windows they download in the background and install with Restart to Update; on macOS Kificut downloads the installer for your Mac and opens it
- Recovery of unsaved work after an update, a crash or a forced quit

## [0.1.0]

First public version.

### Added

- Multi-track timeline with linked audio and video, trimming, splitting, ripple delete, snapping, markers and in/out points
- Real-time preview on WebGL 2 with a 2D canvas fallback
- Transform, crop, flip, opacity and color controls, editable in the inspector or on the preview
- Titles with outline, background box and shadow
- Clip fades, volume, and speed changes
- Automatic preview copies for footage Chromium cannot play
- Export to MP4 (H.264, HEVC), WebM (VP9), ProRes 422, GIF, MP3 and WAV
- Autosave, recent projects and relinking of moved media

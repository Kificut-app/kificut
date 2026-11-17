# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [semantic versioning](https://semver.org/).

## [Unreleased]

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

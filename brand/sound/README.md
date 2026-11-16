# Kificut sound

The sound logo and theme music for Kificut. Both are generated from code in
[`scripts/brand-sound.mjs`](../../scripts/brand-sound.mjs), so they can be changed and rebuilt like the rest of the project.

| File                     | Length | Use                                         |
| ------------------------ | ------ | ------------------------------------------- |
| `kificut-sound-logo.wav` | 3.2 s  | Master of the sound logo, 24-bit 48 kHz     |
| `kificut-sound-logo.mp3` | 3.2 s  | Same, 320 kbps for the web and social posts |
| `kificut-theme.wav`      | 45 s   | Master of the theme, 24-bit 48 kHz          |
| `kificut-theme.mp3`      | 45 s   | Same, 320 kbps                              |

## The idea

The logo follows the name. "Ki" and "fi" are two quick notes, and "cut" lands on a third with a crisp snap,
like a pair of scissors closing, while a warm chord opens up behind it.

- Notes: A, D, E (in D major), ending on the ninth instead of the root so it sounds open rather than finished
- Rhythm: two sixteenth notes and a held note, at 110 BPM
- Chord under the cut: Dmaj9

The theme is built from the same pieces. The snap from the logo is the backbeat, the melody keeps returning to
the three-note motif (once in D, later in G), and the track ends on the exact sound logo.

| Section   | Bars  | What happens                                       |
| --------- | ----- | -------------------------------------------------- |
| Intro     | 1-2   | Pad swells in with a soft hint of the motif        |
| First     | 3-10  | Groove starts, melody states the motif             |
| Second    | 11-18 | Busier drums, arpeggios, melody moves up an octave |
| Breakdown | 19    | Drums drop out and a riser builds                  |
| Logo      | 20    | The sound logo, with its tail                      |

## Using it

- Put the sound logo at the start or end of product videos and tutorials, not both.
- Let it play in full. The tail is part of it; cutting it short makes the "cut" sound abrupt.
- Do not pitch shift, speed up or layer other sounds over the logo.
- The theme works as a bed under narration if you lower it by about 12 dB.
- Both files are mastered to -16 LUFS integrated with true peaks below -6 dBFS, so they sit at the same level as
  each other and as most podcast and streaming audio.

## Changing it

Everything lives in `scripts/brand-sound.mjs`: the instruments, the chord progression, the melody (written as bar,
beat, MIDI note and length) and the mix. After editing, rebuild with:

```sh
npm run brand:sound
```

The render is deterministic, so the same script always produces the same audio.

## License

The audio is part of the Kificut project and released under the same [MIT license](../../LICENSE).

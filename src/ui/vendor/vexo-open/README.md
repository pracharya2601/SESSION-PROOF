# vexo-open (vendored)

The Vexo Open band JavaScript library, copied unchanged from the kit's `js/src/`.

- Source: https://github.com/VexoAI-Org/vexo-open-kit (`js/src/`, all files incl. `transports/`)
- Commit: `1e4291e2fa4896b1f603d3d4f0b009c483425da0`, committed 2026-11-13
- Licence: MIT, see `LICENSE` (Copyright (c) 2026 Vexo AI)

**Do not edit these `.js` files.** To update, copy `js/src/` from a newer kit commit over this
folder and change the commit line above. `index.d.ts` is ours: it declares only the part of
the API the Field Assistant uses (see `src/ui/components/visit/`), so extend it when you use more.

`src/ui/public/sample-speech.opus` comes from the same commit (`dashboard/speech/sample-speech.opus`,
a public-domain LibriVox reading). It gives the pretend band a voice.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`photoprint.js` is a single-file, dependency-free Node.js terminal UI (TUI) for batch-printing photos on macOS. It packs multiple images onto a single sheet of photo paper, scaling each to a fixed longer-edge dimension, then sends the composite to a CUPS printer via `lp`. There is no `package.json`, no build step, and no test suite — the whole program is `photoprint.js`.

## Running

```bash
cd <directory-of-images>   # operates on images in the CURRENT WORKING DIRECTORY
photoprint                 # if symlinked onto PATH
# or
node /path/to/photoprint.js
```

The tool reads all images (`tiff/jpg/png/heic/heif/webp`) in `process.cwd()`, not from an argument. It runs an interactive `setup()` (printer, per-image longer dimension, paper size, media type, tray) then enters the TUI.

## Hard platform dependencies

The script shells out to macOS/CUPS/ImageMagick binaries via `execSync` (see `run()`). All must be present:
- **ImageMagick** (`magick`) — resizing/compositing. Checked at startup; `brew install imagemagick` if missing.
- **`sips`** — reads pixel dimensions (`getDims`). macOS built-in.
- **`xattr`** — reads Finder color tags from `com.apple.metadata:_kMDItemUserTags` (`finderTag`). macOS built-in.
- **CUPS** (`lpstat`, `lpoptions`, `lp`) — printer discovery and printing.
- **`open`** — opens the JPEG preview before a manual print.

This is macOS-only by construction. Don't add cross-platform shims unless asked.

## Architecture

The program is two distinct input modes that swap how stdin is read:

1. **Setup** (`setup()`) — interactive selection inputs (using arrow keys/`j`/`k` in raw mode) and line-based questions. Discovers printers (`getPrinters`) and their CUPS option values (`getPrinterVals` parses `lpoptions -p <printer> -l`). Returns a config object.
2. **TUI / selection loop** (`selectionLoop`) — raw-mode stdin (`enterRaw`/`exitRaw` toggle `setRawMode` + alternate screen buffer `\x1b[?1049h`). Reads single keypresses (`readKey`) including arrow-key escape sequences, mutates `state`, and re-renders.

`render(state)` builds the entire frame as one string and writes it in a single `out()` call (full clear + redraw each frame — no diffing). Layout reserves `HDR` (5) header lines and `FTR` (3) footer lines; the middle scrolls via `state.scrollOffset`.

### Central state object
Built in `main()`: `{ dir, images[], cursor, scrollOffset, ...cfg }`. Each image is `{ name, path, w, h, tag, selected, printed }`. `selected`/`printed` drive both rendering glyphs and fit logic.

### The fit model (core domain logic)
Images are stacked vertically on the sheet. Each image's printed height is derived from the configured `longerDim` and the image's aspect ratio (`printH`). Portrait images are rotated -90° at composite time so their longer edge runs along the configured dimension.
- `spaceUsed(imgs, longerDim)` = sum of printed heights + `MIN_GAP` (0.15") between/around each.
- `wouldFit(img, selected, longerDim, paperH)` gates whether an image can be added. Selection (`SPACE`), the `R` red-tag batch, and `autoMode` all respect it. Images that won't fit render grayed out.

### Composite + print pipeline
`buildComposite()` resizes each image to `longerDim * DPI` (300) into temp TIFFs, then `magick`-composites them centered with an evenly distributed gap onto a white sheet. `doPrint()` builds the composite, (manual mode) renders a 900px JPEG preview and `open`s it for y/n confirmation, then `lp -d <printer> -o PageSize=... -o InputSlot=... -o MediaType=... -o scaling=100`. On success it marks each image `printed = true`. `autoMode()` greedily packs unprinted images into successive full sheets and prints each without preview.

## Conventions when editing

- Keep it a single zero-dependency file. No npm packages, no `package.json` unless explicitly requested.
- ANSI codes live in the `A` map; tag colors in `TAG_DOT`; paper presets in `PAPER`; CUPS→friendly media names in `MEDIA_LABEL`. Add to these tables rather than scattering literals.
- All external commands go through `run()` so errors surface as thrown `Error(stderr)`. File paths are interpolated into shell strings wrapped in double quotes — preserve that quoting.
- Raw mode and the alternate screen MUST be restored on every exit path. Restoration is wired through `exitRaw()`, the `process.on('exit')` handler, and the `uncaughtException`/`main().catch` handlers. Any new early-exit must not bypass these.

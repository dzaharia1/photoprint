# PhotoPrint

A dependency-free Node.js terminal UI (TUI) for batch-printing photos on macOS. It packs multiple images onto a single sheet of photo paper, scaling each to a fixed longer-edge dimension, and sends the composite to a CUPS printer.

---

## Prerequisites

PhotoPrint is designed specifically for macOS and relies on some built-in systems as well as ImageMagick. Before installing, ensure you have the following:

1. **macOS**: This tool is macOS-only as it utilizes system utilities like `sips`, `xattr`, and `open`.
2. **Node.js**: Verify with `node -v` (version 14 or higher is recommended).
3. **ImageMagick**: Required for image resizing and compositing. Install it via Homebrew:
   ```bash
   brew install imagemagick
   ```

---

## Option 1: Direct Installation (Recommended)

To install the script locally as a standalone command line tool:

1. **Download the script** and save it in a folder in your `$PATH` (e.g., `/usr/local/bin`):
   ```bash
   sudo curl -L https://raw.githubusercontent.com/dzaharia1/photoprint/main/photoprint.js -o /usr/local/bin/photoprint
   ```
   *Note: If you prefer not to use `sudo`, you can download it to `~/bin` or another user-writable directory in your shell PATH.*

2. **Make it executable**:
   ```bash
   sudo chmod +x /usr/local/bin/photoprint
   ```

3. **Run it**:
   ```bash
   cd /path/to/your/images
   photoprint
   ```

---

## Option 2: Running via `curl` (No Installation)

You can run the script directly from GitHub without installing it. Because the script is interactive and requires full access to your terminal input (TTY), traditional piping (`curl ... | node`) will **not** work. Instead, use process substitution:

```bash
node <(curl -sL https://raw.githubusercontent.com/dzaharia1/photoprint/main/photoprint.js)
```

### Adding a Shell Alias

If you want the ease of a simple command but always want to run the latest version directly from GitHub, you can define an alias.

1. **Open your shell profile** (usually `~/.zshrc` on modern macOS):
   ```bash
   nano ~/.zshrc
   ```

2. **Add the alias definition** at the bottom of the file:
   ```bash
   alias photoprint="node <(curl -sL https://raw.githubusercontent.com/dzaharia1/photoprint/main/photoprint.js)"
   ```

3. **Save and exit** (`Ctrl+O`, `Enter`, then `Ctrl+X`).

4. **Reload your shell profile** to apply the changes:
   ```bash
   source ~/.zshrc
   ```

Now, typing `photoprint` in any directory will instantly download and run the latest script.

---

## Usage

1. Open your terminal and navigate to the directory containing your images:
   ```bash
   cd ~/Pictures/ToPrint
   ```
2. Run the `photoprint` command.
3. Complete the interactive **Setup** (select a printer, set image size, choose paper dimensions, slot/tray, and media type).
4. Use the **Terminal UI** (TUI) to select and lay out your photos:
   * **`[↑ / ↓]` or `[j / k]`**: Navigate through the image list.
   * **`[SPACE]`**: Select/deselect an image (the UI will prevent selecting more images than will fit on a single page).
   * **`[R]`**: Select all Red-tagged images (uses Finder tags).
   * **`[P]` or `[ENTER]`**: Print the current batch. Shows a preview first.
   * **`[A]`**: Auto-batch all remaining images onto consecutive pages.
   * **`[Q]`**: Quit.

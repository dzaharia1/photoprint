#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const readline = require('readline');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ─── ANSI ─────────────────────────────────────────────────────────────────────
const A = {
  reset:   '\x1b[0m',  bold:    '\x1b[1m',
  dim:     '\x1b[2m',  strike:  '\x1b[9m',
  altOn:   '\x1b[?1049h', altOff: '\x1b[?1049l',
  hideC:   '\x1b[?25l',   showC:  '\x1b[?25h',
  clr:     '\x1b[2J\x1b[H',
  red:     '\x1b[31m', green:  '\x1b[32m',
  yellow:  '\x1b[33m', blue:   '\x1b[34m',
  magenta: '\x1b[35m', cyan:   '\x1b[36m',
  gray:    '\x1b[90m', orange: '\x1b[38;5;208m',
};

const TW = () => process.stdout.columns || 100;
const TH = () => process.stdout.rows    || 30;
const out = s => process.stdout.write(s);
const trunc = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;

const TAG_DOT = {
  Red:    `${A.red}●${A.reset}`,
  Orange: `${A.orange}●${A.reset}`,
  Yellow: `${A.yellow}●${A.reset}`,
  Green:  `${A.green}●${A.reset}`,
  Blue:   `${A.blue}●${A.reset}`,
  Purple: `${A.magenta}●${A.reset}`,
  Gray:   `${A.dim}●${A.reset}`,
};

// ─── Shell ────────────────────────────────────────────────────────────────────
function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
  } catch(e) { throw new Error(e.stderr?.trim() || e.message); }
}

// ─── File system ──────────────────────────────────────────────────────────────
const IMG_EXTS = /\.(tiff?|jpe?g|png|heic|heif|webp)$/i;

function finderTag(fp) {
  try {
    const x = run(`xattr -p com.apple.metadata:_kMDItemUserTags "${fp}"`);
    return Object.keys(TAG_DOT).find(t => x.includes(t)) || null;
  } catch { return null; }
}

function getDims(fp) {
  const o = run(`sips -g pixelWidth -g pixelHeight "${fp}"`);
  return {
    w: parseInt(o.match(/pixelWidth:\s*(\d+)/)[1]),
    h: parseInt(o.match(/pixelHeight:\s*(\d+)/)[1]),
  };
}

function loadImages(dir) {
  const files = fs.readdirSync(dir)
    .filter(f => IMG_EXTS.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

  process.stdout.write(`  Reading ${files.length} image(s)`);
  const images = files.map(name => {
    process.stdout.write('.');
    const fp = path.join(dir, name);
    const { w, h } = getDims(fp);
    const tag = finderTag(fp);
    return { name, path: fp, w, h, tag, selected: false, printed: false };
  });
  console.log(' done.');
  return images;
}

// ─── Printers ─────────────────────────────────────────────────────────────────
function getPrinters() {
  try {
    return run('lpstat -p').split('\n')
      .filter(l => l.startsWith('printer '))
      .map(l => l.split(' ')[1]);
  } catch { return []; }
}

function getPrinterVals(printer, key) {
  try {
    const o = run(`lpoptions -p "${printer}" -l`);
    const line = o.split('\n').find(l => l.startsWith(key + '/') || l.startsWith(key + ':'));
    if (!line) return [];
    return line.split(':')[1].trim().split(/\s+/).map(v => v.replace(/^\*/, ''));
  } catch { return []; }
}

// ─── Layout ───────────────────────────────────────────────────────────────────
const DPI     = 300;
const MIN_GAP = 0.15;

const PAPER = [
  { label: '4 x 6"',    w: 4,   h: 6,  cups: 'Custom.288x432'  },
  { label: '5 x 7"',    w: 5,   h: 7,  cups: 'Custom.360x504'  },
  { label: '8 x 10"',   w: 8,   h: 10, cups: 'Custom.576x720'  },
  { label: '8.5 x 11"', w: 8.5, h: 11, cups: 'Letter'          },
  { label: '11 x 14"',  w: 11,  h: 14, cups: 'Custom.792x1008' },
  { label: '13 x 19"',  w: 13,  h: 19, cups: 'Custom.936x1368' },
  { label: 'Custom',    w: 0,   h: 0,  cups: ''                },
];

const MEDIA_LABEL = {
  photographic: 'Photo Glossy/Lustre',
  stationery:   'Matte',
  envelope:     'Envelope',
  any:          'Auto',
};

function printH(img, longerDim) {
  const [l, s] = img.w >= img.h ? [img.w, img.h] : [img.h, img.w];
  return longerDim * (s / l);
}

function spaceUsed(imgs, longerDim) {
  if (!imgs.length) return 0;
  return imgs.reduce((s, i) => s + printH(i, longerDim), 0) + (imgs.length + 1) * MIN_GAP;
}

function wouldFit(img, selected, longerDim, paperH) {
  return spaceUsed([...selected, img], longerDim) <= paperH;
}

// ─── Composite builder ────────────────────────────────────────────────────────
function buildComposite(images, cfg, outPath) {
  const { longerDim, paperW, paperH } = cfg;
  const pw = Math.round(paperW * DPI);
  const ph = Math.round(paperH * DPI);
  const tmps = [], adims = [];

  for (const img of images) {
    const rotate = img.h > img.w ? '-rotate -90' : '';
    const tw  = Math.round(longerDim * DPI);
    const tmp = path.join(os.tmpdir(), `pp_${Date.now()}_${Math.random().toString(36).slice(2)}.tiff`);
    run(`magick "${img.path}" -auto-orient ${rotate} -resize ${tw}x -units PixelsPerInch -density ${DPI} "${tmp}"`);
    const d = run(`magick identify -format "%wx%h" "${tmp}"`).split('x').map(Number);
    tmps.push(tmp);
    adims.push({ w: d[0], h: d[1] });
  }

  const totalH = adims.reduce((s, d) => s + d.h, 0);
  const gap    = Math.floor((ph - totalH) / (images.length + 1));

  let cmd = `magick -size ${pw}x${ph} xc:white -units PixelsPerInch -density ${DPI}`;
  let y = gap;
  for (let i = 0; i < tmps.length; i++) {
    const x = Math.round((pw - adims[i].w) / 2);
    cmd += ` "${tmps[i]}" -geometry +${x}+${y} -composite`;
    y += adims[i].h + gap;
  }
  cmd += ` "${outPath}"`;
  run(cmd);
  tmps.forEach(f => { try { fs.unlinkSync(f); } catch {} });
}

// ─── Print ────────────────────────────────────────────────────────────────────
async function doPrint(batch, cfg, auto) {
  const outTiff = path.join(os.tmpdir(), `photoprint_${Date.now()}.tiff`);
  const prevJpg = outTiff.replace('.tiff', '_prev.jpg');

  process.stdout.write(`\nBuilding composite for ${batch.length} image(s)...`);
  buildComposite(batch, cfg, outTiff);
  console.log(' done.');

  if (!auto) {
    run(`magick "${outTiff}" -resize 900x "${prevJpg}"`);
    run(`open "${prevJpg}"`);
    console.log('Preview opened.\n');
    const ans = await ask('Print? [y/n] > ');
    if (!ans.toLowerCase().startsWith('y')) return false;
  }

  const res = run(
    `lp -d "${cfg.printer}" -o PageSize=${cfg.cupsPaperSize} -o InputSlot=${cfg.inputSlot} -o MediaType=${cfg.mediaType} -o scaling=100 "${outTiff}"`
  );
  console.log(`Sent -- ${res}`);
  batch.forEach(img => { img.printed = true; img.selected = false; });
  if (!auto) await new Promise(r => setTimeout(r, 1000));
  return true;
}

// ─── Render ───────────────────────────────────────────────────────────────────
const HDR = 5;
const FTR = 3;

function render(state) {
  const w = TW(), h = TH();
  const listH    = h - HDR - FTR;
  const sel      = state.images.filter(i => i.selected);
  const used     = spaceUsed(sel, state.longerDim);
  const pct      = Math.min(1, used / state.paperH);
  const left     = Math.max(0, state.paperH - used);
  const unprinted = state.images.filter(i => !i.printed).length;
  const maxNameLen = state.images.length ? Math.max(...state.images.map(i => i.name.replace(/\.[^.]+$/, '').length)) : 15;
  const nameW      = Math.max(12, Math.min(maxNameLen, w - 40));

  let s = A.clr;

  // Line 1: title
  s += `${A.bold}${A.cyan} PhotoPrint${A.reset}  ${A.gray}${path.basename(state.dir)}${A.reset}\n`;

  // Line 2: config
  const cfgLine = [
    `${state.longerDim}" per image`,
    `paper ${state.paperW}x${state.paperH}"`,
    `tray: ${state.inputSlot}`,
    `media: ${MEDIA_LABEL[state.mediaType] || state.mediaType}`,
    state.printer,
  ].join('  |  ');
  s += ` ${A.gray}${cfgLine}${A.reset}\n`;

  // Line 3: space bar
  const barW   = Math.max(10, w - 32);
  const fill   = Math.round(pct * barW);
  const barCol = pct > 0.95 ? A.red : pct > 0.75 ? A.yellow : A.green;
  s += ` ${barCol}${'#'.repeat(fill)}${A.gray}${'-'.repeat(barW - fill)}${A.reset}`;
  s += `  ${A.bold}${used.toFixed(2)}"${A.reset} used  ${A.gray}${left.toFixed(2)}" left${A.reset}\n`;

  // Line 5: counts
  s += ` ${A.gray}${sel.length} selected  |  ${unprinted} unprinted  |  ${state.images.length} total${A.reset}\n`;

  // Line 6: separator
  s += ` ${A.gray}${'-'.repeat(w - 2)}${A.reset}\n`;

  // Image list
  const visible = state.images.slice(state.scrollOffset, state.scrollOffset + listH);

  for (let vi = 0; vi < listH; vi++) {
    const img = visible[vi];
    if (!img) { s += '\n'; continue; }

    const ai       = state.scrollOffset + vi;
    const isCursor = ai === state.cursor;
    const isGrayed = !img.selected && !img.printed &&
                     !wouldFit(img, sel, state.longerDim, state.paperH);

    // Selection glyph
    let glyph;
    if      (img.selected && img.printed) glyph = `${A.yellow}[*]${A.reset}`;
    else if (img.selected)                glyph = `${A.green}${A.bold}[+]${A.reset}`;
    else if (img.printed)                 glyph = `${A.gray}[p]${A.reset}`;
    else                                  glyph = `${A.gray}[ ]${A.reset}`;

    const dot     = img.tag ? ` ${TAG_DOT[img.tag]}` : '  ';
    const ph      = printH(img, state.longerDim);
    const dim     = `${state.longerDim.toFixed(1)}x${ph.toFixed(2)}"`;
    const base    = img.name.replace(/\.[^.]+$/, '');
    const nameStr = trunc(base, nameW).padEnd(nameW);

    const leftLen = 9 + nameW + dim.length;
    const rightStr = img.printed ? 'printed' : '';
    const rightLen = rightStr.length;
    const padLen = Math.max(1, (w - 2) - leftLen - rightLen);
    const pad = ' '.repeat(padLen);

    let row;
    if (isGrayed) {
      row = `${A.gray} ${glyph}${dot} ${nameStr} ${dim}${pad}${rightStr}${A.reset}`;
    } else if (img.printed && !img.selected) {
      row = ` ${glyph}${dot} ${A.dim}${nameStr}${A.reset} ${A.gray}${dim}${pad}${rightStr}${A.reset}`;
    } else {
      const nc = img.selected ? `${A.green}${A.bold}` : '';
      const rc = img.printed ? `${A.gray}printed${A.reset}` : '';
      row = ` ${glyph}${dot} ${nc}${nameStr}${A.reset} ${A.gray}${dim}${pad}${rc}${A.reset}`;
    }

    const cur = isCursor ? `${A.cyan}>${A.reset}` : ' ';
    let line = cur + row;
    if (isCursor) {
      const bgStyle = '\x1b[7m'; // reverse video highlight
      line = bgStyle + line.split(A.reset).join(A.reset + bgStyle) + A.reset;
    }
    s += line + '\n';
  }

  // Footer (3 lines)
  s += ` ${A.gray}${'-'.repeat(w - 2)}${A.reset}\n`;

  // Controls reference
  const keys = [
    `${A.reset}[↑↓]${A.gray} navigate`,
    `${A.reset}[SPACE]${A.gray} select/deselect`,
    `${A.reset}[R]${A.gray} select all red`,
    `${A.reset}[P]${A.gray} print selection`,
    `${A.reset}[A]${A.gray} auto-batch all`,
    `${A.reset}[Q]${A.gray} quit`,
  ].join(`  ${A.reset}`);
  s += ` ${A.gray}${keys}${A.reset}\n`;

  // Action line
  const unprintedUnsel = state.images.filter(i => !i.selected && !i.printed);
  const pageFull = sel.length > 0 && unprintedUnsel.length > 0 &&
    unprintedUnsel.every(i => !wouldFit(i, sel, state.longerDim, state.paperH));

  if (pageFull)
    s += ` ${A.orange}${A.bold}Page full — no more images will fit. Press P to print.${A.reset}`;
  else if (sel.length > 0)
    s += ` ${A.green}${A.bold}[P]${A.reset} Print ${sel.length} image${sel.length !== 1 ? 's' : ''}`;
  else
    s += ` ${A.gray}No images selected — SPACE to select, R to select all red-tagged${A.reset}`;

  out(s);
}

// ─── Raw mode helpers ─────────────────────────────────────────────────────────
function enterRaw() {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  out(A.altOn + A.hideC);
}

function exitRaw() {
  process.stdin.setRawMode(false);
  process.stdin.pause();
  out(A.altOff + A.showC);
}

function readKey() {
  return new Promise(resolve => process.stdin.once('data', resolve));
}

function ask(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, ans => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

async function choose(prompt, opts) {
  console.log(`\n${prompt}`);
  let selected = 0;

  const renderOpts = () => {
    let s = '';
    for (let i = 0; i < opts.length; i++) {
      const isSel = i === selected;
      const prefix = isSel ? `${A.cyan}>${A.reset} ` : '  ';
      const label = isSel ? `${A.bold}${opts[i].label}${A.reset}` : `${A.gray}${opts[i].label}${A.reset}`;
      s += `${prefix}${label}\n`;
    }
    out(s);
  };

  renderOpts();

  const wasRaw = process.stdin.isRaw;
  if (!wasRaw) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
  }
  out(A.hideC);

  try {
    while (true) {
      const key = await readKey();
      if (key === '\x03') { // Ctrl+C
        out(A.showC);
        if (!wasRaw) {
          process.stdin.setRawMode(false);
          process.stdin.pause();
        }
        process.exit(0);
      }
      if (key === '\r' || key === '\n') {
        break;
      }
      if (key === '\x1b[A' || key === 'k') { // Up
        selected = (selected - 1 + opts.length) % opts.length;
      } else if (key === '\x1b[B' || key === 'j') { // Down
        selected = (selected + 1) % opts.length;
      }

      out(`\x1b[${opts.length}A\r\x1b[J`);
      renderOpts();
    }
  } finally {
    out(A.showC);
    if (!wasRaw) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  }
  return opts[selected];
}

// ─── Auto mode ────────────────────────────────────────────────────────────────
async function autoMode(state) {
  while (true) {
    const unprinted = state.images.filter(i => !i.printed);
    if (!unprinted.length) break;

    state.images.forEach(i => { i.selected = false; });
    for (const img of unprinted) {
      const sel = state.images.filter(i => i.selected);
      if (wouldFit(img, sel, state.longerDim, state.paperH)) img.selected = true;
      else break;
    }

    const batch = state.images.filter(i => i.selected);
    if (!batch.length) break;

    console.log(`\n-- Auto batch: ${batch.length} image(s)  |  ${unprinted.length} unprinted remaining --`);
    await doPrint(batch, state, true);
  }

  const stillLeft = state.images.filter(i => !i.printed).length;
  if (stillLeft)
    console.log(`\n${stillLeft} image(s) could not fit on a single page -- use manual mode.`);
  else
    console.log('\nAll images printed.');
  await new Promise(r => setTimeout(r, 1500));
}

// ─── Selection loop ───────────────────────────────────────────────────────────
async function selectionLoop(state) {
  enterRaw();
  render(state);

  const listH = () => TH() - HDR - FTR;

  while (true) {
    const key = await readKey();
    const sel = () => state.images.filter(i => i.selected);

    if (key === '\x03' || key === 'q' || key === 'Q') {
      exitRaw(); return;
    }

    if (key === '\x1b[A' || key === 'k') {
      if (state.cursor > 0) {
        state.cursor--;
        if (state.cursor < state.scrollOffset) state.scrollOffset = state.cursor;
      }
    } else if (key === '\x1b[B' || key === 'j') {
      if (state.cursor < state.images.length - 1) {
        state.cursor++;
        const lh = listH();
        if (state.cursor >= state.scrollOffset + lh) state.scrollOffset = state.cursor - lh + 1;
      }
    } else if (key === ' ') {
      const img = state.images[state.cursor];
      if (img.selected) {
        img.selected = false;
      } else if (img.printed || wouldFit(img, sel(), state.longerDim, state.paperH)) {
        img.selected = true;
      }
    } else if (key === 'r' || key === 'R') {
      // Select all red-tagged images that fit, in order; deselect all if already all selected
      const redImgs = state.images.filter(i => i.tag === 'Red' && !i.printed);
      const allRedSelected = redImgs.length > 0 && redImgs.every(i => i.selected);
      state.images.forEach(i => { i.selected = false; });
      if (!allRedSelected) {
        for (const img of redImgs) {
          const cur = state.images.filter(i => i.selected);
          if (wouldFit(img, cur, state.longerDim, state.paperH)) img.selected = true;
        }
      }

    } else if (key === 'p' || key === 'P' || key === '\r') {
      const batch = sel();
      if (batch.length) {
        exitRaw();
        console.clear();
        await doPrint(batch, state, false);
        enterRaw();
      }
    } else if (key === 'a' || key === 'A') {
      exitRaw();
      console.clear();
      await autoMode(state);
      enterRaw();
    }

    render(state);
  }
}

// ─── Setup (interactive selection mode) ───────────────────────────────────────
async function setup() {
  console.log('\nPhotoprint  --  interactive photo printing\n');

  // Printer
  const printers = getPrinters();
  if (!printers.length) { throw new Error('No printers found.'); }
  let printer;
  if (printers.length === 1) {
    printer = printers[0];
    console.log(`Printer: ${printer}`);
  } else {
    printer = (await choose('Select printer:', printers.map(l => ({ label: l })))).label;
  }

  // Longer dimension
  const dimIn = await ask('\nLonger dimension per image in inches [8]: ');
  const longerDim = parseFloat(dimIn) || 8;

  // Paper size
  const pc = await choose('Paper size:', PAPER.map(p => ({ label: p.label, ...p })));
  let paperW = pc.w, paperH = pc.h, cupsPaperSize = pc.cups;
  if (!paperW) {
    paperW = parseFloat(await ask('Paper width (inches): '));
    paperH = parseFloat(await ask('Paper height (inches): '));
    cupsPaperSize = `Custom.${Math.round(paperW * 72)}x${Math.round(paperH * 72)}`;
  }

  // Paper type
  const mediaTypes = getPrinterVals(printer, 'MediaType');
  const mediaOpts  = [
    ...mediaTypes.map(m => ({ label: MEDIA_LABEL[m] || m, value: m })),
    { label: 'Custom', value: '__custom__' },
  ];
  const mc = await choose('Paper type:', mediaOpts);
  const mediaType = mc.value === '__custom__' ? await ask('CUPS MediaType: ') : mc.value;

  // Tray
  const slots = getPrinterVals(printer, 'InputSlot');
  let inputSlot = 'auto';
  if (slots.length > 1) {
    inputSlot = (await choose('Paper tray:', slots.map(s => ({ label: s, value: s })))).value;
  }

  return { printer, longerDim, paperW, paperH, cupsPaperSize, mediaType, inputSlot };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const dir = process.cwd();

  try { run('which magick'); } catch {
    console.error('ImageMagick not found. Run: brew install imagemagick');
    process.exit(1);
  }

  const cfg    = await setup();
  console.log();
  const images = loadImages(dir);
  if (!images.length) { console.log('No images found.'); process.exit(0); }

  const state = { dir, images, cursor: 0, scrollOffset: 0, ...cfg };

  process.stdout.on('resize', () => render(state));
  process.on('exit', () => out(A.altOff + A.showC));
  process.on('uncaughtException', err => {
    out(A.altOff + A.showC);
    console.error(err);
    process.exit(1);
  });

  await selectionLoop(state);
  process.exit(0);
}

main().catch(err => {
  out(A.altOff + A.showC);
  console.error('\nError:', err.message);
  process.exit(1);
});

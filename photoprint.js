#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const readline = require('readline');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ─── helpers ──────────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
process.on('SIGINT', () => { console.log('\nAborted.'); rl.close(); process.exit(0); });

function ask(prompt) {
  return new Promise(resolve => rl.question(prompt, a => resolve(a.trim())));
}

async function choose(prompt, options) {
  console.log(`\n${prompt}`);
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o.label}`));
  while (true) {
    const a = await ask(`  › `);
    const n = parseInt(a);
    if (n >= 1 && n <= options.length) return options[n - 1];
    console.log(`  Please enter 1–${options.length}.`);
  }
}

async function confirm(prompt) {
  const a = await ask(`${prompt} [y/n] › `);
  return a.toLowerCase().startsWith('y');
}

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    throw new Error(e.stderr?.trim() || e.message);
  }
}

// ─── image utilities ──────────────────────────────────────────────────────────

function findRedTaggedImages(dir) {
  const exts = /\.(tiff?|jpe?g|png|heic|heif|webp)$/i;
  return fs.readdirSync(dir)
    .filter(f => exts.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    .filter(f => {
      try {
        const x = run(`xattr -p com.apple.metadata:_kMDItemUserTags "${path.join(dir, f)}"`);
        return x.includes('Red');
      } catch { return false; }
    });
}

function getDims(filepath) {
  const out = run(`sips -g pixelWidth -g pixelHeight "${filepath}"`);
  const w = parseInt(out.match(/pixelWidth:\s*(\d+)/)[1]);
  const h = parseInt(out.match(/pixelHeight:\s*(\d+)/)[1]);
  return { w, h };
}

// Always returns landscape print dims; needsRotate=true if original is portrait
function calcPrintDims(imgW, imgH, longerDim) {
  const landscape = imgW >= imgH;
  const [lPx, sPx] = landscape ? [imgW, imgH] : [imgH, imgW];
  return {
    printW: longerDim,
    printH: longerDim * (sPx / lPx),
    needsRotate: !landscape,
  };
}

// ─── layout ───────────────────────────────────────────────────────────────────

const DPI = 300;
const MIN_GAP_IN = 0.15; // minimum gap between images, in inches

const PAPER_PRESETS = [
  { label: '4 × 6"',    w: 4,   h: 6,   cups: 'Custom.288x432'  },
  { label: '5 × 7"',    w: 5,   h: 7,   cups: 'Custom.360x504'  },
  { label: '8 × 10"',   w: 8,   h: 10,  cups: 'Custom.576x720'  },
  { label: '8.5 × 11"', w: 8.5, h: 11,  cups: 'Letter'          },
  { label: '11 × 14"',  w: 11,  h: 14,  cups: 'Custom.792x1008' },
  { label: '13 × 19"',  w: 13,  h: 19,  cups: 'Custom.936x1368' },
  { label: 'Custom…',   w: 0,   h: 0,   cups: ''                 },
];

// How many images from `images` (starting at index 0) fit on one page
function calcBatchSize(images, longerDim, paperW, paperH) {
  let totalH = 0;
  let count = 0;
  for (const img of images) {
    const { printW, printH } = calcPrintDims(img.w, img.h, longerDim);
    if (printW > paperW) {
      console.log(`  Warning: "${img.name}" at ${longerDim}" wide exceeds paper width (${paperW}"). Skipping.`);
      continue;
    }
    // n images need n+1 gaps (top, between each, bottom)
    const wouldFit = totalH + printH + (count + 2) * MIN_GAP_IN <= paperH;
    if (!wouldFit) break;
    totalH += printH;
    count++;
  }
  return count;
}

function buildComposite(batch, longerDim, paperW, paperH, outPath) {
  const pageWpx = Math.round(paperW * DPI);
  const pageHpx = Math.round(paperH * DPI);
  const tmpFiles = [];
  const actualDims = [];

  // Resize each image to final print size
  for (const img of batch) {
    const { needsRotate } = calcPrintDims(img.w, img.h, longerDim);
    const targetWpx = Math.round(longerDim * DPI);
    const tmp = path.join(os.tmpdir(), `pp_${Date.now()}_${Math.random().toString(36).slice(2)}.tiff`);
    const rotate = needsRotate ? '-rotate -90' : '';
    run(`magick "${img.path}" -auto-orient ${rotate} -resize ${targetWpx}x -units PixelsPerInch -density ${DPI} "${tmp}"`);
    const dims = run(`magick identify -format "%wx%h" "${tmp}"`);
    const [pw, ph] = dims.split('x').map(Number);
    tmpFiles.push(tmp);
    actualDims.push({ pw, ph });
  }

  // Even spacing: (n+1) equal gaps across full page height
  const totalImgHpx = actualDims.reduce((s, d) => s + d.ph, 0);
  const spacingPx = Math.floor((pageHpx - totalImgHpx) / (batch.length + 1));

  // Build composite command
  let cmd = `magick -size ${pageWpx}x${pageHpx} xc:white -units PixelsPerInch -density ${DPI}`;
  let y = spacingPx;
  for (let i = 0; i < tmpFiles.length; i++) {
    const x = Math.round((pageWpx - actualDims[i].pw) / 2);
    cmd += ` "${tmpFiles[i]}" -geometry +${x}+${y} -composite`;
    y += actualDims[i].ph + spacingPx;
  }
  cmd += ` "${outPath}"`;
  run(cmd);

  tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch {} });
}

// ─── printer helpers ──────────────────────────────────────────────────────────

function getPrinters() {
  try {
    return run('lpstat -p')
      .split('\n')
      .filter(l => l.startsWith('printer '))
      .map(l => l.split(' ')[1]);
  } catch { return []; }
}

function getPrinterOptValues(printer, key) {
  try {
    const out = run(`lpoptions -p "${printer}" -l`);
    const line = out.split('\n').find(l => l.startsWith(key + '/') || l.startsWith(key + ':'));
    if (!line) return [];
    return line.split(':')[1].trim().split(/\s+/).map(v => v.replace(/^\*/, ''));
  } catch { return []; }
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const dir = process.cwd();
  console.log(`\nPhotoprint — scanning ${path.basename(dir)} for red-tagged images…`);

  // Find images
  const filenames = findRedTaggedImages(dir);
  if (!filenames.length) {
    console.log('No red-tagged images found. Tag images with a red label in Finder first.');
    rl.close(); return;
  }
  console.log(`Found ${filenames.length} red-tagged image(s).`);

  // Pre-read all dimensions
  process.stdout.write('Reading dimensions');
  const images = filenames.map(name => {
    process.stdout.write('.');
    const fp = path.join(dir, name);
    const { w, h } = getDims(fp);
    return { name, path: fp, w, h };
  });
  console.log(' done.\n');

  // Printer selection
  const printers = getPrinters();
  if (!printers.length) {
    console.log('No printers found. Make sure your printer is connected and enabled.');
    rl.close(); return;
  }
  let printer;
  if (printers.length === 1) {
    printer = printers[0];
    console.log(`Printer: ${printer}`);
  } else {
    const p = await choose('Select printer:', printers.map(label => ({ label })));
    printer = p.label;
  }

  // Longer dimension
  const dimIn = await ask('\nLonger dimension per image in inches [8]: ');
  const longerDim = parseFloat(dimIn) || 8;

  // Paper size
  const paperChoice = await choose('Paper size:', PAPER_PRESETS.map(p => ({ label: p.label, ...p })));
  let paperW = paperChoice.w, paperH = paperChoice.h, cupsPaperSize = paperChoice.cups;
  if (!paperW) {
    paperW = parseFloat(await ask('Paper width (inches): '));
    paperH = parseFloat(await ask('Paper height (inches): '));
    cupsPaperSize = `Custom.${Math.round(paperW * 72)}x${Math.round(paperH * 72)}`;
  }

  // Paper type
  const mediaTypes = getPrinterOptValues(printer, 'MediaType');
  const mediaLabels = { photographic: 'Photo Glossy/Lustre', stationery: 'Matte', envelope: 'Envelope', any: 'Auto' };
  const mediaOptions = [
    ...mediaTypes.map(m => ({ label: mediaLabels[m] || m, value: m })),
    { label: 'Custom…', value: '__custom__' },
  ];
  const mediaChoice = await choose('Paper type:', mediaOptions);
  const mediaType = mediaChoice.value === '__custom__'
    ? await ask('CUPS MediaType value: ')
    : mediaChoice.value;

  // Input slot
  const slots = getPrinterOptValues(printer, 'InputSlot');
  let inputSlot = 'auto';
  if (slots.length > 1) {
    const slotChoice = await choose('Paper tray:', slots.map(s => ({ label: s, value: s })));
    inputSlot = slotChoice.value;
  }

  // Initial batch size estimate
  const firstBatchSize = calcBatchSize(images, longerDim, paperW, paperH);
  if (!firstBatchSize) {
    console.log(`\nImages at ${longerDim}" don't fit on ${paperW}×${paperH}" paper. Try a smaller size.`);
    rl.close(); return;
  }
  const estPages = Math.ceil(images.length / firstBatchSize);
  console.log(`\n~${firstBatchSize} image(s) per page → ~${estPages} page(s) for ${images.length} images.\n`);

  // Batch loop
  let offset = 0, pageNum = 1;
  while (offset < images.length) {
    const remaining = images.slice(offset);
    const batchSize = calcBatchSize(remaining, longerDim, paperW, paperH);
    if (!batchSize) break;

    const batch = remaining.slice(0, batchSize);
    const totalPages = Math.ceil(images.length / batchSize); // recalculate per batch
    console.log(`── Page ${pageNum}: images ${offset + 1}–${offset + batch.length} of ${images.length} ──`);
    batch.forEach((img, i) => console.log(`  ${offset + i + 1}. ${img.name}`));

    process.stdout.write('\nBuilding composite…');
    const outTiff = path.join(os.tmpdir(), `photoprint_p${pageNum}.tiff`);
    buildComposite(batch, longerDim, paperW, paperH, outTiff);
    console.log(' done.');

    // Preview
    const previewJpg = outTiff.replace('.tiff', '_preview.jpg');
    run(`magick "${outTiff}" -resize 900x "${previewJpg}"`);
    run(`open "${previewJpg}"`);
    console.log('Preview opened in Preview.app.\n');

    const doPrint = await confirm('Print this page?');
    if (doPrint) {
      const result = run(
        `lp -d "${printer}" -o PageSize=${cupsPaperSize} -o InputSlot=${inputSlot} -o MediaType=${mediaType} -o scaling=100 "${outTiff}"`
      );
      console.log(`Sent to printer — ${result}`);
    } else {
      console.log('Skipped.');
    }

    offset += batch.length;
    pageNum++;

    if (offset < images.length) {
      const nextCount = calcBatchSize(images.slice(offset), longerDim, paperW, paperH);
      const doNext = await confirm(`\nPrepare next page (${nextCount} image${nextCount !== 1 ? 's' : ''})?`);
      if (!doNext) { console.log('Done.'); break; }
    }
  }

  if (offset >= images.length) console.log('\nAll images processed.');
  rl.close();
}

main().catch(err => {
  console.error('\nError:', err.message);
  rl.close();
  process.exit(1);
});

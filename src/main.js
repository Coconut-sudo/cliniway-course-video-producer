// src/main.js
import "./style.css";

import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";

import * as pdfjsLib from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function fmtTime(sec) {
  if (!isFinite(sec)) return "--:--.---";
  const ms = Math.floor((sec % 1) * 1000);
  const total = Math.floor(sec);
  const s = total % 60;
  const m = Math.floor(total / 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function clampTime(t, max) {
  if (!isFinite(t)) return 0;
  if (!isFinite(max) || max <= 0) return Math.max(0, t);
  return Math.max(0, Math.min(max, t));
}

// IMPORTANT: treat ALL interactive controls as "typing targets" so Enter/Space won't do global actions
function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName?.toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    tag === "button" ||
    el.isContentEditable
  );
}

/** ---------------------------
 *  UI
 *  --------------------------*/
function mountUI() {
  $("app").innerHTML = `
    <header>
      <h1>Cliniway course video producer</h1>
      <p class="muted">
        Upload audio + PDF. Space play/pause · Enter marks next slide. Drag markers on waveform to tweak timestamps.
        Pointer burn-in supported in export.
      </p>
    </header>

    <audio id="audioEl" preload="metadata" style="display:none;"></audio>

    <div class="wrap">
      <div class="card">
        <div class="muted" style="font-weight:800; font-size:12px;">UPLOAD</div>

        <label class="muted" style="display:block;margin-top:10px;">Audio voiceover</label>
        <input id="audioInput" type="file" accept="audio/*" />

        <label class="muted" style="display:block;margin-top:10px;">Slides PDF</label>
        <input id="pdfInput" type="file" accept="application/pdf" />

        <div style="margin-top:14px;">
          <button id="playBtn" class="btn primary" disabled>Play / Pause (Space)</button>
          <select id="speedSel" disabled style="margin-top:10px;">
            <option value="1">1.0×</option>
            <option value="1.2">1.2×</option>
            <option value="1.5">1.5×</option>
            <option value="2">2.0×</option>
            <option value="3">3.0×</option>
            <option value="5">5.0×</option>
          </select>
        </div>

        <div style="margin-top:12px; display:flex; gap:10px; align-items:center;">
          <label class="muted" style="display:flex; gap:8px; align-items:center; cursor:pointer;">
            <input id="pointerToggle" type="checkbox" />
            Pointer burn-in
          </label>
          <span class="muted" id="pointerStatus">OFF</span>
        </div>

        <div id="waveform" style="height:120px;margin-top:12px;border-radius:16px;border:1px solid var(--border);background:rgba(255,255,255,0.7);"></div>

        <div style="margin-top:10px;">
          <span class="mono">Time: <span id="tNow">00:00.000</span></span>
          <span class="mono" style="float:right;">Dur: <span id="tDur">--:--.---</span></span>
        </div>

        <div style="margin-top:14px; display:flex; gap:10px;">
          <button id="markBtn" class="btn" disabled>Mark next slide (Enter)</button>
          <button id="undoBtn" class="btn" disabled>Undo last</button>
        </div>

        <div class="muted" style="margin-top:12px; font-weight:800; font-size:12px;">TIMESTAMPS</div>
        <div id="marksTable" class="mono" style="margin-top:8px; font-size:12px; line-height:1.55;"></div>

        <div class="muted" style="margin-top:14px; font-weight:800; font-size:12px;">EXPORT</div>
        <select id="resSel" style="margin-top:8px;">
          <option value="2560x1440" selected>1440p (recommended)</option>
          <option value="3840x2160">4K (slow)</option>
        </select>
        <button id="exportBtn" class="btn primary" style="margin-top:10px;" disabled>Export MP4</button>
        <div id="exportStatus" class="muted" style="margin-top:8px; font-size:12px;"></div>

        <div id="runtimeError" style="margin-top:12px;"></div>
      </div>

      <div class="card">
        <div class="muted" style="display:flex;justify-content:space-between;">
          <div>PDF: <b id="pdfName">Not loaded</b></div>
          <div>Slide: <b id="slideInfo">- / -</b></div>
        </div>

        <div id="viewerWrap" style="margin-top:12px;">
          <canvas id="pdfCanvas"></canvas>
          <canvas id="overlayCanvas"></canvas>
        </div>
      </div>
    </div>
  `;
}

mountUI();

const audioEl = $("audioEl");

/** ---------------------------
 *  Global error surfacing
 *  --------------------------*/
function showRuntimeError(err) {
  console.error(err);
  const msg = err && (err.message || String(err)) ? (err.message || String(err)) : "Unknown error";
  $("runtimeError").innerHTML = `<span class="danger">Runtime error:</span> <span class="muted">${escapeHtml(msg)}</span>`;
}

window.addEventListener("error", (e) => showRuntimeError(e.error || new Error(e.message)));
window.addEventListener("unhandledrejection", (e) => showRuntimeError(e.reason));

function showError(err) {
  showRuntimeError(err);
}

/** ---------------------------
 *  App state
 *  --------------------------*/
let audioFile = null;
let wavesurfer = null;
let regions = null;

let pdfDoc = null;
let pageCount = 0;
let currentSlide = 1;

// Marks represent: slide N starts at time t (slide 1 always starts at 0)
const marks = []; // { slide: number, t: number } for slide>=2
const regionBySlide = new Map(); // slide -> region object

// Pointer burn-in
let pointerEnabled = false;
let pointerPos = null; // normalized within overlay canvas (0..1)
const pointerEvents = []; // {t, x, y, kind}

/** ---------------------------
 *  Controls helpers
 *  --------------------------*/
function canInteract() {
  return !!(pdfDoc && audioFile && isFinite(audioEl.duration) && audioEl.duration > 0);
}

function refreshControls() {
  const ready = canInteract();
  $("playBtn").disabled = !ready;
  $("speedSel").disabled = !audioFile;
  $("markBtn").disabled = !ready || currentSlide >= pageCount;
  $("undoBtn").disabled = marks.length === 0;
  $("exportBtn").disabled = !ready;
}

function renderMarksTable() {
  if (!marks.length) {
    $("marksTable").innerHTML = `<span class="muted">No marks yet. Press Enter to create marker for Slide 2, then drag on waveform to tweak.</span>`;
    return;
  }
  const rows = marks
    .slice()
    .sort((a, b) => a.slide - b.slide)
    .map((m) => `Slide ${String(m.slide).padStart(2, "0")}  @  ${fmtTime(m.t)}`)
    .join("<br/>");
  $("marksTable").innerHTML = rows;
}

renderMarksTable();
refreshControls();

/** ---------------------------
 *  PDF render + overlay
 *  --------------------------*/
function resizeOverlayToMatch() {
  const pdf = $("pdfCanvas");
  const ov = $("overlayCanvas");

  ov.width = pdf.width;
  ov.height = pdf.height;

  ov.style.width = `${pdf.width}px`;
  ov.style.height = `${pdf.height}px`;
}

function getPointerAtTime(t) {
  if (!pointerEvents.length) return pointerPos;
  for (let i = pointerEvents.length - 1; i >= 0; i--) {
    if (pointerEvents[i].t <= t) return { x: pointerEvents[i].x, y: pointerEvents[i].y };
  }
  return pointerPos;
}

function drawOverlayAtTime(t) {
  const ov = $("overlayCanvas");
  const ctx = ov.getContext("2d");
  ctx.clearRect(0, 0, ov.width, ov.height);

  if (!pointerEnabled) return;

  const p = getPointerAtTime(t);
  if (!p) return;

  const cx = p.x * ov.width;
  const cy = p.y * ov.height;

  ctx.save();

  ctx.beginPath();
  ctx.arc(cx, cy, 18, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(168,212,240,0.55)";
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, 6, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(47,128,237,0.92)";
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, 14, 0, Math.PI * 2);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(47,128,237,0.75)";
  ctx.stroke();

  ctx.restore();
}

async function renderSlide(n) {
  if (!pdfDoc) return;

  currentSlide = Math.max(1, Math.min(pageCount, n));

  const page = await pdfDoc.getPage(currentSlide);
  const canvas = $("pdfCanvas");
  const ctx = canvas.getContext("2d", { alpha: false });

  const wrap = $("viewerWrap");
  const maxW = wrap.clientWidth - 20;
  const maxH = wrap.clientHeight - 20;

  const vp1 = page.getViewport({ scale: 1 });
  const scale = Math.min(maxW / vp1.width, maxH / vp1.height);
  const vp = page.getViewport({ scale });

  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);

  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;

  $("slideInfo").textContent = `${currentSlide} / ${pageCount}`;

  resizeOverlayToMatch();
  drawOverlayAtTime(audioEl.currentTime || 0);
  refreshControls();
}

/** ---------------------------
 *  Pointer recording
 *  --------------------------*/
function setPointerEnabled(on) {
  pointerEnabled = !!on;
  $("pointerStatus").textContent = on ? "ON" : "OFF";
  if (!on) pointerPos = null;
  drawOverlayAtTime(audioEl.currentTime || 0);
}

function recordPointer(kind, x, y) {
  if (!pointerEnabled) return;
  if (!canInteract()) return;

  const t = clampTime(audioEl.currentTime || 0, audioEl.duration || 0);

  const last = pointerEvents[pointerEvents.length - 1];
  if (last && t < last.t) return;

  pointerEvents.push({ t, x, y, kind });
}

function getOverlayRect() {
  return $("overlayCanvas").getBoundingClientRect();
}

function toNormalized(clientX, clientY) {
  const r = getOverlayRect();
  const x = (clientX - r.left) / r.width;
  const y = (clientY - r.top) / r.height;
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
}

/** ---------------------------
 *  Waveform markers (regions)
 *  --------------------------*/
function clearAllRegions() {
  regionBySlide.clear();
  if (regions && regions.clear) regions.clear();
}

function markBoundsForSlide(slide) {
  // slide>=2 has a mark; clamp between previous and next mark (monotonic)
  const dur = audioEl.duration || 0;

  const prevT = slide === 2 ? 0 : (marks.find(m => m.slide === slide - 1)?.t ?? 0);
  const nextT = marks.find(m => m.slide === slide + 1)?.t ?? dur;

  // keep at least 50ms gap
  const lo = clampTime(prevT + 0.05, dur);
  const hi = clampTime(nextT - 0.05, dur);
  return { lo, hi };
}

function upsertRegionForMark(slide, t) {
  if (!regions) return;

  const color = "rgba(47,128,237,0.12)";
  const label = `Slide ${slide}`;

  // WaveSurfer regions are ranges; we create a very short region as a draggable "marker"
  const start = t;
  const end = Math.min(t + 0.001, (audioEl.duration || t + 0.001));

  // Remove existing
  const old = regionBySlide.get(slide);
  if (old && old.remove) old.remove();

  const r = regions.addRegion({
    start,
    end,
    drag: true,
    resize: false,
    color,
    content: label,
  });

  // When dragged, update mark time (clamped)
  r.on("update-end", () => {
    const newT = r.start;
    const { lo, hi } = markBoundsForSlide(slide);
    const clamped = Math.max(lo, Math.min(hi, newT));

    // If clamp changed it, snap region to clamped
    if (Math.abs(clamped - newT) > 1e-3) {
      r.setOptions({ start: clamped, end: Math.min(clamped + 0.001, audioEl.duration || clamped + 0.001) });
    }

    const idx = marks.findIndex(m => m.slide === slide);
    if (idx >= 0) marks[idx].t = clamped;
    renderMarksTable();
  });

  // Clicking marker seeks to it
  r.element?.addEventListener?.("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    audioEl.currentTime = r.start;
    wavesurfer?.setTime?.(r.start);
    // also show correct slide at that time
    const s = slideAtTime(buildSchedule(), r.start);
    renderSlide(s).catch(showError);
  });

  regionBySlide.set(slide, r);
}

function rebuildAllRegions() {
  if (!regions || !audioFile) return;
  clearAllRegions();
  marks.slice().sort((a,b)=>a.slide-b.slide).forEach(m => upsertRegionForMark(m.slide, m.t));
}

/** ---------------------------
 *  Mark / undo
 *  --------------------------*/
function doMark() {
  if (!canInteract()) return;
  if (currentSlide >= pageCount) return;

  const nextSlide = currentSlide + 1;
  const dur = audioEl.duration || 0;
  const tRaw = clampTime(audioEl.currentTime || 0, dur);

  // if already exists, we don't create duplicate; just focus it
  if (marks.some(m => m.slide === nextSlide)) {
    const existing = marks.find(m => m.slide === nextSlide);
    upsertRegionForMark(nextSlide, existing.t);
    renderSlide(nextSlide).catch(showError);
    return;
  }

  // ensure monotonic with previous mark
  const prev = nextSlide === 2 ? 0 : (marks.find(m => m.slide === nextSlide - 1)?.t ?? 0);
  const t = Math.max(prev + 0.05, tRaw);

  marks.push({ slide: nextSlide, t });
  marks.sort((a,b)=>a.slide-b.slide);

  upsertRegionForMark(nextSlide, t);
  renderMarksTable();

  renderSlide(nextSlide).catch(showError);
}

function doUndo() {
  if (!marks.length) return;

  // remove last slide mark (highest slide)
  marks.sort((a,b)=>a.slide-b.slide);
  const removed = marks.pop();

  const r = regionBySlide.get(removed.slide);
  if (r && r.remove) r.remove();
  regionBySlide.delete(removed.slide);

  renderMarksTable();
  const backTo = Math.max(1, removed.slide - 1);
  renderSlide(backTo).catch(showError);
}

/** ---------------------------
 *  Audio + waveform
 *  --------------------------*/
function initWaveSurfer(url) {
  if (wavesurfer) wavesurfer.destroy();

  regions = RegionsPlugin.create();

  wavesurfer = WaveSurfer.create({
    container: "#waveform",
    height: 120,
    normalize: true,
    media: audioEl,
    waveColor: "rgba(47,128,237,0.30)",
    progressColor: "rgba(47,128,237,0.80)",
    cursorColor: "rgba(17,24,39,0.55)",
    plugins: [regions],
  });

  wavesurfer.load(url);

  // Click waveform to seek; also update slide display at that time
  wavesurfer.on("interaction", () => {
    const t = wavesurfer.getTime();
    const s = slideAtTime(buildSchedule(), t);
    renderSlide(s).catch(showError);
  });

  // After ready, rebuild regions (if any marks)
  wavesurfer.on("ready", () => {
    rebuildAllRegions();
  });
}

$("audioInput").addEventListener("change", async (e) => {
  try {
    const f = e.target.files?.[0];
    if (!f) return; // cancel -> keep current

    audioFile = f;
    const url = URL.createObjectURL(f);
    audioEl.src = url;
    audioEl.load();

    initWaveSurfer(url);

    audioEl.onloadedmetadata = () => {
      $("tDur").textContent = fmtTime(audioEl.duration);
      refreshControls();
      rebuildAllRegions();
    };

    $("audioInput").blur();
    e.target.value = "";
    refreshControls();
  } catch (err) {
    showError(err);
  }
});

$("pdfInput").addEventListener("change", async (e) => {
  try {
    const f = e.target.files?.[0];
    if (!f) return; // cancel -> keep current

    $("pdfName").textContent = f.name;
    const buf = await f.arrayBuffer();

    try {
      pdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;
    } catch {
      pdfDoc = await pdfjsLib.getDocument({ data: buf, disableWorker: true }).promise;
    }

    pageCount = pdfDoc.numPages;
    currentSlide = 1;
    $("slideInfo").textContent = `1 / ${pageCount}`;

    // Reset marks when new PDF loads (recommended)
    marks.length = 0;
    clearAllRegions();
    renderMarksTable();

    // pointer logs reset (optional)
    pointerEvents.length = 0;
    pointerPos = null;

    await renderSlide(1);

    $("pdfInput").blur();
    e.target.value = "";
    refreshControls();
  } catch (err) {
    showError(err);
  }
});

/** ---------------------------
 *  UI event listeners
 *  --------------------------*/
$("playBtn").addEventListener("click", () => {
  if (!canInteract()) return;
  if (audioEl.paused) audioEl.play();
  else audioEl.pause();
});

$("speedSel").addEventListener("change", (e) => {
  audioEl.playbackRate = parseFloat(e.target.value);
});

$("markBtn").addEventListener("click", doMark);
$("undoBtn").addEventListener("click", doUndo);

$("pointerToggle").addEventListener("change", (e) => {
  setPointerEnabled(e.target.checked);
});

const overlay = $("overlayCanvas");
overlay.addEventListener("mousemove", (e) => {
  if (!pointerEnabled) return;
  const p = toNormalized(e.clientX, e.clientY);
  pointerPos = p;
  recordPointer("move", p.x, p.y);
  drawOverlayAtTime(audioEl.currentTime || 0);
});
overlay.addEventListener("mousedown", (e) => {
  if (!pointerEnabled) return;
  const p = toNormalized(e.clientX, e.clientY);
  pointerPos = p;
  recordPointer("down", p.x, p.y);
  drawOverlayAtTime(audioEl.currentTime || 0);
});
overlay.addEventListener("mouseup", (e) => {
  if (!pointerEnabled) return;
  const p = toNormalized(e.clientX, e.clientY);
  pointerPos = p;
  recordPointer("up", p.x, p.y);
  drawOverlayAtTime(audioEl.currentTime || 0);
});

// prevent Enter/Space on file inputs from bubbling to global handler / reopening picker
for (const id of ["audioInput", "pdfInput"]) {
  $(id).addEventListener("keydown", (e) => {
    if (e.code === "Enter" || e.code === "Space") {
      e.preventDefault();
      e.stopPropagation();
    }
  });
}

// Keyboard
window.addEventListener("keydown", (e) => {
  if (isTypingTarget(document.activeElement)) return;

  if (e.code === "Space") {
    e.preventDefault();
    if (!canInteract()) return;
    if (audioEl.paused) audioEl.play();
    else audioEl.pause();
  }

  if (e.code === "Enter") {
    e.preventDefault();
    doMark(); // works paused or playing
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    doUndo();
  }
});

// time tick
(function tick() {
  const t = audioEl.currentTime || 0;
  $("tNow").textContent = fmtTime(t);
  drawOverlayAtTime(t);

  // show slide following playback time
  if (canInteract()) {
    const s = slideAtTime(buildSchedule(), t);
    if (s !== currentSlide) renderSlide(s).catch(() => {});
  }

  requestAnimationFrame(tick);
})();

/** ---------------------------
 *  FFmpeg loading (GitHub Pages safe)
 *  --------------------------*/
async function loadFFmpeg(ffmpeg) {
  // Vite sets BASE_URL to "/" in dev and "/<repo>/" on GitHub Pages.
  const base = import.meta.env.BASE_URL; // ends with "/"
  const coreURL = await toBlobURL(`${base}vendor/ffmpeg/ffmpeg-core.js`, "text/javascript");
  const wasmURL = await toBlobURL(`${base}vendor/ffmpeg/ffmpeg-core.wasm`, "application/wasm");
  await ffmpeg.load({ coreURL, wasmURL });
}

async function blobToU8(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

function getAudioInputName(file) {
  const name = file?.name || "audio";
  const dot = name.lastIndexOf(".");
  if (dot > 0 && dot < name.length - 1) return `audio_input${name.slice(dot)}`;
  return "audio_input";
}

/** ---------------------------
 *  Export scheduling + pointer burn-in (segment fast path)
 *  --------------------------*/
function buildSchedule() {
  const dur = audioEl.duration || 0;

  // slide 1 starts at 0; slide s starts at marks entry for s
  const start = new Map();
  start.set(1, 0);
  for (const m of marks) start.set(m.slide, m.t);

  // only schedule slides that have a start time; last scheduled slide holds to end
  const arr = [];
  for (let s = 1; s <= pageCount; s++) {
    if (start.has(s)) arr.push({ slide: s, t0: start.get(s) });
  }
  arr.sort((a, b) => a.t0 - b.t0);

  const segs = [];
  for (let i = 0; i < arr.length; i++) {
    const t0 = clampTime(arr[i].t0, dur);
    const t1 = i + 1 < arr.length ? clampTime(arr[i + 1].t0, dur) : dur;
    const len = Math.max(0, t1 - t0);
    segs.push({ slide: arr[i].slide, t0, t1, len });
  }
  return segs.filter((s) => s.len > 0.001);
}

function slideAtTime(segs, t) {
  if (!segs?.length) return 1;
  for (let i = segs.length - 1; i >= 0; i--) {
    if (t >= segs[i].t0) return segs[i].slide;
  }
  return 1;
}

// Render each slide into exact output W×H and also return the content rect used to map pointer coords.
async function renderSlidePngAndRect(slideNum, W, H) {
  const page = await pdfDoc.getPage(slideNum);

  const vp1 = page.getViewport({ scale: 1 });
  const scale = Math.min(W / vp1.width, H / vp1.height);
  const vp = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { alpha: false });

  // black background
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, W, H);

  // center the rendered page
  const x0 = Math.floor((W - vp.width) / 2);
  const y0 = Math.floor((H - vp.height) / 2);

  // Render PDF into a temporary canvas at vp size, then draw into output canvas at x0,y0
  const tmp = document.createElement("canvas");
  tmp.width = Math.floor(vp.width);
  tmp.height = Math.floor(vp.height);
  const tctx = tmp.getContext("2d", { alpha: false });
  tctx.fillStyle = "black";
  tctx.fillRect(0, 0, tmp.width, tmp.height);

  await page.render({ canvasContext: tctx, viewport: vp }).promise;

  ctx.drawImage(tmp, x0, y0);

  const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
  if (!blob) throw new Error("Failed to encode slide PNG.");

  return {
    png: await blobToU8(blob),
    rect: { x0, y0, w: tmp.width, h: tmp.height },
  };
}

// For pointer burn-in: generate per-segment overlay PNG sequence (transparent) at OV_FPS
async function writePointerOverlayFrames(ffmpeg, seg, W, H, slideRect, ovFps) {
  // Create an overlay canvas with alpha
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d", { alpha: true });

  const frames = Math.max(1, Math.ceil(seg.len * ovFps));

  for (let i = 0; i < frames; i++) {
    const t = seg.t0 + i / ovFps;

    ctx.clearRect(0, 0, W, H);

    if (pointerEnabled) {
      const p = getPointerAtTime(t);
      if (p) {
        const cx = slideRect.x0 + p.x * slideRect.w;
        const cy = slideRect.y0 + p.y * slideRect.h;

        // glow
        ctx.beginPath();
        ctx.arc(cx, cy, 18, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(168,212,240,0.55)";
        ctx.fill();

        // core dot
        ctx.beginPath();
        ctx.arc(cx, cy, 6, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(47,128,237,0.92)";
        ctx.fill();

        // ring
        ctx.beginPath();
        ctx.arc(cx, cy, 14, 0, Math.PI * 2);
        ctx.lineWidth = 2;
        ctx.strokeStyle = "rgba(47,128,237,0.75)";
        ctx.stroke();
      }
    }

    const blob = await new Promise((res) => c.toBlob(res, "image/png"));
    const u8 = await blobToU8(blob);
    const name = `ov_${String(i).padStart(6, "0")}.png`;
    await ffmpeg.writeFile(name, u8);
  }

  return frames;
}

function setExportStatus(html) {
  $("exportStatus").innerHTML = html;
}

function safeSegName(i) {
  return `seg_${String(i).padStart(5, "0")}.mp4`;
}

function safeSlideName(slideNum) {
  return `slide_${String(slideNum).padStart(4, "0")}.png`;
}

function canDeleteFiles(ffmpeg) {
  return typeof ffmpeg.deleteFile === "function";
}

async function deleteOverlayFrames(ffmpeg, frames) {
  if (!canDeleteFiles(ffmpeg)) return;
  for (let i = 0; i < frames; i++) {
    const name = `ov_${String(i).padStart(6, "0")}.png`;
    try { await ffmpeg.deleteFile(name); } catch {}
  }
}

$("exportBtn").addEventListener("click", async () => {
  try {
    if (!canInteract()) throw new Error("Load audio and PDF first.");

    const segs = buildSchedule();
    if (!segs.length) {
      // Allow exporting “single slide holds to end” with no marks
      segs.push({ slide: 1, t0: 0, t1: audioEl.duration, len: audioEl.duration });
    }

    const [W, H] = $("resSel").value.split("x").map(Number);
    const outFps = 30;
    const ovFps = 10; // pointer overlay sampling FPS (trade-off: speed vs smoothness)

    setExportStatus(`Loading FFmpeg...`);
    const ffmpeg = new FFmpeg();
    await loadFFmpeg(ffmpeg);

    // Write audio
    setExportStatus(`Preparing audio...`);
    const audioName = getAudioInputName(audioFile);
    const audioBytes = new Uint8Array(await audioFile.arrayBuffer());
    await ffmpeg.writeFile(audioName, audioBytes);

    // Render needed slides once (into exact W×H) and keep their pointer mapping rect
    const neededSlides = [...new Set(segs.map((s) => s.slide))];
    setExportStatus(`Rasterizing ${neededSlides.length} slide(s)...`);
    const slideRectByNum = new Map();

    for (let i = 0; i < neededSlides.length; i++) {
      const slideNum = neededSlides[i];
      const { png, rect } = await renderSlidePngAndRect(slideNum, W, H);
      await ffmpeg.writeFile(safeSlideName(slideNum), png);
      slideRectByNum.set(slideNum, rect);
      if (i % 2 === 0) setExportStatus(`Rasterizing slides... (${i + 1}/${neededSlides.length})`);
    }

    // Encode each segment:
    // - loop slide PNG
    // - optionally overlay pointer frames (PNG sequence) for that segment
    setExportStatus(`Encoding segments... (0/${segs.length})`);
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const outSeg = safeSegName(i);
      const t = seg.len.toFixed(3);

      const slidePng = safeSlideName(seg.slide);
      const rect = slideRectByNum.get(seg.slide);

      // If pointer is enabled, we generate overlay frames for this segment then overlay them.
      if (pointerEnabled && rect) {
        // clean up old overlay frames from previous segment
        // (best effort: if deleteFile exists, remove old; else overwrite)
        // We'll generate frames and then (optionally) delete them after encoding.
        setExportStatus(`Encoding segment ${i + 1}/${segs.length} (pointer overlay frames)...`);
        const frames = await writePointerOverlayFrames(ffmpeg, seg, W, H, rect, ovFps);

        // Build segment with overlay:
        // 0: loop slide image
        // 1: overlay PNG sequence at ovFps
        await ffmpeg.exec([
          "-y",
          "-loop",
          "1",
          "-i",
          slidePng,
          "-framerate",
          String(ovFps),
          "-i",
          "ov_%06d.png",
          "-t",
          t,
          "-filter_complex",
          "[0:v][1:v]overlay=0:0:format=auto",
          "-r",
          String(outFps),
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-preset",
          "veryfast",
          "-crf",
          "20",
          outSeg,
        ]);

        await deleteOverlayFrames(ffmpeg, frames);
      } else {
        // No pointer: pure fast loop segment
        await ffmpeg.exec([
          "-y",
          "-loop",
          "1",
          "-i",
          slidePng,
          "-t",
          t,
          "-r",
          String(outFps),
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-preset",
          "veryfast",
          "-crf",
          "20",
          outSeg,
        ]);
      }

      if (i % 5 === 0) setExportStatus(`Encoding segments... (${i + 1}/${segs.length})`);
    }

    // Concat segments
    setExportStatus(`Concatenating segments...`);
    const concatTxt = segs.map((_, i) => `file ${safeSegName(i)}`).join("\n") + "\n";
    await ffmpeg.writeFile("concat.txt", new TextEncoder().encode(concatTxt));

    await ffmpeg.exec([
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      "concat.txt",
      "-c",
      "copy",
      "video.mp4",
    ]);

    // Mux audio
    setExportStatus(`Muxing audio...`);
    await ffmpeg.exec([
      "-y",
      "-i",
      "video.mp4",
      "-i",
      audioName,
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      "out.mp4",
    ]);

    setExportStatus(`<span class="ok">Finalizing...</span>`);
    const out = await ffmpeg.readFile("out.mp4");
    const outBlob = new Blob([out.buffer], { type: "video/mp4" });
    const url = URL.createObjectURL(outBlob);

    const a = document.createElement("a");
    a.href = url;
    a.download = "cliniway_course.mp4";
    a.click();

    setExportStatus(`<span class="ok">Done.</span>`);
  } catch (err) {
    showError(err);
    setExportStatus(`<span class="danger">Export failed.</span>`);
  }
});

/** ---------------------------
 *  Initial sync
 *  --------------------------*/
refreshControls();
renderMarksTable();
setPointerEnabled(false);

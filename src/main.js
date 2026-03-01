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

/* ---------------------------
 * UI
 * --------------------------*/
function mountUI() {
  $("app").innerHTML = `
    <header class="top">
      <div>
        <h1>Cliniway course video producer</h1>
        <p class="muted">
          Upload audio + PDF. Space play/pause · Enter marks next slide. Drag markers on waveform to tweak.
          Zoom waveform for precision. Pointer burn-in supported in export.
        </p>
      </div>
    </header>

    <audio id="audioEl" preload="metadata" style="display:none;"></audio>

    <div class="wrap">
      <div class="card">
        <div class="section-title">UPLOAD</div>

        <label class="muted label">Audio voiceover</label>
        <input id="audioInput" type="file" accept="audio/*" />

        <label class="muted label">Slides PDF</label>
        <input id="pdfInput" type="file" accept="application/pdf" />

        <div class="row" style="margin-top:14px;">
          <button id="playBtn" class="btn primary" disabled>Play / Pause (Space)</button>
          <select id="speedSel" class="select" disabled>
            <option value="1">1.0×</option>
            <option value="1.2">1.2×</option>
            <option value="1.5">1.5×</option>
            <option value="2">2.0×</option>
            <option value="3">3.0×</option>
            <option value="5">5.0×</option>
          </select>
        </div>

        <div class="row" style="margin-top:10px;">
          <label class="toggle">
            <input id="pointerToggle" type="checkbox" />
            <span>Pointer burn-in</span>
          </label>
          <span class="muted" id="pointerStatus">OFF</span>
        </div>

        <div id="waveform" class="wave"></div>

        <div class="row" style="margin-top:10px;">
          <div class="mono">Time: <span id="tNow">00:00.000</span></div>
          <div class="mono">Dur: <span id="tDur">--:--.---</span></div>
        </div>

        <div style="margin-top:10px;">
          <div class="row" style="align-items:center;">
            <div class="muted label" style="margin:0;">Zoom</div>
            <div class="mono"><span id="zoomLabel">80</span> px/s</div>
          </div>
          <input id="zoomRange" type="range" min="20" max="500" value="80" />
        </div>

        <div class="row" style="margin-top:14px;">
          <button id="markBtn" class="btn" disabled>Mark next slide (Enter)</button>
          <button id="undoBtn" class="btn" disabled>Undo last</button>
        </div>

        <div class="section-title" style="margin-top:14px;">TIMESTAMPS</div>
        <div id="marksTable" class="mono marks"></div>

        <div class="section-title" style="margin-top:14px;">EXPORT</div>
        <select id="resSel" class="select">
          <option value="2560x1440" selected>1440p (recommended)</option>
          <option value="3840x2160">4K (slow)</option>
        </select>

        <div class="row" style="margin-top:10px;">
          <button id="exportBtn" class="btn primary" disabled>Export MP4</button>
          <select id="ptrFpsSel" class="select" title="Pointer overlay FPS">
            <option value="10" selected>Pointer 10 fps</option>
            <option value="15">Pointer 15 fps</option>
            <option value="20">Pointer 20 fps</option>
          </select>
        </div>
        <div id="exportStatus" class="muted" style="margin-top:8px; font-size:12px;"></div>

        <div id="runtimeError" style="margin-top:12px;"></div>
      </div>

      <div class="card">
        <div class="row muted" style="justify-content:space-between;">
          <div>PDF: <b id="pdfName">Not loaded</b></div>
          <div>Slide: <b id="slideInfo">- / -</b></div>
        </div>

        <div id="viewerWrap" class="viewer" style="margin-top:12px;">
          <canvas id="pdfCanvas"></canvas>
          <canvas id="overlayCanvas"></canvas>
        </div>
      </div>
    </div>
  `;
}

mountUI();

const audioEl = $("audioEl");

/* ---------------------------
 * Errors
 * --------------------------*/
function showRuntimeError(err) {
  console.error(err);
  const msg = err && (err.message || String(err)) ? (err.message || String(err)) : "Unknown error";
  $("runtimeError").innerHTML = `<span class="danger">Runtime error:</span> <span class="muted">${escapeHtml(msg)}</span>`;
}
window.addEventListener("error", (e) => showRuntimeError(e.error || new Error(e.message)));
window.addEventListener("unhandledrejection", (e) => showRuntimeError(e.reason));
function showError(err) { showRuntimeError(err); }

/* ---------------------------
 * State
 * --------------------------*/
let audioFile = null;

let wavesurfer = null;
let regions = null;
const regionBySlide = new Map(); // slide -> region marker

let pdfDoc = null;
let pageCount = 0;
let currentSlide = 1;

// marks store slide start times for slide>=2: { slide, t }
const marks = []; // sorted by slide

// pointer
let pointerEnabled = false;
let pointerPos = null; // normalized within page (0..1)
const pointerEvents = []; // {t,x,y,kind}

/* ---------------------------
 * Helpers / UI
 * --------------------------*/
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
    $("marksTable").innerHTML =
      `<span class="muted">No marks yet. Press Enter to create Slide 2 marker, then drag markers on waveform to tweak.</span>`;
    return;
  }
  const rows = marks
    .slice()
    .sort((a, b) => a.slide - b.slide)
    .map((m) => `Slide ${String(m.slide).padStart(2, "0")}  @  ${fmtTime(m.t)}`)
    .join("<br/>");
  $("marksTable").innerHTML = rows;
}

/* ---------------------------
 * PDF Render + preview overlay
 * --------------------------*/
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

/* ---------------------------
 * Pointer capture
 * --------------------------*/
function setPointerEnabled(on) {
  pointerEnabled = !!on;
  $("pointerStatus").textContent = on ? "ON" : "OFF";
  if (!on) pointerPos = null;
  drawOverlayAtTime(audioEl.currentTime || 0);
}
function togglePointer() {
  const next = !pointerEnabled;
  $("pointerToggle").checked = next;
  setPointerEnabled(next);
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

/* ---------------------------
 * Waveform markers (Regions) with anti-overlap clamping
 * --------------------------*/
function clearAllRegions() {
  regionBySlide.clear();
  if (regions && regions.clear) regions.clear();
}

function clampMarker(slide, t) {
  const dur = audioEl.duration || 0;

  const prevT = slide === 2 ? 0 : (marks.find(m => m.slide === slide - 1)?.t ?? 0);
  const nextT = marks.find(m => m.slide === slide + 1)?.t ?? dur;

  const lo = clampTime(prevT + 0.05, dur);
  const hi = clampTime(nextT - 0.05, dur);

  return Math.max(lo, Math.min(hi, t));
}

function addOrUpdateMarker(slide, t) {
  if (!regions) return;

  const old = regionBySlide.get(slide);
  if (old?.remove) old.remove();

  const dur = audioEl.duration || 0;
  const start = clampTime(t, dur);
  const end = Math.min(start + 0.001, dur);

  const r = regions.addRegion({
    start,
    end,
    drag: true,
    resize: false,
    color: "rgba(47,128,237,0.14)",
    content: `Slide ${slide}`,
  });

  r.on("update-end", () => {
    const clamped = clampMarker(slide, r.start);
    r.setOptions({ start: clamped, end: Math.min(clamped + 0.001, dur) });

    const idx = marks.findIndex(m => m.slide === slide);
    if (idx >= 0) marks[idx].t = clamped;

    renderMarksTable();
  });

  // Click marker -> seek
  r.element?.addEventListener?.("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    audioEl.currentTime = r.start;
    wavesurfer?.setTime?.(r.start);
  });

  regionBySlide.set(slide, r);
}

function rebuildAllMarkers() {
  if (!regions) return;
  clearAllRegions();
  marks.slice().sort((a,b)=>a.slide-b.slide).forEach(m => addOrUpdateMarker(m.slide, m.t));
}

/* ---------------------------
 * Mark / Undo
 * --------------------------*/
function doMark() {
  if (!canInteract()) return;
  if (currentSlide >= pageCount) return;

  const nextSlide = currentSlide + 1;
  const dur = audioEl.duration || 0;

  // Prevent duplicate mark for same slide
  if (marks.some(m => m.slide === nextSlide)) {
    renderSlide(nextSlide).catch(() => {});
    return;
  }

  // Enforce monotonic with previous
  const prevT = nextSlide === 2 ? 0 : (marks.find(m => m.slide === nextSlide - 1)?.t ?? 0);
  const tRaw = clampTime(audioEl.currentTime || 0, dur);
  const t = Math.max(prevT + 0.05, tRaw);

  marks.push({ slide: nextSlide, t });
  marks.sort((a,b)=>a.slide-b.slide);

  addOrUpdateMarker(nextSlide, t);
  renderMarksTable();
  renderSlide(nextSlide).catch(() => {});
}

function doUndo() {
  if (!marks.length) return;

  marks.sort((a,b)=>a.slide-b.slide);
  const removed = marks.pop();

  const r = regionBySlide.get(removed.slide);
  if (r?.remove) r.remove();
  regionBySlide.delete(removed.slide);

  renderMarksTable();
  renderSlide(Math.max(1, removed.slide - 1)).catch(() => {});
}

/* ---------------------------
 * WaveSurfer init + Zoom
 * --------------------------*/
function initWaveSurfer(url) {
  if (wavesurfer) wavesurfer.destroy();

  regions = RegionsPlugin.create();

  wavesurfer = WaveSurfer.create({
    container: "#waveform",
    height: 120,
    normalize: true,
    media: audioEl,
    waveColor: "rgba(47,128,237,0.30)",
    progressColor: "rgba(47,128,237,0.85)",
    cursorColor: "rgba(17,24,39,0.55)",
    plugins: [regions],
  });

  wavesurfer.load(url);

  wavesurfer.on("ready", () => {
    const z = Number($("zoomRange").value);
    wavesurfer.zoom(z);
    $("zoomLabel").textContent = String(z);
    rebuildAllMarkers();
  });
}

$("zoomRange").addEventListener("input", (e) => {
  const z = Number(e.target.value);
  $("zoomLabel").textContent = String(z);
  wavesurfer?.zoom?.(z);
});

/* ---------------------------
 * Upload handlers
 * --------------------------*/
$("audioInput").addEventListener("change", async (e) => {
  try {
    const f = e.target.files?.[0];
    if (!f) return; // cancel -> keep current file

    audioFile = f;
    const url = URL.createObjectURL(f);
    audioEl.src = url;
    audioEl.load();

    initWaveSurfer(url);

    audioEl.onloadedmetadata = () => {
      $("tDur").textContent = fmtTime(audioEl.duration);
      refreshControls();
      rebuildAllMarkers();
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
    if (!f) return; // cancel -> keep current file

    $("pdfName").textContent = f.name;
    const buf = await f.arrayBuffer();

    try {
      pdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;
    } catch {
      pdfDoc = await pdfjsLib.getDocument({ data: buf, disableWorker: true }).promise;
    }

    pageCount = pdfDoc.numPages;
    currentSlide = 1;

    // Reset slide marks when new PDF loads (recommended)
    marks.length = 0;
    clearAllRegions();
    renderMarksTable();

    pointerEvents.length = 0;
    pointerPos = null;

    await renderSlide(1);
    refreshControls();

    $("pdfInput").blur();
    e.target.value = "";
  } catch (err) {
    showError(err);
  }
});

/* ---------------------------
 * UI listeners
 * --------------------------*/
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

$("pointerToggle").addEventListener("change", (e) => setPointerEnabled(e.target.checked));

// prevent Enter/Space on file inputs from reopening picker and bubbling
for (const id of ["audioInput", "pdfInput"]) {
  $(id).addEventListener("keydown", (e) => {
    if (e.code === "Enter" || e.code === "Space") {
      e.preventDefault();
      e.stopPropagation();
    }
  });
}

// pointer capture on overlay
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

// Keyboard shortcuts
window.addEventListener("keydown", (e) => {
  if (isTypingTarget(document.activeElement)) return;

  if (e.key.toLowerCase() === "p") {
    e.preventDefault();
    togglePointer();
    return;
  }

  if (e.code === "Space") {
    e.preventDefault();
    if (!canInteract()) return;
    if (audioEl.paused) audioEl.play();
    else audioEl.pause();
    return;
  }

  if (e.code === "Enter") {
    e.preventDefault();
    doMark();
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    doUndo();
    return;
  }
});

// Tick
(function tick() {
  const t = audioEl.currentTime || 0;
  $("tNow").textContent = fmtTime(t);
  drawOverlayAtTime(t);
  requestAnimationFrame(tick);
})();

/* ---------------------------
 * FFmpeg loader (CDN; no wasm upload)
 * --------------------------*/
async function loadFFmpeg(ffmpeg) {
  // pinned version; avoids having to upload ffmpeg-core.wasm to GitHub
  const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";
  const coreURL = await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript");
  const wasmURL = await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm");
  await ffmpeg.load({ coreURL, wasmURL });
}

function setExportStatus(html) {
  $("exportStatus").innerHTML = html;
}

function getAudioInputName(file) {
  const name = file?.name || "audio";
  const dot = name.lastIndexOf(".");
  if (dot > 0 && dot < name.length - 1) return `audio_input${name.slice(dot)}`;
  return "audio_input";
}

async function blobToU8(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

/* ---------------------------
 * Export schedule
 * slide 1 starts at 0, slide s starts at marks[slide=s].t
 * --------------------------*/
function buildSchedule() {
  const dur = audioEl.duration || 0;
  const start = new Map();
  start.set(1, 0);
  for (const m of marks) start.set(m.slide, m.t);

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

function safeSegName(i) {
  return `seg_${String(i).padStart(5, "0")}.mp4`;
}
function safeSlideName(slideNum) {
  return `slide_${String(slideNum).padStart(4, "0")}.png`;
}

/* ---------------------------
 * Render slide into exact output W×H and return rect for pointer mapping
 * --------------------------*/
async function renderSlidePngAndRect(slideNum, W, H) {
  const page = await pdfDoc.getPage(slideNum);

  const vp1 = page.getViewport({ scale: 1 });
  const scale = Math.min(W / vp1.width, H / vp1.height);
  const vp = page.getViewport({ scale });

  const out = document.createElement("canvas");
  out.width = W;
  out.height = H;
  const octx = out.getContext("2d", { alpha: false });

  octx.fillStyle = "black";
  octx.fillRect(0, 0, W, H);

  const tmp = document.createElement("canvas");
  tmp.width = Math.floor(vp.width);
  tmp.height = Math.floor(vp.height);
  const tctx = tmp.getContext("2d", { alpha: false });
  tctx.fillStyle = "black";
  tctx.fillRect(0, 0, tmp.width, tmp.height);

  await page.render({ canvasContext: tctx, viewport: vp }).promise;

  const x0 = Math.floor((W - tmp.width) / 2);
  const y0 = Math.floor((H - tmp.height) / 2);
  octx.drawImage(tmp, x0, y0);

  const blob = await new Promise((res) => out.toBlob(res, "image/png"));
  if (!blob) throw new Error("Failed to encode slide PNG.");

  return {
    png: await blobToU8(blob),
    rect: { x0, y0, w: tmp.width, h: tmp.height },
  };
}

/* ---------------------------
 * Pointer overlay frames per segment (fast mode)
 * --------------------------*/
async function writePointerOverlayFrames(ffmpeg, seg, W, H, slideRect, ovFps) {
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
      }
    }

    const blob = await new Promise((res) => c.toBlob(res, "image/png"));
    const u8 = await blobToU8(blob);
    const name = `ov_${String(i).padStart(6, "0")}.png`;
    await ffmpeg.writeFile(name, u8);
  }

  return frames;
}

async function deleteOverlayFrames(ffmpeg, frames) {
  if (typeof ffmpeg.deleteFile !== "function") return;
  for (let i = 0; i < frames; i++) {
    const name = `ov_${String(i).padStart(6, "0")}.png`;
    try { await ffmpeg.deleteFile(name); } catch {}
  }
}

/* ---------------------------
 * Export
 * --------------------------*/
$("exportBtn").addEventListener("click", async () => {
  try {
    if (!canInteract()) throw new Error("Load audio and PDF first.");

    let segs = buildSchedule();
    if (!segs.length) {
      // Allow export even without marks: slide 1 holds full duration
      segs = [{ slide: 1, t0: 0, t1: audioEl.duration, len: audioEl.duration }];
    }

    const [W, H] = $("resSel").value.split("x").map(Number);
    const outFps = 30;
    const ovFps = Number($("ptrFpsSel").value);

    setExportStatus(`Loading FFmpeg (CDN core/wasm)...`);
    const ffmpeg = new FFmpeg();
    await loadFFmpeg(ffmpeg);

    setExportStatus(`Preparing audio...`);
    const audioName = getAudioInputName(audioFile);
    await ffmpeg.writeFile(audioName, new Uint8Array(await audioFile.arrayBuffer()));

    // Render slides (W×H) and store rects for pointer mapping
    const neededSlides = [...new Set(segs.map(s => s.slide))];
    const slideRectByNum = new Map();

    setExportStatus(`Rasterizing ${neededSlides.length} slide(s)...`);
    for (let i = 0; i < neededSlides.length; i++) {
      const s = neededSlides[i];
      const { png, rect } = await renderSlidePngAndRect(s, W, H);
      await ffmpeg.writeFile(safeSlideName(s), png);
      slideRectByNum.set(s, rect);
      if (i % 2 === 0) setExportStatus(`Rasterizing slides... (${i + 1}/${neededSlides.length})`);
    }

    setExportStatus(`Encoding segments... (0/${segs.length})`);
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const t = seg.len.toFixed(3);
      const slidePng = safeSlideName(seg.slide);
      const outSeg = safeSegName(i);

      const rect = slideRectByNum.get(seg.slide);

      if (pointerEnabled && rect) {
        setExportStatus(`Segment ${i + 1}/${segs.length}: rendering pointer overlay @ ${ovFps} fps...`);
        const frames = await writePointerOverlayFrames(ffmpeg, seg, W, H, rect, ovFps);

        await ffmpeg.exec([
          "-y",
          "-loop", "1", "-i", slidePng,
          "-framerate", String(ovFps), "-i", "ov_%06d.png",
          "-t", t,
          "-filter_complex", "[0:v][1:v]overlay=0:0:format=auto",
          "-r", String(outFps),
          "-c:v", "libx264",
          "-pix_fmt", "yuv420p",
          "-preset", "veryfast",
          "-crf", "20",
          outSeg,
        ]);

        await deleteOverlayFrames(ffmpeg, frames);
      } else {
        await ffmpeg.exec([
          "-y",
          "-loop", "1", "-i", slidePng,
          "-t", t,
          "-r", String(outFps),
          "-c:v", "libx264",
          "-pix_fmt", "yuv420p",
          "-preset", "veryfast",
          "-crf", "20",
          outSeg,
        ]);
      }

      if (i % 3 === 0) setExportStatus(`Encoding segments... (${i + 1}/${segs.length})`);
    }

    setExportStatus(`Concatenating segments...`);
    const concatTxt = segs.map((_, i) => `file ${safeSegName(i)}`).join("\n") + "\n";
    await ffmpeg.writeFile("concat.txt", new TextEncoder().encode(concatTxt));

    await ffmpeg.exec([
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", "concat.txt",
      "-c", "copy",
      "video.mp4",
    ]);

    setExportStatus(`Muxing audio...`);
    await ffmpeg.exec([
      "-y",
      "-i", "video.mp4",
      "-i", audioName,
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-shortest",
      "out.mp4",
    ]);

    setExportStatus(`<span class="ok">Finalizing...</span>`);
    const out = await ffmpeg.readFile("out.mp4");
    const blob = new Blob([out.buffer], { type: "video/mp4" });
    const url = URL.createObjectURL(blob);

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

/* ---------------------------
 * Init
 * --------------------------*/
renderMarksTable();
refreshControls();
setPointerEnabled(false);

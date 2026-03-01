// src/main.js
import "./style.css";

import WaveSurfer from "wavesurfer.js";
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
      <p class="muted">Upload audio + PDF. Space play/pause · Enter mark next slide (works even when paused). Optional pointer burn-in. Export MP4.</p>
    </header>

    <!-- hidden audio element (required) -->
    <audio id="audioEl" preload="metadata" style="display:none;"></audio>

    <div class="wrap">
      <div class="card">
        <div class="muted" style="font-weight:800; font-size:12px; letter-spacing:0.2px;">UPLOAD</div>

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
          <button id="markBtn" class="btn" disabled>Mark (Enter)</button>
          <button id="undoBtn" class="btn" disabled>Undo</button>
          <button id="jump1Btn" class="btn" disabled>Jump slide 1</button>
        </div>

        <div class="muted" style="margin-top:12px; font-weight:800; font-size:12px;">
          TIMESTAMPS
        </div>
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

let pdfDoc = null;
let pageCount = 0;
let currentSlide = 1;

// Each mark: at time t, switch to slide = slide
const marks = []; // { slide: number, t: number }

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
  $("jump1Btn").disabled = !ready;
  $("exportBtn").disabled = !ready;
}

function renderMarksTable() {
  if (!marks.length) {
    $("marksTable").innerHTML = `<span class="muted">No marks yet. Press Enter to mark switch to next slide.</span>`;
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
  if (!on) {
    pointerPos = null;
  }
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
 *  Timeline mark / undo
 *  --------------------------*/
function doMark() {
  if (!canInteract()) return;
  if (currentSlide >= pageCount) return;

  const nextSlide = currentSlide + 1;
  const t = clampTime(audioEl.currentTime || 0, audioEl.duration || 0);

  const last = marks[marks.length - 1];
  if (last && t < last.t) {
    showError(new Error("Timestamp must be >= previous mark time."));
    return;
  }

  marks.push({ slide: nextSlide, t });
  renderMarksTable();

  renderSlide(nextSlide).catch(showError);
}

function doUndo() {
  if (!marks.length) return;
  const removed = marks.pop();
  renderMarksTable();

  const backTo = Math.max(1, (removed.slide || 2) - 1);
  renderSlide(backTo).catch(showError);
}

/** ---------------------------
 *  Audio + waveform
 *  --------------------------*/
$("audioInput").addEventListener("change", async (e) => {
  try {
    const f = e.target.files?.[0];

    // BUGFIX #3: cancel -> keep current file/state
    if (!f) return;

    audioFile = f;
    const url = URL.createObjectURL(f);
    audioEl.src = url;
    audioEl.load();

    if (wavesurfer) wavesurfer.destroy();
    wavesurfer = WaveSurfer.create({
      container: "#waveform",
      height: 120,
      normalize: true,
      media: audioEl,
      waveColor: "rgba(47,128,237,0.30)",
      progressColor: "rgba(47,128,237,0.80)",
      cursorColor: "rgba(17,24,39,0.55)",
    });

    await wavesurfer.load(url);

    audioEl.onloadedmetadata = () => {
      $("tDur").textContent = fmtTime(audioEl.duration);
      refreshControls();
    };

    // BUGFIX #2: prevent Enter reopening file dialog (remove focus)
    $("audioInput").blur();
    // Optional: allow selecting same file again later
    e.target.value = "";

    refreshControls();
  } catch (err) {
    showError(err);
  }
});

$("pdfInput").addEventListener("change", async (e) => {
  try {
    const f = e.target.files?.[0];

    // BUGFIX #3: cancel -> keep current file/state
    if (!f) return;

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

    // reset marks + pointer logs when new PDF loads
    marks.length = 0;
    pointerEvents.length = 0;
    pointerPos = null;
    renderMarksTable();

    await renderSlide(1);
    refreshControls();

    // BUGFIX #2: prevent Enter reopening file dialog (remove focus)
    $("pdfInput").blur();
    e.target.value = "";
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

$("jump1Btn").addEventListener("click", () => {
  if (!canInteract()) return;
  renderSlide(1).catch(showError);
});

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

// BUGFIX #2: prevent Enter/Space on file inputs from bubbling to global handler / reopening picker
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
  requestAnimationFrame(tick);
})();

/** ---------------------------
 *  FFmpeg loading (local core) — BUGFIX #1 for GitHub Pages
 *  Use BASE_URL so it works under /<repo>/ on Pages.
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
 *  Export scheduling (fast, segmented)
 *  --------------------------*/
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

async function renderSlidePngBytes(slideNum, targetW, targetH) {
  const page = await pdfDoc.getPage(slideNum);

  const vp1 = page.getViewport({ scale: 1 });
  const scale = Math.min(targetW / vp1.width, targetH / vp1.height);
  const vp = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext("2d", { alpha: false });

  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvasContext: ctx, viewport: vp }).promise;

  const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
  if (!blob) throw new Error("Failed to encode slide PNG.");
  return await blobToU8(blob);
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

$("exportBtn").addEventListener("click", async () => {
  try {
    if (!canInteract()) throw new Error("Load audio and PDF first.");

    if (pointerEnabled) {
      throw new Error(
        "Pointer burn-in export is disabled for long videos in fast mode. Turn off Pointer burn-in to export. (We can add a separate 'real-time record' export mode next.)"
      );
    }

    const segs = buildSchedule();
    if (!segs.length) {
      throw new Error(
        "No scheduled segments. Press Enter at least once to schedule slide 2."
      );
    }

    const [W, H] = $("resSel").value.split("x").map(Number);
    const fps = 30;

    setExportStatus(`Loading FFmpeg...`);
    const ffmpeg = new FFmpeg();
    await loadFFmpeg(ffmpeg);

    setExportStatus(`Preparing audio...`);
    const audioName = getAudioInputName(audioFile);
    const audioBytes = new Uint8Array(await audioFile.arrayBuffer());
    await ffmpeg.writeFile(audioName, audioBytes);

    const neededSlides = [...new Set(segs.map((s) => s.slide))];
    setExportStatus(`Rasterizing ${neededSlides.length} slide(s) to PNG...`);
    for (let i = 0; i < neededSlides.length; i++) {
      const slideNum = neededSlides[i];
      const png = await renderSlidePngBytes(slideNum, W, H);
      await ffmpeg.writeFile(safeSlideName(slideNum), png);
      if (i % 2 === 0) setExportStatus(`Rasterizing slides... (${i + 1}/${neededSlides.length})`);
    }

    setExportStatus(`Encoding segments... (0/${segs.length})`);
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const slidePng = safeSlideName(seg.slide);
      const outSeg = safeSegName(i);
      const t = seg.len.toFixed(3);

      const vf = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black`;

      await ffmpeg.exec([
        "-y",
        "-loop",
        "1",
        "-i",
        slidePng,
        "-t",
        t,
        "-r",
        String(fps),
        "-vf",
        vf,
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

      if (i % 5 === 0) setExportStatus(`Encoding segments... (${i + 1}/${segs.length})`);
    }

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

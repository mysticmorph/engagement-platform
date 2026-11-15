import { FaceLandmarker, FilesetResolver } from "./lib/vision_bundle.mjs";

// ---------- Settings (tune here) ----------
// Files are bundled in lib/ so the extension works offline and passes MV3 CSP.
const MODEL_PATH = "lib/face_landmarker.task";
const WASM_PATH  = "lib/wasm";
const BLINK_CLOSED    = 0.5;   // blendshape value above which an eye counts as closed
const SLEEP_MS        = 2000;  // eyes continuously closed this long => SLEEPING
const PERCLOS_LIMIT   = 0.15;  // share of closed-eye frames in last 60 s => DROWSY
const AWAY_MS         = 1500;  // looking away this long => DISTRACTED
const ABSENT_MS       = 2000;  // no face this long => ABSENT
const YAW_LIMIT       = 0.15;  // head turn (relative to calibrated forward) that counts as looking away
const PITCH_LIMIT     = 0.10;  // head tilt (relative to calibrated forward) that counts as looking away
const DETECT_EVERY_MS = 100;   // ~10 detections per second

const STATES = ["FOCUSED", "DISTRACTED", "DROWSY", "SLEEPING", "ABSENT"];
const LABELS = { FOCUSED: "Focused", DISTRACTED: "Distracted", DROWSY: "Drowsy", SLEEPING: "Sleeping", ABSENT: "Absent" };
const COLORS = { FOCUSED: "#22c55e", DISTRACTED: "#f59e0b", DROWSY: "#f97316", SLEEPING: "#ef4444", ABSENT: "#64748b" };
const SCORE  = { FOCUSED: 100, DISTRACTED: 40, DROWSY: 25, SLEEPING: 0, ABSENT: 0 };

// ---------- State ----------
const $ = id => document.getElementById(id);
const video = $("video");
let landmarker = null, stream = null, running = false, rafId = null, sampleTimer = null;
let lastDetect = 0, lastVideoTime = -1;
let blink = 0, rawYaw = 0, rawPitch = 0, faceVisible = false;
let lastFaceTime = 0, closedStart = null, awayStart = null;
let frames = [];                       // {t, closed} for PERCLOS window
let baseline = { yaw: 0, pitch: 0.5 }; // default "forward" until calibrated
let calibrating = false, calibSamples = [];
let current = "ABSENT";
let history = [];                      // {t, state, score} sampled once per second
let counts = Object.fromEntries(STATES.map(s => [s, 0]));
let chartStates = [];

// ---------- Chart ----------
const chart = new Chart($("chart"), {
  type: "line",
  data: { labels: [], datasets: [{ label: "Attention", data: [], borderWidth: 2, pointRadius: 0, tension: 0, stepped: true,
    segment: { borderColor: c => COLORS[chartStates[c.p1DataIndex]] || "#60a5fa" } }] },
  options: { animation: false, responsive: true, maintainAspectRatio: false,
    scales: { y: { min: 0, max: 100, ticks: { color: "#8a94ab" }, grid: { color: "#262f45" } },
              x: { ticks: { color: "#8a94ab", maxTicksLimit: 6 }, grid: { display: false } } },
    plugins: { legend: { display: false } } }
});

// ---------- Helpers ----------
const hasExtension = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id;

// Tell the background worker so it can update the badge on Meet/Zoom tabs.
function notifyBadge(state) {
  if (!hasExtension) return;
  chrome.runtime.sendMessage({
    type: "state", state, label: LABELS[state], score: SCORE[state], color: COLORS[state]
  }).catch(() => {});
}

// ---------- Upload per-minute data to the attendance server (no video, counts only) ----------
// Address of the attendance server. Enter the host laptop's IP, e.g. 192.168.1.20:3000.
function serverBase() {
  let v = ($("serverUrl").value || "localhost:3000").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(v)) v = "http://" + v;
  return v;
}
const MINUTE_MS = 60000;
let session = null;           // {meetingId, name, platform} for the current run
let bucket = null;            // counts for the minute in progress
let prevState = null;         // to count sleep/drowsy episodes once each
let uploadQueue = [];         // completed minutes waiting to be sent
let uploadSending = false, retryTimer = null, savedMinutes = 0;

// Stable anonymous ID for this browser (not an account or email).
const attendeeId = (() => {
  let id = localStorage.getItem("attnId");
  if (!id) { id = crypto.randomUUID(); localStorage.setItem("attnId", id); }
  return id;
})();

function setUploadStatus(text) {
  $("uploadMsg").textContent = text || (savedMinutes ? `Saved to server: ${savedMinutes} minute(s)` : "");
}

// Read the meeting ID from the active Meet or Zoom tab.
async function detectMeeting() {
  if (!hasExtension) return null;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || "";
  let m = url.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
  if (m) return m[1].toLowerCase();
  m = url.match(/zoom\.us\/(?:j|wc)\/(\d{9,11})/i);
  return m ? m[1] : null;
}

function recordForUpload(t, state) {
  if (!session) return;
  const minute = Math.floor(t / MINUTE_MS) * MINUTE_MS;
  if (!bucket || bucket.minute !== minute) {
    queueBucket();
    bucket = { minute, seconds: Object.fromEntries(STATES.map(s => [s, 0])), sleepEpisodes: 0, drowsyEpisodes: 0 };
  }
  bucket.seconds[state]++;
  if (state !== prevState) {
    if (state === "SLEEPING") bucket.sleepEpisodes++;
    if (state === "DROWSY") bucket.drowsyEpisodes++;
  }
  prevState = state;
}

// Move the finished minute into the upload queue.
function queueBucket() {
  if (!bucket || !session) { bucket = null; return; }
  const b = bucket;
  bucket = null;
  if (STATES.every(s => b.seconds[s] === 0)) return;
  if (uploadQueue.length > 500) uploadQueue.shift(); // keep memory bounded if the server stays down
  uploadQueue.push({
    meetingId: session.meetingId, platform: session.platform, attendeeId, name: session.name,
    minuteStart: b.minute, seconds: b.seconds,
    sleepEpisodes: b.sleepEpisodes, drowsyEpisodes: b.drowsyEpisodes,
    batchId: crypto.randomUUID()   // same ID on every retry, so the server never counts a minute twice
  });
  sendQueue();
}

async function sendQueue() {
  if (uploadSending) return;
  uploadSending = true;
  while (uploadQueue.length) {
    const item = uploadQueue[0];
    try {
      const r = await fetch(`${serverBase()}/api/attendance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item)
      });
      if (r.status >= 400 && r.status < 500) {
        console.warn("Server rejected a minute and it was dropped:", r.status);   // bad data, retrying will not help
      } else if (!r.ok) {
        throw new Error(`HTTP ${r.status}`);
      } else {
        savedMinutes++;
      }
      uploadQueue.shift();
      setUploadStatus();
    } catch (e) {
      setUploadStatus(`Server not reachable, retrying (${uploadQueue.length} minute(s) waiting)`);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(sendQueue, 10000);
      break;
    }
  }
  uploadSending = false;
}

function bsVal(list, name) { const c = list.find(x => x.categoryName === name); return c ? c.score : 0; }
function setMsg(text, warn = false) { const m = $("msg"); m.textContent = text; m.className = "msg" + (warn ? " warn" : ""); }

function createLandmarker(delegate) {
  return FilesetResolver.forVisionTasks(WASM_PATH).then(fileset => FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_PATH, delegate },
    runningMode: "VIDEO", numFaces: 1, outputFaceBlendshapes: true
  }));
}

// ---------- Per-frame processing ----------
function processFrame(now) {
  const res = landmarker.detectForVideo(video, now);
  const t = Date.now();
  const lm = res.faceLandmarks && res.faceLandmarks[0];

  if (lm) {
    const bs = res.faceBlendshapes && res.faceBlendshapes[0] ? res.faceBlendshapes[0].categories : [];
    blink = (bsVal(bs, "eyeBlinkLeft") + bsVal(bs, "eyeBlinkRight")) / 2;

    // Head pose from landmarks: nose (1) vs eye corners (33, 263) and chin (152)
    const L = lm[33], R = lm[263], N = lm[1], C = lm[152];
    const midX = (L.x + R.x) / 2, midY = (L.y + R.y) / 2;
    const eyeDist = Math.hypot(R.x - L.x, R.y - L.y) || 1;
    rawYaw = (N.x - midX) / eyeDist;
    rawPitch = (N.y - midY) / ((C.y - midY) || 1);

    faceVisible = true;
    lastFaceTime = t;
    const closed = blink > BLINK_CLOSED;
    closedStart = closed ? (closedStart ?? t) : null;
    const away = Math.abs(rawYaw - baseline.yaw) > YAW_LIMIT || Math.abs(rawPitch - baseline.pitch) > PITCH_LIMIT;
    awayStart = away ? (awayStart ?? t) : null;
    frames.push({ t, closed });
    if (calibrating) calibSamples.push({ yaw: rawYaw, pitch: rawPitch });
  } else {
    // Keep closedStart so a head that drops out of view with eyes shut still reads as sleeping
    faceVisible = false;
    awayStart = null;
  }

  while (frames.length && t - frames[0].t > 60000) frames.shift();
  current = classify(t);
  updateCard();
}

function classify(t) {
  const sinceFace = t - lastFaceTime;
  const eyesClosedNow = closedStart !== null && sinceFace < 5000;
  if (eyesClosedNow && t - closedStart >= SLEEP_MS) return "SLEEPING";
  if (sinceFace > ABSENT_MS) return "ABSENT";
  const span = frames.length ? frames[frames.length - 1].t - frames[0].t : 0;
  if (eyesClosedNow || (span >= 15000 && perclosNow() >= PERCLOS_LIMIT)) return "DROWSY";
  if (faceVisible && awayStart !== null && t - awayStart >= AWAY_MS) return "DISTRACTED";
  return "FOCUSED";
}

function perclosNow() {
  return frames.length ? frames.filter(f => f.closed).length / frames.length : 0;
}

function updateCard() {
  const st = current;
  $("curState").textContent = LABELS[st];
  $("curState").style.color = COLORS[st];
  $("badge").textContent = LABELS[st].toUpperCase();
  $("badge").style.background = COLORS[st];
  $("curScore").textContent = SCORE[st];
  $("mFace").textContent = faceVisible ? "Yes" : "No";
  $("mBlink").textContent = faceVisible ? Math.round(blink * 100) + "%" : "--";
  $("mPerclos").textContent = Math.round(perclosNow() * 100) + "%";
  $("mYaw").textContent = faceVisible ? (rawYaw - baseline.yaw).toFixed(2) : "--";
  $("mPitch").textContent = faceVisible ? (rawPitch - baseline.pitch).toFixed(2) : "--";
}

// ---------- Once-per-second sampling, chart, matrix, summary ----------
function sample() {
  const t = Date.now();
  history.push({ t, state: current, score: SCORE[current] });
  if (history.length > 36000) history.shift();
  counts[current]++;
  renderChart();
  renderMatrix(t);
  renderSummary();
  notifyBadge(current);
  recordForUpload(t, current);
}

function renderChart() {
  const recent = history.slice(-300);
  chartStates = recent.map(h => h.state);
  chart.data.labels = recent.map(h => new Date(h.t).toLocaleTimeString());
  chart.data.datasets[0].data = recent.map(h => h.score);
  chart.update("none");
}

function renderMatrix(now) {
  const BUCKET = 10000, N = 30, start = now - BUCKET * N;
  const buckets = Array.from({ length: N }, () => ({}));
  for (const h of history) {
    if (h.t < start) continue;
    const i = Math.min(N - 1, Math.floor((h.t - start) / BUCKET));
    buckets[i][h.state] = (buckets[i][h.state] || 0) + 1;
  }
  let html = '<table class="matrix"><tbody>';
  for (const s of STATES) {
    html += `<tr><th>${LABELS[s]}</th>`;
    for (const b of buckets) {
      let dom = null, best = 0;
      for (const k in b) if (b[k] > best) { best = b[k]; dom = k; }
      html += `<td style="${dom === s ? "background:" + COLORS[s] : ""}"></td>`;
    }
    html += "</tr>";
  }
  $("matrix").innerHTML = html + "</tbody></table>";
}

function renderSummary() {
  const total = history.length || 1;
  const avg = history.reduce((a, h) => a + h.score, 0) / total;
  $("mAvg").textContent = history.length ? Math.round(avg) : "--";
  let html = "<tr><th>State</th><th>Time</th><th>Share</th></tr>";
  for (const s of STATES) {
    const secs = counts[s];
    html += `<tr><td><i class="dot" style="background:${COLORS[s]}"></i>${LABELS[s]}</td>
             <td>${fmt(secs)}</td><td>${Math.round(secs / total * 100)}%</td></tr>`;
  }
  $("summary").innerHTML = html;
}

function fmt(sec) { const m = Math.floor(sec / 60), s = sec % 60; return `${m}m ${String(s).padStart(2, "0")}s`; }

// ---------- Loop ----------
function loop(now) {
  if (!running) return;
  if (video.readyState >= 2 && video.currentTime !== lastVideoTime && now - lastDetect >= DETECT_EVERY_MS) {
    lastVideoTime = video.currentTime;
    lastDetect = now;
    try { processFrame(now); } catch (e) { console.error(e); }
  }
  rafId = requestAnimationFrame(loop);
}

// ---------- Controls ----------
$("btnStart").onclick = async () => {
  if (running) return stop();
  const meetingId = $("meetingId").value.trim();
  const name = $("nameInput").value.trim();
  if (!/^[A-Za-z0-9-]{3,64}$/.test(meetingId)) return setMsg("Enter the meeting ID, or open the Meet or Zoom tab first.", true);
  if (!name) return setMsg("Enter your name so the host sees you in the report.", true);
  localStorage.setItem("attnName", name);
  localStorage.setItem("attnServer", $("serverUrl").value.trim());
  session = { meetingId, name, platform: /^\d+$/.test(meetingId) ? "zoom" : "meet" };
  bucket = null;
  prevState = null;
  savedMinutes = 0;
  setUploadStatus("");
  const btn = $("btnStart");
  btn.disabled = true;
  try {
    setMsg("Loading face model...");
    try { landmarker = await createLandmarker("GPU"); }
    catch { landmarker = await createLandmarker("CPU"); }

    setMsg("Requesting camera...");
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
    video.srcObject = stream;
    await video.play();

    running = true;
    lastFaceTime = Date.now();
    frames = [];
    closedStart = awayStart = null;
    sampleTimer = setInterval(sample, 1000);
    rafId = requestAnimationFrame(loop);
    btn.textContent = "Stop camera";
    $("btnCalib").disabled = false;
    $("btnExport").disabled = false;
    setMsg(hasExtension ? "Monitoring. Badge is shown on open Meet/Zoom tabs." : "Monitoring. Your video stays on this device.");
  } catch (e) {
    console.error(e);
    setMsg("Could not start: " + (e.message || e) + ". Check camera permission and that no other app is holding the webcam.", true);
    stop();
  } finally {
    btn.disabled = false;
  }
};

function stop() {
  running = false;
  queueBucket();   // send the partial minute before stopping
  cancelAnimationFrame(rafId);
  clearInterval(sampleTimer);
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
  video.srcObject = null;
  $("btnStart").textContent = "Start camera";
  $("btnCalib").disabled = true;
  current = "ABSENT";
  $("curState").textContent = "Stopped";
  $("curState").style.color = COLORS.ABSENT;
  $("badge").textContent = "OFF";
  $("badge").style.background = COLORS.ABSENT;
}

$("btnCalib").onclick = () => {
  if (!running || calibrating) return;
  calibrating = true;
  calibSamples = [];
  setMsg("Calibrating: look straight at the screen with eyes open for 4 seconds...");
  setTimeout(() => {
    calibrating = false;
    if (calibSamples.length >= 10) {
      baseline = {
        yaw: calibSamples.reduce((a, s) => a + s.yaw, 0) / calibSamples.length,
        pitch: calibSamples.reduce((a, s) => a + s.pitch, 0) / calibSamples.length
      };
      $("calibInfo").textContent = `Calibrated. Forward position: yaw ${baseline.yaw.toFixed(2)}, pitch ${baseline.pitch.toFixed(2)}.`;
      setMsg("Calibration done.");
    } else {
      setMsg("No face seen during calibration. Sit in front of the camera and try again.", true);
    }
  }, 4000);
};

$("btnExport").onclick = () => {
  const rows = ["timestamp,state,score", ...history.map(h => `${new Date(h.t).toISOString()},${h.state},${h.score}`)];
  const blob = new Blob([rows.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `attention-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// Pre-fill the meeting ID from the open Meet/Zoom tab and the name from last time.
$("nameInput").value = localStorage.getItem("attnName") || "";
$("serverUrl").value = localStorage.getItem("attnServer") || "localhost:3000";
detectMeeting().then(id => { if (id && !$("meetingId").value) $("meetingId").value = id; }).catch(() => {});

renderMatrix(Date.now());
renderSummary();

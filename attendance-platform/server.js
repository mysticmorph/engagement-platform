import express from "express";
import mongoose from "mongoose";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Meeting, Bucket, Host } from "./src/models.js";
import { STATES, buildReport, buildTimeline } from "./src/report.js";
import {
  SESSION_HOURS, verifyPassword, createSession, deleteSession, sessionCookie, currentToken, requireHost
} from "./src/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/attention";

const MEETING_ID = /^[A-Za-z0-9-]{3,64}$/;
const ATTENDEE_ID = /^[A-Za-z0-9-]{8,64}$/;
const BATCH_ID = /^[A-Za-z0-9-]{8,64}$/;
const MINUTE_MS = 60000;

const app = express();
app.use(express.json({ limit: "100kb" }));

// CORS for the extension and the local host site. Extensions with host permission
// are not blocked anyway; this keeps the API usable from other local pages.
const ALLOWED_ORIGIN = /^(chrome-extension|moz-extension):\/\/|^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
app.use("/api", (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGIN.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const toInt = (v, max) => {
  const n = Number(v ?? 0);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
};

// ---- Ingest: one call per attendee per minute (from the extension). Open to the extension, no host login. ----
app.post("/api/attendance", async (req, res) => {
  try {
    const b = req.body || {};
    const meetingId = String(b.meetingId || "").trim();
    const attendeeId = String(b.attendeeId || "").trim();
    const batchId = String(b.batchId || "").trim();
    const name = (String(b.name || "").trim().slice(0, 80)) || "Anonymous";
    const minuteStart = Number(b.minuteStart);

    if (!MEETING_ID.test(meetingId) || !ATTENDEE_ID.test(attendeeId) || !BATCH_ID.test(batchId)
        || !Number.isFinite(minuteStart)) {
      return res.status(400).json({ error: "invalid meetingId, attendeeId, batchId or minuteStart" });
    }

    const inc = {};
    let total = 0;
    for (const s of STATES) {
      const v = toInt(b.seconds?.[s], 60);
      if (v === null) return res.status(400).json({ error: `invalid seconds for ${s}` });
      inc[`seconds.${s}`] = v;
      total += v;
    }
    if (total > 60) return res.status(400).json({ error: "more than 60 seconds in one minute" });

    const sleepEpisodes = toInt(b.sleepEpisodes, 60);
    const drowsyEpisodes = toInt(b.drowsyEpisodes, 60);
    if (sleepEpisodes === null || drowsyEpisodes === null) {
      return res.status(400).json({ error: "invalid episode counts" });
    }

    const platform = b.platform === "zoom" ? "zoom" : "meet";
    const minute = new Date(Math.floor(minuteStart / MINUTE_MS) * MINUTE_MS);

    await Meeting.updateOne(
      { meetingId },
      { $setOnInsert: { meetingId, platform, createdAt: new Date() } },
      { upsert: true }
    ).catch(e => { if (e.code !== 11000) throw e; });

    try {
      await Bucket.updateOne(
        { meetingId, attendeeId, minuteStart: minute, batches: { $ne: batchId } },
        {
          $set: { name },
          $inc: { ...inc, sleepEpisodes, drowsyEpisodes },
          $push: { batches: { $each: [batchId], $slice: -50 } }
        },
        { upsert: true }
      );
    } catch (e) {
      // Same batch sent again (retry after a lost response): already counted, so treat as success.
      if (e.code !== 11000) throw e;
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server error" });
  }
});

// ---- Host login / logout / who am I ----
app.post("/api/host/login", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const host = username ? await Host.findOne({ username }).lean() : null;
    // Same message for unknown user and wrong password, so usernames cannot be guessed.
    if (!host || !verifyPassword(password, host.passwordHash)) {
      return res.status(401).json({ error: "Wrong username or password" });
    }
    const token = await createSession(host._id);
    res.setHeader("Set-Cookie", sessionCookie(token, SESSION_HOURS * 3600));
    res.json({ ok: true, username: host.username });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server error" });
  }
});

app.post("/api/host/logout", async (req, res) => {
  try {
    await deleteSession(currentToken(req));
    res.setHeader("Set-Cookie", sessionCookie("", 0));
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server error" });
  }
});

app.get("/api/host/me", requireHost, (req, res) => {
  res.json({ username: req.hostAccount.username });
});

// ---- Host report: overall + per attendee, for one meeting ID (host login required) ----
app.get("/api/meetings/:meetingId/report", requireHost, async (req, res) => {
  try {
    const meetingId = req.params.meetingId;
    if (!MEETING_ID.test(meetingId)) return res.status(400).json({ error: "invalid meeting ID" });
    const meeting = await Meeting.findOne({ meetingId }).lean();
    if (!meeting) return res.status(404).json({ error: "No data stored for this meeting ID" });
    const buckets = await Bucket.find({ meetingId }, { batches: 0 }).lean();
    res.json({ meetingId, platform: meeting.platform, ...buildReport(buckets) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server error" });
  }
});

// ---- Host report: one attendee's minute-by-minute timeline (host login required) ----
app.get("/api/meetings/:meetingId/attendees/:attendeeId", requireHost, async (req, res) => {
  try {
    const { meetingId, attendeeId } = req.params;
    if (!MEETING_ID.test(meetingId) || !ATTENDEE_ID.test(attendeeId)) {
      return res.status(400).json({ error: "invalid ID" });
    }
    const buckets = await Bucket.find({ meetingId, attendeeId }, { batches: 0 }).lean();
    if (!buckets.length) return res.status(404).json({ error: "No data for this attendee" });
    res.json({ meetingId, attendeeId, timeline: buildTimeline(buckets) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server error" });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, db: mongoose.connection.readyState === 1 ? "connected" : "not connected" });
});

// Unknown /api routes get JSON, not the HTML page.
app.use("/api", (req, res) => res.status(404).json({ error: "not found" }));

app.use(express.static(path.join(__dirname, "public")));

// Errors from middleware (e.g. login check) end up here.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "server error" });
});

// Only start listening when this file is run directly (tests import the app without starting it).
export { app, MONGODB_URI };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mongoose.connect(MONGODB_URI).then(() => {
    // Listen on all network interfaces so other laptops on the same network can reach this server.
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Host site and API on http://localhost:${PORT}`);
      const lan = Object.values(os.networkInterfaces()).flat()
        .filter(i => i && i.family === "IPv4" && !i.internal).map(i => i.address);
      console.log(lan.length
        ? `Other laptops can use: ${lan.map(ip => `${ip}:${PORT}`).join(" or ")}`
        : "No network address found. Other laptops cannot connect yet.");
    });
    console.log(`Connected to MongoDB at ${MONGODB_URI}`);
  }).catch(err => {
    console.error("Could not connect to MongoDB:", err.message);
    process.exit(1);
  });
}

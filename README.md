# Autonomous Meeting & Lecture Cognitive Engagement Platform

Two parts:

- `meeting-extension/`: Chrome/Edge extension. Runs a face-based attention monitor (Focused, Distracted, Drowsy, Sleeping, Absent) in a side panel, shows a badge on Google Meet and Zoom (web) tabs, and uploads per-minute counts to the server. Video never leaves the laptop.
- `attendance-platform/`: Node.js (Express) server with MongoDB. Stores per-minute counts per attendee, provides host login, and serves the host website with overall and per-attendee reports.

## Run the server

```bash
cd attendance-platform
npm install
MONGODB_URI="mongodb://127.0.0.1:27017/attention" npm start
node scripts/create-host.js yourname    # create a host login (run once)
npm test
```

Then open http://localhost:3000.

## Load the extension

Edge or Chrome: open the extensions page, turn on Developer mode, Load unpacked, select `meeting-extension/`.

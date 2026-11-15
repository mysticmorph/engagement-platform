import mongoose from "mongoose";

// One row per meeting ID.
const meetingSchema = new mongoose.Schema({
  meetingId: { type: String, required: true, unique: true },
  platform: { type: String, enum: ["meet", "zoom"], default: "meet" },
  createdAt: { type: Date, default: Date.now }
});

// One row per attendee per minute. Only counts of seconds per state are stored, never video or images.
// `batches` remembers which uploads were already applied, so a retried upload is not counted twice.
const bucketSchema = new mongoose.Schema({
  meetingId: { type: String, required: true },
  attendeeId: { type: String, required: true },
  name: { type: String, default: "Anonymous" },
  minuteStart: { type: Date, required: true },
  seconds: {
    FOCUSED: { type: Number, default: 0 },
    DISTRACTED: { type: Number, default: 0 },
    DROWSY: { type: Number, default: 0 },
    SLEEPING: { type: Number, default: 0 },
    ABSENT: { type: Number, default: 0 }
  },
  sleepEpisodes: { type: Number, default: 0 },
  drowsyEpisodes: { type: Number, default: 0 },
  batches: { type: [String], default: [] }
});
bucketSchema.index({ meetingId: 1, attendeeId: 1, minuteStart: 1 }, { unique: true });
bucketSchema.index({ meetingId: 1 });

// Host accounts who may view reports.
const hostSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true, lowercase: true },
  passwordHash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

// Login sessions. Only a hash of the token is stored; expired rows are removed automatically.
const sessionSchema = new mongoose.Schema({
  tokenHash: { type: String, required: true, unique: true },
  hostId: { type: mongoose.Schema.Types.ObjectId, required: true },
  expiresAt: { type: Date, required: true }
});
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Meeting = mongoose.model("Meeting", meetingSchema);
export const Bucket = mongoose.model("Bucket", bucketSchema);
export const Host = mongoose.model("Host", hostSchema);
export const Session = mongoose.model("Session", sessionSchema);

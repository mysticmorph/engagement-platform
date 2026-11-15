// Host accounts: scrypt password hashes and server-side login sessions.
// The browser only holds a random session token in an HttpOnly cookie.
import crypto from "node:crypto";
import { Host, Session } from "./models.js";

export const SESSION_HOURS = 8;
const COOKIE = "host_session";

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const [alg, salt, hash] = String(stored || "").split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = crypto.scryptSync(String(password), salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");

export async function createSession(hostId) {
  const token = crypto.randomBytes(32).toString("base64url");
  await Session.create({
    tokenHash: sha256(token),
    hostId,
    expiresAt: new Date(Date.now() + SESSION_HOURS * 3600 * 1000)
  });
  return token;
}

export async function deleteSession(token) {
  if (token) await Session.deleteOne({ tokenHash: sha256(token) });
}

export function readCookie(req, name) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function sessionCookie(value, maxAgeSeconds) {
  // Set COOKIE_SECURE=1 when the site is served over HTTPS.
  const secure = process.env.COOKIE_SECURE === "1" ? "; Secure" : "";
  return `${COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

export function currentToken(req) {
  return readCookie(req, COOKIE);
}

// Express middleware: only logged-in hosts get past this.
export async function requireHost(req, res, next) {
  try {
    const token = currentToken(req);
    if (!token) return res.status(401).json({ error: "Log in as a host to view reports" });
    const session = await Session.findOne({ tokenHash: sha256(token), expiresAt: { $gt: new Date() } }).lean();
    if (!session) return res.status(401).json({ error: "Session expired. Log in again." });
    req.hostAccount = await Host.findById(session.hostId).lean();
    if (!req.hostAccount) return res.status(401).json({ error: "Log in as a host to view reports" });
    next();
  } catch (err) {
    next(err);
  }
}

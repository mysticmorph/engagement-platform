// Create a host account:  node scripts/create-host.js <username>
// You are asked for the password. Set MONGODB_URI first if not using the default local database.
import readline from "node:readline";
import mongoose from "mongoose";
import { Host } from "../src/models.js";
import { hashPassword } from "../src/auth.js";

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/attention";
const username = (process.argv[2] || "").trim().toLowerCase();

if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
  console.error("Usage: node scripts/create-host.js <username>   (3-40 letters, digits, . _ -)");
  process.exit(1);
}

// Hide the password while typing.
function ask(question, hidden) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = s => { if (!muted) rl.output.write(s); };
    rl.question(question, answer => { rl.close(); process.stdout.write("\n"); resolve(answer); });
    muted = hidden;
  });
}

await mongoose.connect(MONGODB_URI);
try {
  const password = await ask("Password (at least 10 characters): ", true);
  if (password.length < 10) {
    console.error("Password too short.");
    process.exitCode = 1;
  } else if (await Host.exists({ username })) {
    console.error(`Host "${username}" already exists.`);
    process.exitCode = 1;
  } else {
    await Host.create({ username, passwordHash: hashPassword(password) });
    console.log(`Created host "${username}".`);
  }
} finally {
  await mongoose.disconnect();
}

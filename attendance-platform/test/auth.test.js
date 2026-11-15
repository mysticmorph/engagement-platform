import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "../src/auth.js";

test("password hash verifies the right password only", () => {
  const stored = hashPassword("correct horse battery");
  assert.ok(stored.startsWith("scrypt$"));
  assert.equal(verifyPassword("correct horse battery", stored), true);
  assert.equal(verifyPassword("wrong password", stored), false);
  assert.equal(verifyPassword("", stored), false);
});

test("hashes use a fresh salt each time", () => {
  assert.notEqual(hashPassword("same-password-1"), hashPassword("same-password-1"));
});

test("malformed stored hash never verifies", () => {
  assert.equal(verifyPassword("x", "garbage"), false);
  assert.equal(verifyPassword("x", undefined), false);
});

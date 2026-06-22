import { expect, test } from "bun:test";
import { bindIsInsecure } from "../src/index.ts";

test("loopback binds are safe without TLS", () => {
	expect(bindIsInsecure("127.0.0.1", false)).toBe(false);
	expect(bindIsInsecure("localhost", false)).toBe(false);
	expect(bindIsInsecure("::1", false)).toBe(false);
});

test("non-loopback bind without TLS is insecure", () => {
	expect(bindIsInsecure("0.0.0.0", false)).toBe(true);
	expect(bindIsInsecure("192.168.1.5", false)).toBe(true);
});

test("non-loopback bind with TLS is safe", () => {
	expect(bindIsInsecure("0.0.0.0", true)).toBe(false);
});

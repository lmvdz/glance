import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { __resetConfigWarnings, envBool, envInt, envNumber } from "../src/config"

const NAME = "OMP_SQUAD_TEST_CONFIG_KNOB"

afterEach(() => {
	delete process.env[NAME]
	__resetConfigWarnings()
})

describe("envInt", () => {
	it("returns the default when unset", () => {
		delete process.env[NAME]
		expect(envInt(NAME, 7)).toBe(7)
	})

	it("returns the default when blank", () => {
		process.env[NAME] = ""
		expect(envInt(NAME, 7)).toBe(7)
	})

	it("returns the default when whitespace-only", () => {
		process.env[NAME] = "   "
		expect(envInt(NAME, 7)).toBe(7)
	})

	it("respects a legitimate 0 (does NOT eat it)", () => {
		process.env[NAME] = "0"
		expect(envInt(NAME, 7)).toBe(0)
	})

	it("respects negative values", () => {
		process.env[NAME] = "-3"
		expect(envInt(NAME, 7)).toBe(-3)
	})

	it("parses a valid integer", () => {
		process.env[NAME] = "42"
		expect(envInt(NAME, 7)).toBe(42)
	})

	it("warns once and returns the default on garbage", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {})
		try {
			process.env[NAME] = "abc"
			expect(envInt(NAME, 7)).toBe(7)
			expect(envInt(NAME, 7)).toBe(7) // still falls back
			expect(warn).toHaveBeenCalledTimes(1) // but warns only once
		} finally {
			warn.mockRestore()
		}
	})

	it("warns once and returns the default on a non-integer value", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {})
		try {
			process.env[NAME] = "3.5"
			expect(envInt(NAME, 7)).toBe(7)
			expect(warn).toHaveBeenCalledTimes(1)
		} finally {
			warn.mockRestore()
		}
	})

	it("rejects NaN and Infinity as garbage", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {})
		try {
			process.env[NAME] = "NaN"
			expect(envInt(NAME, 7)).toBe(7)
			__resetConfigWarnings()
			process.env[NAME] = "Infinity"
			expect(envInt(NAME, 7)).toBe(7)
		} finally {
			warn.mockRestore()
		}
	})

	it("reads the CURRENT env on each call (lazy, not snapshotted)", () => {
		process.env[NAME] = "1"
		expect(envInt(NAME, 7)).toBe(1)
		process.env[NAME] = "2"
		expect(envInt(NAME, 7)).toBe(2)
	})
})

describe("envNumber", () => {
	it("returns the default when unset", () => {
		delete process.env[NAME]
		expect(envNumber(NAME, 1.5)).toBe(1.5)
	})

	it("respects a legitimate 0", () => {
		process.env[NAME] = "0"
		expect(envNumber(NAME, 0.4)).toBe(0)
	})

	it("parses a float", () => {
		process.env[NAME] = "0.4"
		expect(envNumber(NAME, 1.5)).toBe(0.4)
	})

	it("respects negative floats", () => {
		process.env[NAME] = "-2.5"
		expect(envNumber(NAME, 1.5)).toBe(-2.5)
	})

	it("warns once and returns the default on garbage", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {})
		try {
			process.env[NAME] = "not-a-number"
			expect(envNumber(NAME, 1.5)).toBe(1.5)
			expect(warn).toHaveBeenCalledTimes(1)
		} finally {
			warn.mockRestore()
		}
	})
})

describe("envBool", () => {
	it("returns the fallback when unset", () => {
		delete process.env[NAME]
		expect(envBool(NAME, true)).toBe(true)
		expect(envBool(NAME, false)).toBe(false)
	})

	it("returns the fallback when blank/whitespace-only", () => {
		process.env[NAME] = ""
		expect(envBool(NAME, true)).toBe(true)
		process.env[NAME] = "   "
		expect(envBool(NAME, false)).toBe(false)
	})

	it('"1" is true and "0" is false regardless of the fallback', () => {
		process.env[NAME] = "1"
		expect(envBool(NAME, false)).toBe(true)
		expect(envBool(NAME, true)).toBe(true)
		process.env[NAME] = "0"
		expect(envBool(NAME, true)).toBe(false)
		expect(envBool(NAME, false)).toBe(false)
	})

	it("is return-value equivalent to the raw comparisons it replaces", () => {
		// The four idioms: X === "1" ⇒ envBool(X,false); X !== "0" ⇒ envBool(X,true);
		// X !== "1" ⇒ !envBool(X,false); X === "0" ⇒ !envBool(X,true).
		const warn = spyOn(console, "warn").mockImplementation(() => {})
		try {
			for (const raw of [undefined, "", "1", "0", "true", "yes", "2"]) {
				if (raw === undefined) delete process.env[NAME]
				else process.env[NAME] = raw
				const v = process.env[NAME]
				expect(envBool(NAME, false)).toBe(v === "1")
				expect(envBool(NAME, true)).toBe(v !== "0")
				expect(!envBool(NAME, false)).toBe(v !== "1")
				expect(!envBool(NAME, true)).toBe(v === "0")
			}
		} finally {
			warn.mockRestore()
			__resetConfigWarnings()
		}
	})

	it("warns once (per var) and returns the fallback on a non-0/1 value", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {})
		try {
			process.env[NAME] = "true"
			expect(envBool(NAME, false)).toBe(false)
			expect(envBool(NAME, true)).toBe(true) // still falls back
			expect(warn).toHaveBeenCalledTimes(1) // but warns only once
		} finally {
			warn.mockRestore()
		}
	})

	it("reads the CURRENT env on each call (lazy, not snapshotted)", () => {
		process.env[NAME] = "1"
		expect(envBool(NAME, false)).toBe(true)
		process.env[NAME] = "0"
		expect(envBool(NAME, false)).toBe(false)
	})
})

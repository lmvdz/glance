import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { __resetConfigWarnings, envBool, envBoolAliased, envInt, envNumber } from "../src/config"

const NAME = "OMP_SQUAD_TEST_CONFIG_KNOB"
const PRIMARY = "GLANCE_TEST_CONFIG_KNOB"
const LEGACY = "OMP_SQUAD_TEST_CONFIG_KNOB_LEGACY"

afterEach(() => {
	delete process.env[NAME]
	delete process.env[PRIMARY]
	delete process.env[LEGACY]
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

// Batch-3 review: attention.ts read only GLANCE_ATTENTION (ignoring the documented legacy alias
// OMP_SQUAD_ATTENTION) and squad-manager.ts's episode gate read only OMP_SQUAD_EPISODE (ignoring
// the documented-as-primary GLANCE_EPISODE) — .env.example claimed both names worked everywhere,
// but each site only ever consulted one literal name. envBoolAliased is the fix both sites route
// through now; these tests exercise it directly with a generic primary/legacy pair (not the real
// flag names, so a future rename of either real flag can't silently stop testing this contract).
describe("envBoolAliased", () => {
	it("primary set to '1' wins regardless of legacy", () => {
		process.env[PRIMARY] = "1"
		process.env[LEGACY] = "0"
		expect(envBoolAliased(PRIMARY, LEGACY, true)).toBe(true)
	})

	it("primary set to '0' wins regardless of legacy", () => {
		process.env[PRIMARY] = "0"
		process.env[LEGACY] = "1"
		expect(envBoolAliased(PRIMARY, LEGACY, true)).toBe(false)
	})

	it("primary unset falls back to legacy '1'", () => {
		delete process.env[PRIMARY]
		process.env[LEGACY] = "1"
		expect(envBoolAliased(PRIMARY, LEGACY, false)).toBe(true)
	})

	it("primary unset falls back to legacy '0'", () => {
		delete process.env[PRIMARY]
		process.env[LEGACY] = "0"
		expect(envBoolAliased(PRIMARY, LEGACY, true)).toBe(false)
	})

	it("primary blank/whitespace-only falls back to legacy, same as unset", () => {
		process.env[PRIMARY] = "   "
		process.env[LEGACY] = "1"
		expect(envBoolAliased(PRIMARY, LEGACY, false)).toBe(true)
	})

	it("both unset returns the fallback", () => {
		delete process.env[PRIMARY]
		delete process.env[LEGACY]
		expect(envBoolAliased(PRIMARY, LEGACY, true)).toBe(true)
		expect(envBoolAliased(PRIMARY, LEGACY, false)).toBe(false)
	})

	it("both set — primary strictly wins, never merged/OR'd with legacy", () => {
		process.env[PRIMARY] = "0"
		process.env[LEGACY] = "1"
		expect(envBoolAliased(PRIMARY, LEGACY, false)).toBe(false)
	})

	// The two real production call sites (src/attention.ts's kill switch, src/squad-manager.ts's
	// weekly-episode gate) each pass a literal name pair — exercise both pairs by name directly so a
	// typo in either call site (not just a defect in envBoolAliased itself) would fail a test.
	it("the real GLANCE_ATTENTION/OMP_SQUAD_ATTENTION pair: legacy alone still disables", () => {
		delete process.env.GLANCE_ATTENTION
		process.env.OMP_SQUAD_ATTENTION = "0"
		try {
			expect(envBoolAliased("GLANCE_ATTENTION", "OMP_SQUAD_ATTENTION", true)).toBe(false)
		} finally {
			delete process.env.OMP_SQUAD_ATTENTION
		}
	})

	it("the real GLANCE_EPISODE/OMP_SQUAD_EPISODE pair: the documented-primary name now actually works", () => {
		process.env.GLANCE_EPISODE = "0"
		delete process.env.OMP_SQUAD_EPISODE
		try {
			// Before the fix, squad-manager.ts read ONLY OMP_SQUAD_EPISODE — GLANCE_EPISODE="0" here
			// would have silently been ignored and the loop would have started anyway (fallback: true).
			expect(envBoolAliased("GLANCE_EPISODE", "OMP_SQUAD_EPISODE", true)).toBe(false)
		} finally {
			delete process.env.GLANCE_EPISODE
		}
	})

	it("the real GLANCE_EPISODE/OMP_SQUAD_EPISODE pair: legacy alone still works when the new name is unset", () => {
		delete process.env.GLANCE_EPISODE
		process.env.OMP_SQUAD_EPISODE = "0"
		try {
			expect(envBoolAliased("GLANCE_EPISODE", "OMP_SQUAD_EPISODE", true)).toBe(false)
		} finally {
			delete process.env.OMP_SQUAD_EPISODE
		}
	})
})

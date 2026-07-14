/**
 * osc-notify — the terminal-native attention lane (fleet-ide-bridge B01).
 * The load-bearing property: agent-controlled text can never forge an escape
 * sequence; each notification is exactly two well-formed OSC writes, and the
 * writer is inert when piped or flag-disabled. Everything is asserted through
 * writeOscNotify's injected stream — the chunks ARE the wire bytes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { writeOscNotify } from "../src/osc-notify.ts";

function fakeOut(isTTY: boolean): { isTTY: boolean; write(chunk: string): void; chunks: string[] } {
	const chunks: string[] = [];
	return {
		isTTY,
		chunks,
		write(chunk: string) {
			chunks.push(chunk);
		},
	};
}

function sequences(title: string, body: string): string[] {
	const out = fakeOut(true);
	expect(writeOscNotify(title, body, out)).toBe(true);
	return out.chunks;
}

describe("writeOscNotify sequences", () => {
	test("emits the two conventions with exact bytes", () => {
		expect(sequences("⛔ web-ui needs you", "waiting for input")).toEqual([
			"\x1b]777;notify;⛔ web-ui needs you;waiting for input\x07",
			"\x1b]9;⛔ web-ui needs you: waiting for input\x07",
		]);
	});

	test("empty body collapses the OSC 9 form to the title alone", () => {
		expect(sequences("done", "")).toEqual(["\x1b]777;notify;done;\x07", "\x1b]9;done\x07"]);
	});

	test("hostile fields cannot forge sequences: one ESC and one BEL per write, controls stripped", () => {
		const seqs = sequences("evil\x1b]777;notify;x;y\x07name", "body\x07\x1b[2Jwith\x9bcontrols\x00\x85");
		for (const seq of seqs) {
			expect(seq.startsWith("\x1b]")).toBe(true);
			expect(seq.endsWith("\x07")).toBe(true);
			// no ESC/BEL/C0/C1 anywhere inside the payload
			expect(seq.slice(2, -1)).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
		}
		// title semicolons became commas, so OSC 777's field count is stable
		expect(seqs[0]).toBe("\x1b]777;notify;evil]777,notify,x,yname;body[2Jwithcontrols\x07");
	});

	test("fields are capped", () => {
		const seqs = sequences("t".repeat(1000), "b".repeat(1000));
		expect(seqs[0].length).toBeLessThan(500);
	});
});

describe("writeOscNotify gating", () => {
	afterEach(() => {
		delete process.env.OMP_SQUAD_OSC_NOTIFY;
	});

	test("inert when piped", () => {
		const out = fakeOut(false);
		expect(writeOscNotify("t", "b", out)).toBe(false);
		expect(out.chunks).toHaveLength(0);
	});

	test("inert when OMP_SQUAD_OSC_NOTIFY=0", () => {
		process.env.OMP_SQUAD_OSC_NOTIFY = "0";
		const out = fakeOut(true);
		expect(writeOscNotify("t", "b", out)).toBe(false);
		expect(out.chunks).toHaveLength(0);
	});
});

import { describe, expect, it } from "vitest";
import { localDate, localDayBounds, localHour, utcOffsetMinutes } from "../src/time";

const TZ = "America/New_York";

describe("time helpers", () => {
	it("uses Huckleberry's offset sign convention across DST", () => {
		expect(utcOffsetMinutes(Date.UTC(2026, 9, 16, 12) / 1000, TZ)).toBe(240); // EDT
		expect(utcOffsetMinutes(Date.UTC(2026, 11, 1, 12) / 1000, TZ)).toBe(300); // EST
	});

	it("lands exactly one of the 21:00/22:00 UTC crons on 5pm Eastern, either side of DST", () => {
		// Fri Oct 30 (EDT) and Mon Nov 2 (EST); DST ends Sun Nov 1 2026.
		for (const [day, expectedUtcHour] of [[30, 21], [2 + 31, 22]]) {
			const fires = [21, 22].filter((h) => localHour(new Date(Date.UTC(2026, 9, day, h)), TZ) === 17);
			expect(fires).toEqual([expectedUtcHour]);
		}
		expect(localDate(new Date(Date.UTC(2026, 9, 30, 21)), TZ)).toBe("2026-10-30");
	});

	it("computes local day bounds", () => {
		expect(localDayBounds("2026-10-16", TZ)).toEqual([Date.UTC(2026, 9, 16, 4) / 1000, Date.UTC(2026, 9, 17, 4) / 1000]);
		// DST ends Nov 1 2026: a 25-hour day
		const [start, end] = localDayBounds("2026-11-01", TZ);
		expect(end - start).toBe(25 * 3600);
	});
});

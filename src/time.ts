/** Minutes to add to local time to reach UTC (Huckleberry's convention: 240 for EDT, -120 for UTC+2). */
export function utcOffsetMinutes(epochSeconds: number, timeZone: string): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(new Date(epochSeconds * 1000));
	const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
	const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
	return Math.round((epochSeconds * 1000 - asUtc) / 60_000);
}

/** The calendar date (YYYY-MM-DD) in `timeZone` at the given instant. */
export function localDate(at: Date, timeZone: string): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** Epoch-second bounds [start, end) of a local calendar date. */
export function localDayBounds(date: string, timeZone: string): [number, number] {
	const [y, m, d] = date.split("-").map(Number);
	const startGuess = Date.UTC(y, m - 1, d) / 1000;
	const endGuess = Date.UTC(y, m - 1, d + 1) / 1000;
	return [startGuess + utcOffsetMinutes(startGuess, timeZone) * 60, endGuess + utcOffsetMinutes(endGuess, timeZone) * 60];
}

/** The hour (0–23) in `timeZone` at the given instant. */
export function localHour(at: Date, timeZone: string): number {
	return Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(at));
}

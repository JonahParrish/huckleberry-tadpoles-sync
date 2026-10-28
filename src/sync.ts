import { double } from "./firestore";
import { HuckleberryClient, type Interval, type TrackerCollection } from "./huckleberry";
import { planReport, type PlannedEntry, type Skipped } from "./mapping";
import { TadpolesClient } from "./tadpoles";
import { localDayBounds, utcOffsetMinutes } from "./time";

/** How close a hand-entered Huckleberry event must be to count as the same event. */
const MANUAL_MATCH_WINDOW_SEC = 15 * 60;

export interface SyncResult {
	date: string;
	dryRun: boolean;
	reportFound: boolean;
	published: boolean;
	created: PlannedEntry[];
	alreadySynced: PlannedEntry[];
	alreadyLoggedManually: PlannedEntry[];
	skipped: Skipped[];
}

export async function syncDate(env: Env, date: string, dryRun: boolean): Promise<SyncResult> {
	const result: SyncResult = {
		date,
		dryRun,
		reportFound: false,
		published: false,
		created: [],
		alreadySynced: [],
		alreadyLoggedManually: [],
		skipped: [],
	};

	const tadpoles = new TadpolesClient(env.TADPOLES_EMAIL, env.TADPOLES_PASSWORD, env.TIMEZONE);
	await tadpoles.login();
	const [report] = await tadpoles.getDailyReports(date);
	if (!report) return result;
	result.reportFound = true;
	result.published = report.published;

	const plan = planReport(report);
	result.skipped = plan.skipped;

	const huckleberry = new HuckleberryClient(env.HUCKLEBERRY_EMAIL, env.HUCKLEBERRY_PASSWORD);
	await huckleberry.login();
	const childId = await huckleberry.getChildId();

	// Look a little past the day's edges so naps/diapers near midnight still match.
	const [dayStart, dayEnd] = localDayBounds(date, env.TIMEZONE);
	const existing: Record<TrackerCollection, Interval[]> = { diaper: [], feed: [], sleep: [] };
	for (const collection of Object.keys(existing) as TrackerCollection[]) {
		existing[collection] = await huckleberry.listIntervals(collection, childId, dayStart - 86_400, dayEnd + 86_400);
	}

	for (const entry of plan.entries) {
		const collection = collectionFor(entry);
		const id = await intervalId(entry);
		if (existing[collection].some((i) => i.id === id)) {
			result.alreadySynced.push(entry);
		} else if (existing[collection].some((i) => matchesManualEntry(entry, i))) {
			result.alreadyLoggedManually.push(entry);
		} else if (dryRun) {
			result.created.push(entry);
		} else if (await huckleberry.createInterval(collection, childId, id, intervalData(entry, env.TIMEZONE))) {
			result.created.push(entry);
		} else {
			result.alreadySynced.push(entry);
		}
	}

	// Free-plan Workers get 50 subrequests per run, so the app's "last diaper/bottle/sleep" summaries
	// are updated once per type, from the latest entry written, rather than after every entry.
	if (!dryRun) {
		const latestByKind = new Map(result.created.map((e) => [e.kind, e])); // entries are sorted by start
		for (const entry of latestByKind.values()) await updateLastPrefs(huckleberry, childId, entry, env.TIMEZONE);
	}
	return result;
}

function collectionFor(entry: PlannedEntry): TrackerCollection {
	return entry.kind === "diaper" ? "diaper" : entry.kind === "bottle" ? "feed" : "sleep";
}

function matchesManualEntry(entry: PlannedEntry, interval: Interval): boolean {
	const start = Number(interval.data.start);
	if (entry.kind === "sleep") {
		const end = start + Number(interval.data.duration ?? 0);
		return start < entry.end && end > entry.start; // overlapping sleep
	}
	if (entry.kind === "bottle" && interval.data.mode !== "bottle") return false;
	return Math.abs(start - entry.start) <= MANUAL_MATCH_WINDOW_SEC;
}

/**
 * Deterministic Huckleberry doc id derived from the Tadpoles entry id, in the same shape the app
 * uses ("<ms>-<20 hex>" for diapers/feeds, 16 hex for sleep), so re-running a day never duplicates.
 */
export async function intervalId(entry: PlannedEntry): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(`tadpoles:${entry.sourceId}`));
	const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
	return entry.kind === "sleep" ? hex.slice(0, 16) : `${entry.start * 1000}-${hex.slice(0, 20)}`;
}

function intervalData(entry: PlannedEntry, timeZone: string): Record<string, unknown> {
	const now = double(Date.now() / 1000);
	const offset = double(utcOffsetMinutes(entry.start, timeZone));
	switch (entry.kind) {
		case "diaper":
			return { start: double(entry.start), lastUpdated: now, mode: entry.mode, offset, notes: entry.notes };
		case "bottle":
			return {
				mode: "bottle",
				start: double(entry.start),
				lastUpdated: now,
				bottleType: entry.bottleType,
				amount: entry.amount == null ? undefined : double(entry.amount),
				units: entry.units,
				offset,
				end_offset: offset,
			};
		case "sleep":
			return {
				start: entry.start,
				duration: entry.end - entry.start,
				offset,
				end_offset: double(utcOffsetMinutes(entry.end, timeZone)),
				lastUpdated: now,
			};
	}
}

function updateLastPrefs(huckleberry: HuckleberryClient, childId: string, entry: PlannedEntry, timeZone: string): Promise<boolean> {
	const offset = double(utcOffsetMinutes(entry.start, timeZone));
	switch (entry.kind) {
		case "diaper":
			return huckleberry.updateLastPrefs("diaper", childId, "lastDiaper", { start: double(entry.start), mode: entry.mode, offset }, {}, entry.start);
		case "bottle": {
			const amount = entry.amount == null ? undefined : double(entry.amount);
			return huckleberry.updateLastPrefs(
				"feed",
				childId,
				"lastBottle",
				{ mode: "bottle", start: double(entry.start), bottleType: entry.bottleType, bottleAmount: amount, bottleUnits: entry.units, offset },
				{ bottleType: entry.bottleType, bottleAmount: amount, bottleUnits: entry.units },
				entry.start,
			);
		}
		case "sleep":
			return huckleberry.updateLastPrefs(
				"sleep",
				childId,
				"lastSleep",
				{ start: entry.start, duration: entry.end - entry.start, offset },
				{},
				entry.start,
			);
	}
}

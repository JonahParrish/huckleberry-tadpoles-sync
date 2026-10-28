import type { TadpolesDailyReport, TadpolesEntry } from "./tadpoles";

export type DiaperMode = "pee" | "poo" | "both" | "dry";
export type BottleType = "Breast Milk" | "Formula" | "Other";

export type PlannedEntry =
	| { kind: "diaper"; sourceId: string; start: number; mode: DiaperMode; notes?: string }
	| { kind: "bottle"; sourceId: string; start: number; amount?: number; units: "oz"; bottleType: BottleType }
	| { kind: "sleep"; sourceId: string; start: number; end: number };

export interface Skipped {
	sourceId: string;
	type: string;
	reason: "entered by parent" | "deleted" | "teacher note" | "unsupported";
	detail?: string;
}

export interface SyncPlan {
	entries: PlannedEntry[];
	skipped: Skipped[];
}

export function planReport(report: TadpolesDailyReport): SyncPlan {
	const plan: SyncPlan = { entries: [], skipped: [] };
	for (const entry of report.entries) {
		const skip = (reason: Skipped["reason"], detail?: string) =>
			plan.skipped.push({ sourceId: entry.id, type: entry.type_name, reason, detail });

		// Parent entries describe the night/morning at home, which is already tracked in Huckleberry.
		if (entry.parent) skip("entered by parent");
		else if (entry.deleted) skip("deleted");
		else if (entry.type_name === "activity") skip("teacher note");
		else {
			const planned = mapEntry(entry);
			if (typeof planned === "string") skip("unsupported", planned);
			else plan.entries.push(planned);
		}
	}
	plan.entries.sort((a, b) => a.start - b.start);
	return plan;
}

/** Returns the Huckleberry entry, or a description of why it can't be mapped. */
function mapEntry(entry: TadpolesEntry): PlannedEntry | string {
	switch (entry.type_name) {
		case "bathroom": {
			if (entry.bathroom_type !== "diaper") return `bathroom_type=${entry.bathroom_type}`;
			if (entry.action_time == null) return "missing time";
			const events = new Set(entry.event_ids ?? []);
			const wet = events.has("wet");
			const bm = events.has("bm");
			const mode: DiaperMode = wet && bm ? "both" : wet ? "pee" : bm ? "poo" : "dry";
			return {
				kind: "diaper",
				sourceId: entry.id,
				start: entry.action_time,
				mode,
				notes: events.has("diaper_cream") ? "Diaper cream" : undefined,
			};
		}
		case "food": {
			if (entry.meal_type !== "bottle") return `meal_type=${entry.meal_type}`;
			if (entry.action_time == null) return "missing time";
			return {
				kind: "bottle",
				sourceId: entry.id,
				start: entry.action_time,
				amount: entry.numeric_amount ?? entry.amount ?? undefined,
				units: "oz",
				bottleType: bottleType(entry.contents_id),
			};
		}
		case "nap": {
			if (entry.start_time == null || entry.end_time == null) return "nap missing start or end";
			if (entry.end_time < entry.start_time) return "nap ends before it starts";
			return { kind: "sleep", sourceId: entry.id, start: entry.start_time, end: entry.end_time };
		}
		default:
			return `type_name=${entry.type_name}`;
	}
}

function bottleType(contentsId: string | null | undefined): BottleType {
	// Blank contents are breast milk in practice.
	if (contentsId == null || contentsId === "breastmilk") return "Breast Milk";
	if (contentsId === "formula") return "Formula";
	return "Other";
}

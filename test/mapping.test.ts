import { describe, expect, it } from "vitest";
import { planReport } from "../src/mapping";
import type { TadpolesDailyReport } from "../src/tadpoles";
import fixture from "./fixtures/daily-report.json";

const report = fixture.payload.daily_reports[0] as unknown as TadpolesDailyReport;

describe("planReport", () => {
	const plan = planReport(report);

	it("skips the parent-entered drop-off entries", () => {
		const parentIds = report.entries.filter((e) => e.parent).map((e) => e.id);
		expect(parentIds).toHaveLength(3);
		for (const id of parentIds) {
			expect(plan.entries.find((e) => e.sourceId === id)).toBeUndefined();
			expect(plan.skipped).toContainEqual(expect.objectContaining({ sourceId: id, reason: "entered by parent" }));
		}
	});

	it("maps the daycare day", () => {
		expect(plan.entries.map((e) => e.kind)).toEqual([
			"diaper", "bottle", "sleep", "diaper", "bottle", "diaper", "sleep", "diaper", "bottle", "diaper", "sleep", "bottle", "diaper",
		]);
		expect(plan.skipped.filter((s) => s.reason === "teacher note")).toHaveLength(3);
		expect(plan.skipped.filter((s) => s.reason === "unsupported")).toHaveLength(0);
	});

	it("maps diaper events to Huckleberry modes", () => {
		const diapers = plan.entries.filter((e) => e.kind === "diaper");
		expect(diapers.map((d) => [d.mode, d.notes])).toEqual([
			["pee", undefined],
			["pee", undefined],
			["both", undefined],
			["pee", undefined],
			["both", "Diaper cream"],
			["both", "Diaper cream"],
		]);
	});

	it("defaults blank bottle contents to breast milk, in ounces", () => {
		const bottles = plan.entries.filter((e) => e.kind === "bottle");
		expect(bottles).toHaveLength(4);
		for (const b of bottles) expect(b).toMatchObject({ amount: 5, units: "oz", bottleType: "Breast Milk" });
	});

	it("maps naps to sleep intervals", () => {
		expect(plan.entries.filter((e) => e.kind === "sleep")).toEqual([
			{ kind: "sleep", sourceId: expect.any(String), start: 1781266260, end: 1781271000 },
			{ kind: "sleep", sourceId: expect.any(String), start: 1781278500, end: 1781280600 },
			{ kind: "sleep", sourceId: expect.any(String), start: 1781286960, end: 1781288940 },
		]);
	});

	it("reports unknown entry types instead of dropping them", () => {
		const solids = planReport({
			date: "2026-06-12",
			published: true,
			entries: [{ id: "x", type_name: "food", meal_type: "lunch", parent: false, deleted: false, action_time: 1, note: null }],
		});
		expect(solids.skipped).toEqual([{ sourceId: "x", type: "food", reason: "unsupported", detail: "meal_type=lunch" }]);
	});
});

import { safeDiagnostic, SyncFailure } from "../src/errors";
import { timingSafeEqual, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { syncDate } from "../src/sync";
import { notify } from "../src/notify";
import { HuckleberryClient } from "../src/huckleberry";
import { TadpolesClient } from "../src/tadpoles";

vi.mock("../src/sync", () => ({ syncDate: vi.fn() }));
const token = "a".repeat(64);
const env = { MANUAL_SYNC_ENABLED: "true", SYNC_TOKEN: token, TIMEZONE: "America/New_York", SYNC_HOUR: "17", NTFY_SERVER: "https://ntfy.sh", NTFY_TOPIC: "private" } as unknown as Env;
const result = { date: "2026-06-12", dryRun: true, reportFound: false, created: [], alreadySynced: [], alreadyLoggedManually: [], skipped: [] };
const request = (query = "", method = "GET", authorization = `Bearer ${token}`) => new Request(`https://worker.example/sync${query}`, { method, headers: { Authorization: authorization } });
const run = (req: Request, bindings = env) => worker.fetch(req as Parameters<typeof worker.fetch>[0], bindings);

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("crypto", { subtle: { digest: webcrypto.subtle.digest.bind(webcrypto.subtle), timingSafeEqual: (a: ArrayBuffer, b: ArrayBuffer) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b)) } });
	vi.mocked(syncDate).mockResolvedValue(result as any);
});
afterEach(() => vi.unstubAllGlobals());

describe("manual endpoint security", () => {
	it("disables manual access unless explicitly enabled", async () => {
		expect((await run(request(), { ...env, MANUAL_SYNC_ENABLED: undefined })).status).toBe(404);
		expect(syncDate).not.toHaveBeenCalled();
	});
	it.each(["", token, "Bearer wrong", `Basic ${token}`, `Bearer ${token} extra`])("rejects malformed or invalid authorization", async (header) => {
		const res = await run(request("", "GET", header));
		expect(res.status).toBe(401);
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		expect(syncDate).not.toHaveBeenCalled();
	});
	it("fails closed for short or missing configured tokens", async () => {
		for (const value of ["", "short"]) expect((await run(request(), { ...env, SYNC_TOKEN: value })).status).toBe(401);
	});
	it("requires POST for writes and rejects unsupported methods", async () => {
		for (const req of [request("?write=1"), request("", "HEAD"), request("", "DELETE")]) expect((await run(req)).status).toBe(405);
		expect(syncDate).not.toHaveBeenCalled();
		await run(request("?write=1&date=2026-06-12", "POST"));
		expect(syncDate).toHaveBeenCalledWith(env, "2026-06-12", false);
	});
	it("previews without writes and prevents caching detailed responses", async () => {
		const res = await run(request("?date=2026-06-12"));
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		expect(syncDate).toHaveBeenCalledWith(env, "2026-06-12", true);
	});
	it.each(["2026-02-30", "2026-13-01", "not-a-date"])("rejects invalid date %s", async (date) => {
		expect((await run(request(`?date=${date}`))).status).toBe(400);
		expect(syncDate).not.toHaveBeenCalled();
	});
	it("does not expose exception content in HTTP errors", async () => {
		vi.mocked(syncDate).mockRejectedValue(new Error("PRIVATE ACCOUNT DATA"));
		const res = await run(request());
		expect(res.status).toBe(502);
		expect(await res.text()).not.toContain("PRIVATE ACCOUNT DATA");
	});
});

describe("notification and error privacy", () => {
	it("uses TLS, authentication, no cache and no redirects for notification publishing", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
		vi.stubGlobal("fetch", fetchMock);
		await notify({ ...env, NTFY_TOKEN: "private-token" }, "title", "message");
		const init = fetchMock.mock.calls[0][1];
		expect(init.redirect).toBe("manual");
		expect(init.headers.get("Authorization")).toBe("Bearer private-token");
		expect(init.headers.get("Cache")).toBe("no");
		await expect(notify({ ...env, NTFY_SERVER: "http://example.com" } as any, "t", "m")).rejects.toThrow("HTTPS");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
	it("excludes upstream bodies from client errors", async () => {
		vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response("PRIVATE ACCOUNT DATA", { status: 403 })));
		for (const action of [() => new HuckleberryClient("e", "p").login(), () => new TadpolesClient("e", "p", "UTC").login(), () => notify(env, "t", "m")]) {
			await expect(action()).rejects.toThrow("403");
			await expect(action()).rejects.not.toThrow("PRIVATE ACCOUNT DATA");
		}
	});
	it("keeps detailed results out of scheduled logs and notifications by default", async () => {
		const fetchMock = vi.fn().mockImplementation(async () => new Response("ok"));
		vi.stubGlobal("fetch", fetchMock);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await worker.scheduled({ scheduledTime: Date.parse("2026-06-12T21:00:00Z"), cron: "0 21 * * 1-5" } as ScheduledController, env, {} as ExecutionContext);
			expect(log).toHaveBeenCalledWith("Scheduled sync completed");
			const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
			expect(payload.title).toBe("Daycare sync completed");
			expect(payload.message).not.toContain("2026-06-12");
		} finally { log.mockRestore(); }
	});
	it("sanitizes scheduled errors even when failure notification also fails", async () => {
		vi.mocked(syncDate).mockRejectedValue(new Error("PRIVATE ACCOUNT DATA"));
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("SECRET TOPIC")));
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(worker.scheduled({ scheduledTime: Date.parse("2026-06-12T21:00:00Z"), cron: "cron" } as ScheduledController, env, {} as ExecutionContext)).rejects.toThrow("Scheduled sync or notification failed");
			expect(JSON.stringify(log.mock.calls)).not.toMatch(/PRIVATE ACCOUNT DATA|SECRET TOPIC/);
		} finally { log.mockRestore(); }
	});
});


describe("account selection", () => {
	it("refuses multiple Tadpoles reports for the same date", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ status: "ok", payload: { daily_reports: [
			{ date: "2026-06-12", entries: [] }, { date: "2026-06-12", entries: [] },
		] } })));
		await expect(new TadpolesClient("e", "p", "UTC").getDailyReports("2026-06-12")).rejects.toMatchObject({ stage: "tadpoles-report", reason: "child-selection" });
	});
	it.each(["../another-user", "u1?query=value", undefined])("rejects invalid authenticated user IDs", async (localId) => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ idToken: "tok", localId })));
		await expect(new HuckleberryClient("e", "p").login()).rejects.toMatchObject({ stage: "huckleberry-login", reason: "invalid-account-id" });
	});
	it.each(["../other-child", "c1?query=value", undefined])("rejects invalid child IDs before interval access", async (cid) => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(Response.json({ idToken: "tok", localId: "u1" }))
			.mockResolvedValueOnce(Response.json({ fields: { childList: { arrayValue: { values: [{ mapValue: { fields: cid === undefined ? {} : { cid: { stringValue: cid } } } }] } } } }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new HuckleberryClient("e", "p");
		await client.login();
		await expect(client.getChildId()).rejects.toMatchObject({ stage: "huckleberry-child", reason: "invalid-account-id" });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});


describe("safe diagnostics", () => {
	it("reports stage and HTTP status to authenticated callers", async () => {
		vi.mocked(syncDate).mockRejectedValue(new SyncFailure("tadpoles-login", "unexpected", 403));
		const res = await run(request());
		expect(res.status).toBe(502);
		expect(await res.text()).toBe("Sync failed: tadpoles-login (upstream HTTP 403)");
		expect(res.headers.get("Cache-Control")).toBe("no-store");
	});
	it("never renders arbitrary error fields or messages", () => {
		expect(safeDiagnostic(new Error("PRIVATE DATA"))).toBe("Sync failed: unexpected error");
		const error = new SyncFailure("configuration", "missing-credentials");
		error.message = "PRIVATE DATA";
		expect(safeDiagnostic(error)).toBe("Sync failed: configuration (required account credentials are missing or blank)");
		expect(safeDiagnostic(new SyncFailure("PRIVATE DATA" as any))).not.toContain("PRIVATE DATA");
		expect(safeDiagnostic(new SyncFailure("configuration", "PRIVATE DATA" as any))).not.toContain("PRIVATE DATA");
	});
});


describe("redirect refusal on Workers", () => {
	it.each([301, 302, 303, 307, 308])("does not follow HTTP %s from credential-bearing endpoints", async (status) => {
		const fetchMock = vi.fn().mockImplementation(async (_url: unknown, init: RequestInit) => {
			// Model Workers rejecting unsupported redirect modes before sending a request.
			if (init.redirect !== "manual") throw new TypeError("Unsupported redirect mode");
			return new Response(null, { status, headers: { Location: "https://untrusted.example/" } });
		});
		vi.stubGlobal("fetch", fetchMock);
		await expect(new HuckleberryClient("e", "p").login()).rejects.toMatchObject({ status });
		await expect(notify(env, "t", "m")).rejects.toThrow(String(status));
		expect(fetchMock).toHaveBeenCalledTimes(2);
		for (const [url] of fetchMock.mock.calls) expect(String(url)).not.toContain("untrusted.example");
	});
	it("uses manual mode for Firestore requests and refuses redirects", async () => {
		const fetchMock = vi.fn().mockImplementation(async (_url: unknown, init: RequestInit) => {
			if (init.redirect !== "manual") throw new TypeError("Unsupported redirect mode");
			if (fetchMock.mock.calls.length === 1) return Response.json({ idToken: "tok", localId: "u1" });
			return new Response(null, { status: 307, headers: { Location: "https://untrusted.example/" } });
		});
		vi.stubGlobal("fetch", fetchMock);
		const client = new HuckleberryClient("e", "p");
		await client.login();
		await expect(client.getChildId()).rejects.toMatchObject({ status: 307 });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

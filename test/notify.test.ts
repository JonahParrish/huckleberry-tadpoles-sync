import { afterEach, describe, expect, it, vi } from "vitest";
import { notify } from "../src/notify";

const env = { NTFY_SERVER: "https://ntfy.sh", NTFY_TOPIC: "secret-topic" } as Env;

describe("notify", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("publishes JSON to the topic, high priority on failure, trimmed to ntfy's size limit", async () => {
		const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ event: "message", topic: env.NTFY_TOPIC, id: "test-id" }));
		vi.stubGlobal("fetch", fetchMock);
		const receipt = await notify(env, "Daycare sync 2026-06-12 FAILED", "x".repeat(10_000), true);
		expect(receipt).toEqual({ accepted: true, status: 200 });

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://ntfy.sh");
		// Cached messages remain available for background delivery/reconnection.
		expect(new Headers(init.headers).has("Cache")).toBe(false);
		expect(new Headers(init.headers).has("X-Cache")).toBe(false);
		const body = JSON.parse(init.body as string);
		expect(body).toMatchObject({ topic: "secret-topic", title: "Daycare sync 2026-06-12 FAILED", priority: 5 });
		expect(body.message.length).toBeLessThan(4000);
	});

	it("throws when ntfy rejects the message", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 429 })));
		await expect(notify(env, "t", "m")).rejects.toMatchObject({ stage: "ntfy-publish", status: 429 });
	});
});


describe("notification acknowledgment", () => {
	afterEach(() => vi.unstubAllGlobals());
	it.each([{}, null, { event: "open", topic: "secret-topic", id: "x" }, { event: "message", topic: "wrong-topic", id: "x" }, { event: "message", topic: "secret-topic" }])("rejects a successful HTTP response without a matching publish acknowledgment", async (body) => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
		await expect(notify(env, "t", "m")).rejects.toMatchObject({ stage: "ntfy-publish", reason: "invalid-response" });
	});
	it("sanitizes invalid JSON and network failures", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("PRIVATE DATA")));
		await expect(notify(env, "t", "m")).rejects.toMatchObject({ stage: "ntfy-publish", reason: "invalid-response", message: "Sync failed" });
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("SECRET TOPIC")));
		await expect(notify(env, "t", "m")).rejects.toMatchObject({ stage: "ntfy-publish", reason: "request-failed", message: "Sync failed" });
	});
});

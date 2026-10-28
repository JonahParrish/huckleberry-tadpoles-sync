import { afterEach, describe, expect, it, vi } from "vitest";
import { notify } from "../src/notify";

const env = { NTFY_SERVER: "https://ntfy.sh", NTFY_TOPIC: "secret-topic" } as Env;

describe("notify", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("publishes JSON to the topic, high priority on failure, trimmed to ntfy's size limit", async () => {
		const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("{}"));
		vi.stubGlobal("fetch", fetchMock);
		await notify(env, "Daycare sync 2026-06-12 FAILED", "x".repeat(10_000), true);

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://ntfy.sh");
		const body = JSON.parse(init.body as string);
		expect(body).toMatchObject({ topic: "secret-topic", title: "Daycare sync 2026-06-12 FAILED", priority: 5 });
		expect(body.message.length).toBeLessThan(4000);
	});

	it("throws when ntfy rejects the message", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 429 })));
		await expect(notify(env, "t", "m")).rejects.toThrow("ntfy publish failed: 429");
	});
});

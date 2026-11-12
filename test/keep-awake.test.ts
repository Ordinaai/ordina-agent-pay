// The free-plan keep-awake ping: when it runs, where it goes, and how often.
import { afterEach, describe, expect, it, vi } from "vitest";
import { keepAwakeTarget, startKeepAwake } from "../server/keep-awake.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("keep-awake", () => {
  it("runs on Render by itself, can be pointed elsewhere or switched off, and stays under 15 minutes", () => {
    expect(keepAwakeTarget({})).toBe(null);
    expect(keepAwakeTarget({ RENDER_EXTERNAL_URL: "https://demo.onrender.com/" })).toEqual({ url: "https://demo.onrender.com/api/health", minutes: 10 });
    expect(keepAwakeTarget({ RENDER_EXTERNAL_URL: "https://demo.onrender.com", KEEP_AWAKE: "0" })).toBe(null);
    expect(keepAwakeTarget({ KEEP_AWAKE_URL: "http://localhost:8787" })?.url).toBe("http://localhost:8787/api/health");
    expect(keepAwakeTarget({ RENDER_EXTERNAL_URL: "https://d.onrender.com", KEEP_AWAKE_MINUTES: "60" })?.minutes).toBe(14);
    expect(keepAwakeTarget({ RENDER_EXTERNAL_URL: "https://d.onrender.com", KEEP_AWAKE_MINUTES: "x" })?.minutes).toBe(10);
    expect(keepAwakeTarget({ RENDER_EXTERNAL_URL: "not a url" })).toBe(null);
  });

  it("asks its own health page on every tick, and a failed ping never throws", async () => {
    vi.useFakeTimers();
    const asked: string[] = [];
    let fail = true;
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(url);
      if (fail) throw new Error("ECONNRESET");
      return new Response('{"ok":true}', { status: 200 });
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const stop = startKeepAwake({ RENDER_EXTERNAL_URL: "https://demo.onrender.com" })!;
    expect(asked).toEqual([]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    fail = false;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(asked).toEqual(["https://demo.onrender.com/api/health", "https://demo.onrender.com/api/health"]);
    stop();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(asked).toHaveLength(2);
  });
});

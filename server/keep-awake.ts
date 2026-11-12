// Render's free plan puts a service to sleep after 15 minutes without requests, and the next
// visitor waits about a minute while it wakes. The server asks for its own public health page
// every 10 minutes, through Render's front door, so it never counts as idle.
// (A GitHub Actions schedule is no substitute: scheduled runs set for every 10 minutes were
// measured firing hours apart.)
//
// On by itself on Render (which sets RENDER_EXTERNAL_URL). KEEP_AWAKE_URL points it elsewhere;
// KEEP_AWAKE=0 switches it off.

export function keepAwakeTarget(env: NodeJS.ProcessEnv = process.env): { url: string; minutes: number } | null {
  if (env.KEEP_AWAKE === "0") return null;
  const base = (env.KEEP_AWAKE_URL || env.RENDER_EXTERNAL_URL || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) return null;
  const asked = Number(env.KEEP_AWAKE_MINUTES ?? 10);
  const minutes = Number.isFinite(asked) ? Math.min(14, Math.max(1, asked)) : 10; // under Render's 15
  return { url: `${base}/api/health`, minutes };
}

export function startKeepAwake(env: NodeJS.ProcessEnv = process.env): (() => void) | null {
  const target = keepAwakeTarget(env);
  if (!target) return null;
  let failures = 0;
  const ping = async () => {
    try {
      const res = await fetch(target.url, { signal: AbortSignal.timeout(30_000), headers: { "User-Agent": "ordina-agent-checkout keep-awake" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (failures) console.log(`keep-awake: ${target.url} answering again`);
      failures = 0;
    } catch (err) {
      failures++;
      if (failures === 1 || failures % 6 === 0) {
        console.warn(`keep-awake: ${target.url} failed (${failures} in a row): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  const timer = setInterval(ping, target.minutes * 60_000);
  console.log(`keep-awake: asking ${target.url} every ${target.minutes} min`);
  return () => clearInterval(timer);
}

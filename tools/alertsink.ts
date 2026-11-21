/**
 * A local alert receiver: the relay POSTs its alerts to ALERT_WEBHOOK_URL, and this server appends each one to a file.
 * It is the stand-in until a real channel (Slack, Discord, a pager) is chosen: switching is only a change of ALERT_WEBHOOK_URL.
 *
 *   npm run alerts:sink                 listens on 127.0.0.1:8789, writes data/alerts.log
 *   ALERT_WEBHOOK_URL=http://127.0.0.1:8789/alert        (in .env)
 *
 * Variables: ALERT_SINK_PORT (8789), ALERT_SINK_FILE (data/alerts.log). Bound to localhost only; it accepts small JSON bodies.
 */
import { createServer } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function startSink(port: number, file: string) {
  mkdirSync(dirname(file), { recursive: true });
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") return void res.writeHead(200).end("ok");
    if (req.method !== "POST" || req.url !== "/alert") return void res.writeHead(404).end();
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 16_384) { res.writeHead(413).end(); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      let body: { key?: unknown; message?: unknown; text?: unknown };
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return void res.writeHead(400).end(); }
      const line = JSON.stringify({ ts: new Date().toISOString(), key: String(body.key ?? ""), message: String(body.message ?? body.text ?? "").slice(0, 2000) });
      appendFileSync(file, line + "\n");
      res.writeHead(204).end();
    });
  });
  return new Promise<import("node:http").Server>((ok) => server.listen(port, "127.0.0.1", () => ok(server)));
}

if (process.argv[1] && /alertsink\.(ts|js)$/.test(process.argv[1])) {
  const port = Number(process.env.ALERT_SINK_PORT ?? "8789");
  const file = resolve(process.env.ALERT_SINK_FILE ?? "data/alerts.log");
  await startSink(port, file);
  console.log(`alert sink on http://127.0.0.1:${port}/alert, writing ${file}`);
}

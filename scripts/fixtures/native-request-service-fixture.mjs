import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.payload?.crash) process.exit(17);
  process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result: { ok: true, echo: request.payload } })}\n`);
}

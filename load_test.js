/**
 * SWE 455 – HW2  |  Load Test
 * Sends 50 concurrent POST /estimate_pi requests, each with 10,000,000 points.
 * Then polls GET /result/:jobId for every job until all results are received.
 */
"use strict";

const https = require("https");
const http = require("http");
const fs = require("fs");
const { URL } = require("url");

const CONCURRENT = 50;
const POINTS = 10_000_000;
const POLL_MS = 2000; // poll every 2 seconds

const urlArg = process.argv[process.argv.indexOf("--url") + 1];
if (!urlArg) {
  console.error("Usage: node load_test.js --url https://<GATEWAY_URL>");
  process.exit(1);
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
function request(method, targetUrl, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const lib = parsed.protocol === "https:" ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + (parsed.search || ""),
      method,
      headers: { "Content-Type": "application/json" },
    };

    if (body) {
      const bodyStr = JSON.stringify(body);
      options.headers["Content-Length"] = Buffer.byteLength(bodyStr);
    }

    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (_) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Step 1: submit job ────────────────────────────────────────────────────────
async function submitJob(idx) {
  const t0 = Date.now();
  const res = await request("POST", `${urlArg}/estimate_pi`, {
    total_points: POINTS,
  });
  const lat = ((Date.now() - t0) / 1000).toFixed(3);
  const ok = res.status === 202;
  console.log(
    `  ${ok ? "✓" : "✗"} [${String(idx).padStart(2, "0")}] POST status=${res.status} job_id=${res.body?.job_id ?? "N/A"} latency=${lat}s`,
  );
  return { idx, status: res.status, latency: +lat, job_id: res.body?.job_id };
}

// ── Step 2: poll for result ───────────────────────────────────────────────────
async function pollResult(jobId, idx) {
  let attempts = 0;
  while (true) {
    attempts++;
    await new Promise((r) => setTimeout(r, POLL_MS));
    const res = await request("GET", `${urlArg}/result/${jobId}`);

    if (res.status === 200) {
      console.log(
        `  ✓ [${String(idx).padStart(2, "0")}] DONE  job_id=${jobId} pi=${res.body?.pi_estimate?.toFixed(6)} attempts=${attempts}`,
      );
      return { job_id: jobId, pi_estimate: res.body?.pi_estimate, attempts };
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n" + "═".repeat(60));
  console.log("  MaaS Load Test");
  console.log(`  URL        : ${urlArg}`);
  console.log(`  Concurrent : ${CONCURRENT} requests`);
  console.log(`  Points/req : ${POINTS.toLocaleString()}`);
  console.log("═".repeat(60) + "\n");

  // ── Phase 1: fire all 50 POST requests concurrently ──────────────────────
  console.log("Phase 1 — Submitting 50 concurrent jobs...\n");
  const t0 = Date.now();
  const submits = await Promise.all(
    Array.from({ length: CONCURRENT }, (_, i) => submitJob(i + 1)),
  );
  const submitWall = ((Date.now() - t0) / 1000).toFixed(3);

  const accepted = submits.filter((s) => s.status === 202);
  const failed = submits.filter((s) => s.status !== 202);
  const latencies = submits.map((s) => s.latency);

  console.log(
    `\n  Submitted in ${submitWall}s | Accepted: ${accepted.length} | Failed: ${failed.length}`,
  );

  // ── Phase 2: poll for all results ─────────────────────────────────────────
  console.log("\nPhase 2 — Polling for results...\n");
  const t1 = Date.now();
  const results = await Promise.all(
    accepted.filter((s) => s.job_id).map((s) => pollResult(s.job_id, s.idx)),
  );
  const pollWall = ((Date.now() - t1) / 1000).toFixed(3);

  // ── Summary ───────────────────────────────────────────────────────────────
  const piValues = results.map((r) => r.pi_estimate).filter(Boolean);
  const avgPi = piValues.reduce((a, b) => a + b, 0) / piValues.length;

  console.log("\n" + "═".repeat(60));
  console.log("  SUMMARY");
  console.log("═".repeat(60));
  console.log(`  Jobs submitted       : ${CONCURRENT}`);
  console.log(`  202 Accepted         : ${accepted.length}`);
  console.log(`  Results received     : ${results.length}`);
  console.log(`  Submit wall-clock    : ${submitWall}s`);
  console.log(`  Poll wall-clock      : ${pollWall}s`);
  console.log(`  Min POST latency     : ${Math.min(...latencies).toFixed(3)}s`);
  console.log(`  Max POST latency     : ${Math.max(...latencies).toFixed(3)}s`);
  console.log(
    `  Avg POST latency     : ${(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(3)}s`,
  );
  console.log(`  Avg π estimate       : ${avgPi.toFixed(6)}`);
  console.log("═".repeat(60) + "\n");

  fs.writeFileSync(
    "load_test_results.json",
    JSON.stringify(
      {
        url: urlArg,
        concurrent: CONCURRENT,
        total_points: POINTS,
        summary: {
          accepted: accepted.length,
          results_received: results.length,
          submit_wall_sec: +submitWall,
          poll_wall_sec: +pollWall,
          avg_pi: +avgPi.toFixed(6),
        },
        jobs: results,
      },
      null,
      2,
    ),
  );
  console.log("  Full results saved → load_test_results.json\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

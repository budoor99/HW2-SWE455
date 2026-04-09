"use strict";

const express = require("express");
const { Firestore } = require("@google-cloud/firestore");

const app = express();

const PROJECT_ID = process.env.PROJECT_ID || "your-gcp-project-id";
const COLLECTION_NAME = process.env.COLLECTION_NAME || "pi-results";
const PORT = process.env.PORT || 8080;

const db = new Firestore({ projectId: PROJECT_ID });

app.use(express.json());

// ── Monte Carlo Pi Estimation ─────────────────────────────────────────────────
function estimatePi(n) {
  let insideCircle = 0;
  for (let i = 0; i < n; i++) {
    const x = Math.random() * 2 - 1; // uniform(-1, 1)
    const y = Math.random() * 2 - 1; // uniform(-1, 1)
    if (x * x + y * y <= 1) {
      insideCircle++;
    }
  }
  return (4 * insideCircle) / n;
}

// ── Pub/Sub push endpoint ─────────────────────────────────────────────────────
// Triggered automatically by Pub/Sub when a new job event arrives.
app.post("/", async (req, res) => {
  const envelope = req.body;

  if (!envelope?.message?.data) {
    console.error("[ERROR] Invalid Pub/Sub envelope received");
    return res.status(400).json({ error: "Invalid Pub/Sub message format" });
  }

  let payload;
  try {
    const decoded = Buffer.from(envelope.message.data, "base64").toString(
      "utf8",
    );
    payload = JSON.parse(decoded);
  } catch (err) {
    console.error(`[ERROR] Failed to parse message: ${err.message}`);
    return res.status(400).json({ error: "Malformed message payload" });
  }

  const { job_id: jobId, total_points: totalPoints } = payload;

  if (!jobId || !totalPoints) {
    return res.status(400).json({ error: "Missing job_id or total_points" });
  }

  console.log(`[START] job_id=${jobId} total_points=${totalPoints}`);

  // Run the Monte Carlo simulation
  const startMs = Date.now();
  const piEstimate = estimatePi(Number(totalPoints));
  const duration = (Date.now() - startMs) / 1000;

  // Store result in Firestore
  try {
    await db
      .collection(COLLECTION_NAME)
      .doc(jobId)
      .set({
        job_id: jobId,
        total_points: Number(totalPoints),
        pi_estimate: piEstimate,
        duration_seconds: duration,
        timestamp: Firestore.Timestamp.now(),
      });
  } catch (err) {
    console.error(`[ERROR] Firestore write failed: ${err.message}`);
    return res.status(500).json({ error: "Failed to store result" });
  }

  console.log(
    `[DONE] job_id=${jobId} pi=${piEstimate.toFixed(6)} duration=${duration.toFixed(2)}s`,
  );
  return res.status(200).json({ job_id: jobId, pi_estimate: piEstimate });
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => console.log(`Simulator listening on port ${PORT}`));

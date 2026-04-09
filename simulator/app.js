'use strict';

const express    = require('express');
const { PubSub } = require('@google-cloud/pubsub');
const { Firestore } = require('@google-cloud/firestore');
const { v4: uuidv4 } = require('uuid');

const app    = express();
const pubsub = new PubSub();

const PROJECT_ID      = process.env.PROJECT_ID      || 'your-gcp-project-id';
const TOPIC_ID        = process.env.TOPIC_ID        || 'pi-estimation-topic';
const COLLECTION_NAME = process.env.COLLECTION_NAME || 'pi-results';
const PORT            = process.env.PORT            || 8080;

const topic = pubsub.topic(TOPIC_ID);
const db    = new Firestore({ projectId: PROJECT_ID });

app.use(express.json());

// ── POST /estimate_pi ─────────────────────────────────────────────────────────
// Accepts {"total_points": N}, publishes event to Pub/Sub, returns 202 immediately.
app.post('/estimate_pi', async (req, res) => {
  const { total_points } = req.body ?? {};

  if (!total_points || isNaN(Number(total_points))) {
    return res.status(400).json({ error: 'Missing or invalid field: total_points' });
  }

  const jobId  = uuidv4();
  const payload = Buffer.from(JSON.stringify({
    job_id:       jobId,
    total_points: Number(total_points),
  }));

  try {
    await topic.publishMessage({ data: payload });
    console.log(`[ACCEPTED] job_id=${jobId} total_points=${total_points}`);

    return res.status(202).json({
      job_id:       jobId,
      status:       'accepted',
      total_points: Number(total_points),
      // Client uses this to poll for the result
      result_url:   `/result/${jobId}`,
    });
  } catch (err) {
    console.error(`[ERROR] publish failed: ${err.message}`);
    return res.status(500).json({ error: 'Failed to queue job' });
  }
});

// ── GET /result/:jobId ────────────────────────────────────────────────────────
// Client polls this endpoint every few seconds to check if simulation is done.
app.get('/result/:jobId', async (req, res) => {
  const { jobId } = req.params;

  try {
    const doc = await db.collection(COLLECTION_NAME).doc(jobId).get();

    if (!doc.exists) {
      // Simulation still running — tell client to keep polling
      return res.status(202).json({
        job_id: jobId,
        status: 'pending',
        message: 'Simulation is still running. Poll again in a few seconds.',
      });
    }

    // Simulation finished — return the result
    console.log(`[RESULT] job_id=${jobId} delivered to client`);
    return res.status(200).json({
      job_id: jobId,
      status: 'done',
      ...doc.data(),
    });
  } catch (err) {
    console.error(`[ERROR] Firestore read failed: ${err.message}`);
    return res.status(500).json({ error: 'Failed to retrieve result' });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Receiver listening on port ${PORT}`));

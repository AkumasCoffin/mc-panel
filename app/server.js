--- a/app/server.js
+++ b/app/server.js
@@ -1,6 +1,7 @@
 const express = require('express');
 const basicAuth = require('basic-auth');
 const dotenv = require('dotenv');
+// (other requires unchanged)
 dotenv.config();

 // ... existing setup code (db, rcon helpers, auth, etc.)

+/**
+ * Take a metrics sample right now:
+ * - Runs "list" via RCON, parses online count
+ * - Measures RCON round-trip latency
+ * - Inserts a row into metrics_online
+ */
+async function takeMetricsSampleNow() {
+  const t0 = Date.now();
+  let onlineCount = 0;
+  try {
+    const out = await sendRconCommand('list'); // existing helper you already use
+    const m = /There are\s+(\d+)/i.exec(out || '');
+    if (m) onlineCount = Number(m[1]) || 0;
+  } catch (e) {
+    // If RCON fails, we still record a sample with 0 and the latency up to failure
+  }
+  const latency = Date.now() - t0;
+  await new Promise((resolve, reject) => {
+    db.run(
+      'INSERT INTO metrics_online(online_count, rcon_latency_ms, at) VALUES (?,?,CURRENT_TIMESTAMP)',
+      [onlineCount, latency],
+      (err) => (err ? reject(err) : resolve())
+    );
+  });
+  return { online_count: onlineCount, rcon_latency_ms: latency };
+}
+
 // ---------------- API routes ----------------
 
 // (keep your existing routes here)
 
+// Manual metrics snapshot (admin-only; Basic Auth protected)
+app.post('/api/metrics/snap', auth, async (req, res) => {
+  try {
+    const out = await takeMetricsSampleNow();
+    res.json({ ok: true, ...out });
+  } catch (e) {
+    res.status(500).json({ ok: false, error: String(e.message || e) });
+  }
+});
+
 // (rest of routes and server listen unchanged)

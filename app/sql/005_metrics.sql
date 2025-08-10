*** /dev/null
--- b/app/sql/005_metrics.sql
@@
+-- Create metrics table for online/latency samples (idempotent)
+CREATE TABLE IF NOT EXISTS metrics_online(
+  id INTEGER PRIMARY KEY,
+  online_count INTEGER NOT NULL,
+  rcon_latency_ms INTEGER,
+  at DATETIME DEFAULT CURRENT_TIMESTAMP
+);
+CREATE INDEX IF NOT EXISTS ix_metrics_online_at ON metrics_online(at);

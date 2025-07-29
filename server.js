// server.js  ── tiny read‑only API for wallet metrics
// ▷ uses Node.js, Express, PostgreSQL, and NodeCache
import express from "express";
import cors from "cors";
import pg from "pg";
import dotenv from "dotenv";
import NodeCache from "node-cache";      // 🔹 1) add
import poolFlowRouter from "./routes/poolFlow.js"; // import the pool flow router
dotenv.config();

const { DATABASE_URL, PORT = 4000 } = process.env;
if (!DATABASE_URL) throw new Error("DATABASE_URL env‑var missing");

// Neon / Supabase / Cloud PG all like ssl: { rejectUnauthorized: false }
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const cache = new NodeCache({ stdTTL: 300 });  // 🔹 2) 300 s = 5 min

const app = express();
app.use(cors({
  origin: [
    "https://dexwalletwatch.netlify.app",
    "http://localhost:5173"
  ]
}));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "https://dexwalletwatch.netlify.app");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});
app.set('trust proxy', true);      

app.use(poolFlowRouter);

app.get('/health', (_, res) => res.send('ok'));

function metricsTable(poolSlug) {
  return `${poolSlug}_wallet_metrics`;
}

/* ───────────── wallet‑metrics endpoint ───────────── */
app.get("/api/wallet-metrics/:pool", async (req, res) => {
  const poolSlug = req.params.pool;
  const table    = metricsTable(poolSlug);
  const cacheKey = `metrics:${table}`;              // 🔹 3a) cache key

  const cached = cache.get(cacheKey);               // 🔹 3b) serve from cache
  if (cached) return res.json(cached);

  const sql = `
    SELECT wallet,
           turnover,
           net_bias,
           trades,
           avg_trade_usd,
           color_val,
           bubble_size
    FROM   ${table}
    WHERE  updated_at >= NOW() - INTERVAL '90 days'
      AND  trades      >= 10
      AND  turnover    >= 10000;
  `;
  try {
    const { rows } = await pool.query(sql);
    cache.set(cacheKey, rows);                      // 🔹 3c) store 5 min
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "DB query failed" });
  }
});

/* ───────────── top‑wallets endpoint ───────────── */
app.get("/api/top-wallets/:pool", async (req, res) => {
  const poolSlug = req.params.pool;
  const table    = `${poolSlug}_wallet_metrics`;
  const cacheKey = `top:${table}`;                  // 🔹 4a) cache key

  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);              // 🔹 4b) serve cache

  const sql = `
    SELECT wallet,
           turnover_24h,
           last_trade
    FROM   ${table}
    WHERE  turnover_24h > 0
    ORDER  BY turnover_24h DESC
    LIMIT  10;
  `;
  try {
    const { rows } = await pool.query(sql);
    cache.set(cacheKey, rows);                      // 🔹 4c) store 5 min
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "DB query failed" });
  }
});

app.get("/api/ingest-stats/:pool", async (req, res) => {
  const poolSlug = req.params.pool;
  const cacheKey = `stats:${poolSlug}`;         // 5‑min cache
  const cached   = cache.get(cacheKey);
  if (cached) return res.json(cached);

  // • latest run  • lifetime totals
  const sql = `
    SELECT
      timestamp,
      log_count,
      duration_seconds,
      ROUND(log_count / NULLIF(duration_seconds, 0), 2) AS logs_per_second,
      log_count AS total_logs
    FROM extraction_metrics
    WHERE pool_slug = $1
    ORDER BY timestamp DESC
    LIMIT 1;
  `;

  try {
    const { rows } = await pool.query(sql, [poolSlug]);
    const stats = rows[0] ?? {};     
    cache.set(cacheKey, stats, 300);           // 5‑minute TTL
    return res.json(stats);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "DB query failed" });
  }
});

app.listen(PORT, () =>
  console.log(`🟢 Wallet‑metrics API listening on http://localhost:${PORT}`)
);

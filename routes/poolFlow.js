import express from "express";
import pg from "pg";
import dotenv from "dotenv";
dotenv.config();

const { DATABASE_URL} = process.env;

console.log("DATABASE_URL:", DATABASE_URL);
const router = express.Router();
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

router.get("/api/pool-flow/pressure", async (req, res) => {
  const { pool: slug = ""} = req.query;
  if (!slug) return res.status(400).json({ error: "pool param required" });
    const days = 30
    try {
       const { rows } = await pool.query(
        `
        WITH bins AS (
            SELECT
            -- floor bucket_start down to the nearest 4‑hour boundary UTC
            date_trunc('hour', bucket_start)
                - (EXTRACT(hour FROM bucket_start)::int % 4) * interval '1 hour'
                AS ts,

            SUM(buys_usd)  AS buys,
            SUM(sells_usd) AS sells,
            SUM(volume_usd) AS vol
            FROM pool_flow_hourly
            WHERE pool_slug = $1
            AND bucket_start >= NOW() - ($2::int || ' days')::interval
            GROUP BY ts
        ),
        ratios AS (
            SELECT
            ts, buys, sells, vol,
            CASE WHEN vol = 0 THEN 0
                ELSE (buys - sells) / vol
            END AS pressure
            FROM bins
        )
        SELECT
            -- convert ts (which is already UTC) to America/New_York
            (ts AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York') AS ts_est,
            pressure,
            AVG(pressure) OVER (
            ORDER BY ts ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING
            ) AS pressure_ma,
            vol AS volume_usd
        FROM ratios
        ORDER BY ts;
        `,
        [slug, days]
        );
        // Express sends arrays the React chart can consume
        res.json({
        ts:        rows.map(r => r.ts_est),      // ISO strings
        pressure:  rows.map(r => Number(r.pressure_ma)),
        volume:    rows.map(r => Number(r.volume_usd))
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "DB query failed" });
    }
});

router.get("/api/pool-flow/heatmap", async (req, res) => {
  const { pool: slug = ""} = req.query;
  const days = 30
  if (!slug) return res.status(400).json({ error: "pool param required" });

  try {
    const { rows } = await pool.query(
      `
      /* 7 × 24 grid: day‑of‑week (Mon=1) × hour‑of‑day (EST) */
      SELECT
        EXTRACT(dow  FROM bucket_start AT TIME ZONE 'UTC'
                 AT TIME ZONE 'America/New_York')::int AS dow,
        EXTRACT(hour FROM bucket_start AT TIME ZONE 'UTC'
                 AT TIME ZONE 'America/New_York')::int AS hr,
        SUM(volume_usd)::float                             AS vol_usd
      FROM pool_flow_hourly
      WHERE pool_slug   = $1
        AND bucket_start >= NOW() - ($2::int || ' days')::interval
      GROUP BY dow, hr;
      `,
      [slug, days]
    );

    /* rows → { dow: 0‑6, hr: 0‑23, vol_usd }  */
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "DB query failed" });
  }
});

export default router;
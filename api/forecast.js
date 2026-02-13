// /api/forecast.js (Vercel Serverless Function)

module.exports = async function handler(req, res) {
  // CORS + preflight
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=3600");

  try {
    const lat = Number(req.query.lat ?? -37.8676);
    const lon = Number(req.query.lon ?? 144.9741);
    const tz = "Australia/Melbourne";
    const days = Number(req.query.days ?? 7);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      res.status(400).json({ error: "Invalid lat/lon" });
      return;
    }

    const weatherUrl =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&hourly=temperature_2m,precipitation,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weathercode` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum` +
      `&timezone=${encodeURIComponent(tz)}&forecast_days=${days}`;

    const marineUrl =
      `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}` +
      `&hourly=wave_height,wave_period,wave_direction` +
      `&timezone=${encodeURIComponent(tz)}&forecast_days=${days}`;

    const [wResp, mResp] = await Promise.all([fetch(weatherUrl), fetch(marineUrl)]);

    if (!wResp.ok) {
      res.status(502).json({ error: "Weather upstream failed", status: wResp.status });
      return;
    }
    // Marine sometimes fails for some points; we tolerate it.
    const weather = await wResp.json();
    const marine = mResp.ok ? await mResp.json() : null;

    const hourly = weather?.hourly ?? null;
    const daily = weather?.daily ?? null;

    if (!hourly || !hourly.time) {
      res.status(502).json({ error: "Malformed weather response" });
      return;
    }

    // Merge marine -> hourly, aligned by index (Open-Meteo uses same hourly time grid)
    if (marine?.hourly?.wave_height && marine?.hourly?.time?.length === hourly.time.length) {
      hourly.wave_height = marine.hourly.wave_height;
      hourly.wave_period = marine.hourly.wave_period;
      hourly.wave_direction = marine.hourly.wave_direction;
    } else {
      // Provide empty arrays so the frontend can handle “no waves” cleanly
      hourly.wave_height = hourly.time.map(() => null);
      hourly.wave_period = hourly.time.map(() => null);
      hourly.wave_direction = hourly.time.map(() => null);
    }

    res.status(200).json({
      meta: {
        lat,
        lon,
        timezone: tz,
        generated_at: new Date().toISOString(),
        source: ["open-meteo", "open-meteo-marine"]
      },
      hourly,
      daily
    });
  } catch (e) {
    res.status(500).json({
      error: "Server error",
      message: e?.message ?? String(e)
    });
  }
};

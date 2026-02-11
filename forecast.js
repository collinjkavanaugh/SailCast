module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=7200, stale-while-revalidate=3600");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const lat = Number(req.query.lat ?? -37.8676);
  const lon = Number(req.query.lon ?? 144.9741);

  const tz = "Australia/Melbourne";

  const weatherUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation,cloud_cover` +
    `&timezone=${tz}`;

  const weatherResp = await fetch(weatherUrl);
  const weather = await weatherResp.json();

  res.status(200).json({
    meta: {
      lat,
      lon,
      timezone: tz,
      generated_at: new Date().toISOString(),
      source: ["open-meteo"]
    },
    hourly: weather.hourly
  });
};

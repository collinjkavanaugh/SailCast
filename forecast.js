// api/forecast.js — Vercel Serverless Function
// Fetches ECMWF IFS weather + Marine wave data from Open-Meteo (free, no API key)
// Called by the frontend on page load, cached for 2 hours

export default async function handler(req, res) {
  // CORS headers for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  
  // Cache for 2 hours on Vercel edge + browser
  res.setHeader('Cache-Control', 's-maxage=7200, stale-while-revalidate=3600');

  try {
    // Default to St Kilda, allow lat/lon override via query params
    const lat = parseFloat(req.query.lat) || -37.8676;
    const lon = parseFloat(req.query.lon) || 144.9741;

    // Fetch ECMWF IFS weather data
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?` +
      `latitude=${lat}&longitude=${lon}` +
      `&hourly=temperature_2m,precipitation,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant` +
      `&timezone=Australia/Melbourne&forecast_days=7` +
      `&models=ecmwf_ifs025`;

    // Fetch ECMWF WAM marine/wave data
    const marineUrl = `https://marine-api.open-meteo.com/v1/marine?` +
      `latitude=${lat}&longitude=${lon}` +
      `&hourly=wave_height,wave_direction,wave_period` +
      `&timezone=Australia/Melbourne&forecast_days=7`;

    const [weatherRes, marineRes] = await Promise.allSettled([
      fetch(weatherUrl).then(r => r.json()),
      fetch(marineUrl).then(r => r.json())
    ]);

    const weather = weatherRes.status === 'fulfilled' ? weatherRes.value : null;
    const marine = marineRes.status === 'fulfilled' ? marineRes.value : null;

    if (!weather || weather.error) {
      throw new Error(weather?.reason || 'Failed to fetch weather data');
    }

    // Process into our app's format
    const hourlyTimes = weather.hourly.time; // "2026-02-10T00:00" format
    const days = {};

    // Group hourly data by date
    hourlyTimes.forEach((time, i) => {
      const date = time.slice(0, 10);
      const hour = parseInt(time.slice(11, 13));

      if (!days[date]) days[date] = { date, hours: [] };

      // Only include hours 5-22 (useful sailing/daylight hours)
      if (hour >= 5 && hour <= 22) {
        days[date].hours.push({
          h: hour,
          t: Math.round(weather.hourly.temperature_2m[i] || 0),
          ws: Math.round(weather.hourly.wind_speed_10m[i] || 0), // km/h
          wd: Math.round(weather.hourly.wind_direction_10m[i] || 0),
          gs: Math.round(weather.hourly.wind_gusts_10m[i] || 0), // km/h
          pr: parseFloat((weather.hourly.precipitation[i] || 0).toFixed(1)),
          cl: Math.round(weather.hourly.cloud_cover[i] || 0),
          wv: marine?.hourly?.wave_height?.[i] != null
            ? parseFloat(marine.hourly.wave_height[i].toFixed(2))
            : estimateWaveHeight(weather.hourly.wind_speed_10m[i] || 0),
          wp: marine?.hourly?.wave_period?.[i] != null
            ? Math.round(marine.hourly.wave_period[i])
            : 5,
          ts: false // TODO: thunderstorm detection from weather codes if available
        });
      }
    });

    // Build daily summaries
    const forecast = weather.daily.time.map((date, i) => {
      const dayData = days[date] || { date, hours: [] };
      const dayLabel = formatDayLabel(date, i);

      return {
        date,
        label: dayLabel,
        tempMax: Math.round(weather.daily.temperature_2m_max[i]),
        tempMin: Math.round(weather.daily.temperature_2m_min[i]),
        precipSum: parseFloat((weather.daily.precipitation_sum[i] || 0).toFixed(1)),
        windDesc: buildWindDesc(dayData.hours),
        summary: buildSummary(dayData.hours, weather.daily.precipitation_sum[i]),
        hours: dayData.hours
      };
    });

    res.status(200).json({
      forecast,
      source: 'ECMWF IFS via Open-Meteo',
      marine_source: marine && !marine.error ? 'ECMWF WAM via Open-Meteo' : 'Estimated from wind speed',
      updated: new Date().toISOString(),
      location: { lat, lon }
    });

  } catch (error) {
    console.error('Forecast API error:', error);
    res.status(500).json({
      error: 'Failed to fetch forecast',
      message: error.message
    });
  }
}

// Estimate wave height from wind speed when marine data unavailable
// Based on Port Phillip Bay fetch characteristics
function estimateWaveHeight(windSpeedKph) {
  const kts = windSpeedKph * 0.539957;
  if (kts < 5) return 0.1;
  if (kts < 10) return 0.2;
  if (kts < 15) return 0.3 + (kts - 10) * 0.04;
  if (kts < 20) return 0.5 + (kts - 15) * 0.06;
  if (kts < 30) return 0.8 + (kts - 20) * 0.07;
  return 1.5;
}

function formatDayLabel(dateStr, index) {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.toLocaleDateString('en-AU', { weekday: 'short' });
  const dm = `${d.getDate()}/${d.getMonth() + 1}`;
  if (index === 0) return `Today`;
  if (index === 1) return `Tomorrow`;
  return `${day} ${dm}`;
}

function buildWindDesc(hours) {
  if (!hours.length) return '';
  const kphToKt = k => Math.round(k * 0.539957);
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  const d2c = d => dirs[Math.round(d / 22.5) % 16];

  const dayHours = hours.filter(h => h.h >= 8 && h.h <= 18);
  if (!dayHours.length) return '';

  const minWs = kphToKt(Math.min(...dayHours.map(h => h.ws)));
  const maxWs = kphToKt(Math.max(...dayHours.map(h => h.ws)));
  const mainDir = d2c(dayHours[Math.floor(dayHours.length / 2)].wd);

  return `${mainDir} ${minWs}–${maxWs} kts`;
}

function buildSummary(hours, precipSum) {
  const dayHours = hours.filter(h => h.h >= 8 && h.h <= 18);
  if (!dayHours.length) return '';

  const avgCloud = dayHours.reduce((a, h) => a + h.cl, 0) / dayHours.length;
  const hasRain = precipSum > 0.5;

  let sky = 'Sunny';
  if (avgCloud > 75) sky = 'Cloudy';
  else if (avgCloud > 50) sky = 'Mostly cloudy';
  else if (avgCloud > 25) sky = 'Partly cloudy';
  else sky = 'Sunny';

  let rain = '';
  if (precipSum > 5) rain = ' Heavy rain expected.';
  else if (precipSum > 2) rain = ' Showers likely.';
  else if (precipSum > 0.5) rain = ' Slight chance of showers.';

  return sky + '.' + rain;
}

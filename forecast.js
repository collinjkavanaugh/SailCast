// api/forecast.js — Vercel Serverless Function
// Fetches ECMWF IFS weather + Marine wave data from Open-Meteo (free, no API key)

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=7200, stale-while-revalidate=3600');

  try {
    const lat = parseFloat(req.query.lat) || -37.8676;
    const lon = parseFloat(req.query.lon) || 144.9741;

    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,precipitation,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weathercode&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant&timezone=Australia/Melbourne&forecast_days=7`;

    const marineUrl = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&hourly=wave_height,wave_direction,wave_period&timezone=Australia/Melbourne&forecast_days=7`;

    const [weatherRes, marineRes] = await Promise.allSettled([
      fetch(weatherUrl).then(r => r.json()),
      fetch(marineUrl).then(r => r.json())
    ]);

    const weather = weatherRes.status === 'fulfilled' ? weatherRes.value : null;
    const marine = marineRes.status === 'fulfilled' ? marineRes.value : null;

    if (!weather || weather.error) {
      throw new Error(weather?.reason || 'Weather API failed');
    }

    const hourlyTimes = weather.hourly.time;
    const days = {};

    hourlyTimes.forEach((time, i) => {
      const date = time.slice(0, 10);
      const hour = parseInt(time.slice(11, 13));
      if (!days[date]) days[date] = { date, hours: [] };
      if (hour >= 5 && hour <= 22) {
        const wcode = weather.hourly.weathercode ? weather.hourly.weathercode[i] : 0;
        days[date].hours.push({
          h: hour,
          t: Math.round(weather.hourly.temperature_2m[i] || 0),
          ws: Math.round(weather.hourly.wind_speed_10m[i] || 0),
          wd: Math.round(weather.hourly.wind_direction_10m[i] || 0),
          gs: Math.round(weather.hourly.wind_gusts_10m[i] || 0),
          pr: parseFloat((weather.hourly.precipitation[i] || 0).toFixed(1)),
          cl: Math.round(weather.hourly.cloud_cover[i] || 0),
          wv: marine && marine.hourly && marine.hourly.wave_height && marine.hourly.wave_height[i] != null ? parseFloat(marine.hourly.wave_height[i].toFixed(2)) : estimateWaveHeight(weather.hourly.wind_speed_10m[i] || 0),
          wp: marine && marine.hourly && marine.hourly.wave_period && marine.hourly.wave_period[i] != null ? Math.round(marine.hourly.wave_period[i]) : 5,
          ts: wcode >= 95
        });
      }
    });

    const forecast = weather.daily.time.map((date, i) => {
      const dd = days[date] || { date, hours: [] };
      const dh = dd.hours.filter(h => h.h >= 8 && h.h <= 18);
      const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
      const d2c = d => dirs[Math.round(d / 22.5) % 16];
      const kphToKt = k => Math.round(k * 0.539957);

      let windDesc = '';
      if (dh.length) {
        const minW = kphToKt(Math.min(...dh.map(h => h.ws)));
        const maxW = kphToKt(Math.max(...dh.map(h => h.ws)));
        const sd = d2c(dh[0].wd), ed = d2c(dh[dh.length-1].wd);
        windDesc = `${sd === ed ? sd : sd+'→'+ed} ${minW}–${maxW} kts`;
      }

      const avgCl = dh.length ? dh.reduce((a,h) => a+h.cl, 0) / dh.length : 0;
      const pSum = weather.daily.precipitation_sum[i] || 0;
      const hasTs = dh.some(h => h.ts);
      let sky = avgCl > 75 ? 'Cloudy' : avgCl > 50 ? 'Mostly cloudy' : avgCl > 25 ? 'Partly cloudy' : 'Sunny';
      let rain = pSum > 10 ? ' Heavy rain.' : pSum > 5 ? ' Rain likely.' : pSum > 2 ? ' Showers likely.' : pSum > 0.5 ? ' Chance of showers.' : '';

      const d = new Date(date + 'T12:00:00');
      const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : `${d.toLocaleDateString('en-AU',{weekday:'short'})} ${d.getDate()}/${d.getMonth()+1}`;

      return {
        date, label,
        tempMax: Math.round(weather.daily.temperature_2m_max[i]),
        tempMin: Math.round(weather.daily.temperature_2m_min[i]),
        precipSum: parseFloat(pSum.toFixed(1)),
        windDesc,
        summary: sky + '.' + rain + (hasTs ? ' Thunderstorm risk.' : ''),
        hours: dd.hours
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
    res.status(500).json({ error: 'Failed to fetch forecast', message: error.message });
  }
};

function estimateWaveHeight(ws) {
  const k = ws * 0.539957;
  if (k < 5) return 0.1;
  if (k < 10) return 0.2;
  if (k < 15) return 0.3 + (k-10)*0.04;
  if (k < 20) return 0.5 + (k-15)*0.06;
  if (k < 30) return 0.8 + (k-20)*0.07;
  return 1.5;
}

const express = require('express');
const ffmpeg  = require('fluent-ffmpeg');
const fetch   = require('node-fetch');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'yt-merger' }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── YouTube Session Token endpoint ────────────────────────────────────────────
// Cobalt calls this to get a fresh YouTube session
const YT_COOKIES = process.env.YT_COOKIES || '';

app.get('/token', async (req, res) => {
  try {
    // שלוף visitor_data ו-po_token מ-YouTube
    const cookieHeader = YT_COOKIES;
    
    const ytRes = await fetch('https://www.youtube.com/sw.js_data', {
      headers: {
        'Cookie': cookieHeader,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!ytRes.ok) {
      return res.json({ error: 'failed to fetch youtube data' });
    }

    const text = await ytRes.text();
    const match = text.match(/"visitorData":"([^"]+)"/);
    const visitorData = match?.[1] || '';

    res.json({
      visitorData,
      cookies: cookieHeader
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── File download helper ──────────────────────────────────────────────────────
async function downloadToFile(url, filepath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(filepath);
    res.body.pipe(stream);
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

// ── Merge logic ───────────────────────────────────────────────────────────────
async function doMerge(videoUrl, audioUrl, filename, res) {
  const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-'));
  const videoFile = path.join(tmpDir, 'video.mp4');
  const audioFile = path.join(tmpDir, 'audio.mp4');

  try {
    console.log('downloading video...');
    await downloadToFile(videoUrl, videoFile);
    console.log('downloading audio...');
    await downloadToFile(audioUrl, audioFile);
    console.log('merging...');

    const safeFilename = (filename || 'video.mp4').replace(/[^\w\s\-_.()[\]]/g, '_');
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(videoFile)
        .input(audioFile)
        .outputOptions(['-c:v copy', '-c:a copy', '-movflags frag_keyframe+empty_moov+faststart'])
        .format('mp4')
        .on('end', resolve)
        .on('error', reject)
        .pipe(res, { end: true });
    });

    console.log('done!');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  }
}

app.post('/merge', async (req, res) => {
  const { videoUrl, audioUrl, filename } = req.body;
  if (!videoUrl || !audioUrl) return res.status(400).json({ error: 'missing urls' });
  try {
    await doMerge(videoUrl, audioUrl, filename, res);
  } catch (err) {
    console.error('error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.get('/merge', async (req, res) => {
  const { videoUrl, audioUrl, filename } = req.query;
  if (!videoUrl || !audioUrl) return res.status(400).json({ error: 'missing urls' });
  try {
    await doMerge(decodeURIComponent(videoUrl), decodeURIComponent(audioUrl), filename, res);
  } catch (err) {
    console.error('error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('yt-merger running on port', PORT));

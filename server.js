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

// POST endpoint
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

// GET endpoint — Chrome downloads.download can use this directly
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

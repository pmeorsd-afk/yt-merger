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

app.post('/merge', async (req, res) => {
  const { videoUrl, audioUrl, filename } = req.body;
  if (!videoUrl || !audioUrl) {
    return res.status(400).json({ error: 'missing videoUrl or audioUrl' });
  }

  const tmpDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-'));
  const videoFile = path.join(tmpDir, 'video.mp4');
  const audioFile = path.join(tmpDir, 'audio.mp4');
  const outFile   = path.join(tmpDir, 'output.mp4');

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
  } catch (err) {
    console.error('error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  } finally {
    // cleanup
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('yt-merger running on port', PORT));

const express = require('express');
const ffmpeg  = require('fluent-ffmpeg');
const fetch   = require('node-fetch');

const app  = express();
app.use(express.json());

// CORS — allow Chrome extensions
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'yt-merger' }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/merge', async (req, res) => {
  const { videoUrl, audioUrl, filename } = req.body;

  if (!videoUrl || !audioUrl) {
    return res.status(400).json({ error: 'missing videoUrl or audioUrl' });
  }

  try {
    const [videoRes, audioRes] = await Promise.all([
      fetch(videoUrl),
      fetch(audioUrl),
    ]);

    if (!videoRes.ok) return res.status(502).json({ error: 'video fetch failed: ' + videoRes.status });
    if (!audioRes.ok) return res.status(502).json({ error: 'audio fetch failed: ' + audioRes.status });

    const safeFilename = (filename || 'video.mp4')
      .replace(/[^\w\s\-_.()[\]]/g, '_')
      .replace(/\.txt$/i, '.mp4');

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);

    ffmpeg()
      .input(videoRes.body)
      .inputFormat('mp4')
      .input(audioRes.body)
      .inputFormat('mp4')
      .outputOptions([
        '-c:v copy',
        '-c:a copy',
        '-movflags frag_keyframe+empty_moov+faststart',
        '-f mp4',
      ])
      .on('error', (err) => {
        console.error('ffmpeg error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: err.message });
      })
      .pipe(res, { end: true });

  } catch (err) {
    console.error('merge error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('yt-merger running on port', PORT));

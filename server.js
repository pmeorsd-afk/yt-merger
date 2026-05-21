const express = require('express');
const { spawn } = require('child_process');

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

// ─────────────────────────────────────────────────────────────────────────────
// GET /merge?videoUrl=...&audioUrl=...&filename=...
//
// ffmpeg מוריד videoUrl + audioUrl ישירות מYouTube CDN ומשדר MP4 ל-Chrome.
// Chrome פותח הורדה מיידית עם progress bar — אין המתנה!
// ─────────────────────────────────────────────────────────────────────────────
app.get('/merge', (req, res) => {
  const { videoUrl, audioUrl, filename } = req.query;

  if (!videoUrl || !audioUrl) {
    return res.status(400).json({ error: 'videoUrl and audioUrl required' });
  }

  const safeFilename = (filename || 'video.mp4')
    .replace(/[^\w\s\-.()[\]]/g, '_')
    .replace(/__+/g, '_')
    .slice(0, 200);

  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  console.log('[merge] starting:', safeFilename);

  // ffmpeg מוריד ישירות מYouTube CDN ומשדר output ל-stdout
  const args = [
    // input 1 — video
    '-user_agent', UA,
    '-headers', 'Referer: https://www.youtube.com/\r\nOrigin: https://www.youtube.com\r\n',
    '-i', decodeURIComponent(videoUrl),

    // input 2 — audio
    '-user_agent', UA,
    '-headers', 'Referer: https://www.youtube.com/\r\nOrigin: https://www.youtube.com\r\n',
    '-i', decodeURIComponent(audioUrl),

    // output options
    '-c:v', 'copy',          // copy video — מהיר, אין re-encode
    '-c:a', 'aac',           // encode audio → AAC
    '-ab', '192k',
    '-map', '0:v:0',         // קח וידאו מinput 0
    '-map', '1:a:0',         // קח אודיו מinput 1
    '-movflags', 'frag_keyframe+empty_moov+faststart', // streaming MP4
    '-f', 'mp4',
    'pipe:1',                // פלט → stdout → HTTP response
  ];

  // שלח headers מיד — Chrome פותח הורדה לפני שffmpeg מסיים
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  const ff = spawn('ffmpeg', args);

  // pipe ffmpeg stdout → HTTP response (streaming)
  ff.stdout.pipe(res);

  ff.stderr.on('data', (d) => {
    const line = d.toString().trim();
    // הצג רק שורות חשובות
    if (line.includes('time=') || line.includes('Error') || line.includes('error')) {
      console.log('[ffmpeg]', line.slice(0, 120));
    }
  });

  ff.on('close', (code) => {
    console.log(`[merge] ffmpeg exited ${code} — ${safeFilename}`);
    if (!res.writableEnded) res.end();
  });

  ff.on('error', (err) => {
    console.error('[merge] spawn error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });

  // אם המשתמש סוגר את ההורדה — הרוג את ffmpeg
  req.on('close', () => {
    if (!ff.killed) {
      ff.kill('SIGTERM');
      console.log('[merge] client disconnected, killed ffmpeg');
    }
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`yt-merger running on port ${PORT}`));

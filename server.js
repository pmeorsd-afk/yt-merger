const express = require('express');
const { spawn } = require('child_process');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'yt-merger' }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const mergeJobs = new Map();
const JOB_TTL_MS = 10 * 60 * 1000;

function sanitizeFilename(name) {
  return (name || 'video.mp4')
    .replace(/[^\w\s\-.()[\]]/g, '_')
    .replace(/__+/g, '_')
    .slice(0, 200);
}

function cleanupExpiredJobs() {
  const now = Date.now();
  for (const [id, job] of mergeJobs.entries()) {
    if (now - job.createdAt > JOB_TTL_MS) mergeJobs.delete(id);
  }
}

setInterval(cleanupExpiredJobs, 60 * 1000).unref();

function streamMerge({ videoUrl, audioUrl, filename }, req, res) {
  const safeFilename = sanitizeFilename(filename);
  const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  console.log('[merge] starting:', safeFilename);

  const args = [
    '-user_agent',
    UA,
    '-headers',
    'Referer: https://www.youtube.com/\r\nOrigin: https://www.youtube.com\r\n',
    '-i',
    videoUrl,
    '-user_agent',
    UA,
    '-headers',
    'Referer: https://www.youtube.com/\r\nOrigin: https://www.youtube.com\r\n',
    '-i',
    audioUrl,
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-ab',
    '192k',
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-movflags',
    'frag_keyframe+empty_moov+faststart',
    '-f',
    'mp4',
    'pipe:1',
  ];

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  const ff = spawn('ffmpeg', args);
  ff.stdout.pipe(res);

  ff.stderr.on('data', d => {
    const line = d.toString().trim();
    if (line.includes('time=') || line.includes('Error') || line.includes('error')) {
      console.log('[ffmpeg]', line.slice(0, 200));
    }
  });

  ff.on('close', code => {
    console.log(`[merge] ffmpeg exited ${code} - ${safeFilename}`);
    if (code !== 0) console.error('[merge] ffmpeg failed', { code, safeFilename });
    if (!res.writableEnded) res.end();
  });

  ff.on('error', err => {
    console.error('[merge] spawn error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });

const express = require('express');
const { spawn } = require('child_process');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
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

  const ff = spawn('ffmpeg', args);
  let startedStreaming = false;
  let stderrTail = '';

  ff.stdout.on('data', chunk => {
    if (!startedStreaming) {
      startedStreaming = true;
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');
    }
    res.write(chunk);
  });

  ff.stderr.on('data', d => {
    const line = d.toString().trim();
    if (line) {
      stderrTail = (stderrTail + '\n' + line).slice(-1500);
    }
    if (line.includes('time=') || line.includes('Error') || line.includes('error')) {
      console.log('[ffmpeg]', line.slice(0, 200));
    }
  });

  ff.on('close', code => {
    console.log(`[merge] ffmpeg exited ${code} - ${safeFilename}`);
    if (code !== 0) {
      console.error('[merge] ffmpeg failed', { code, safeFilename, stderrTail: stderrTail.slice(-400) });
      if (!startedStreaming && !res.headersSent) {
        return res.status(502).json({ error: 'ffmpeg_failed', code, details: stderrTail.slice(-300) });
      }
    }
    if (!res.writableEnded) res.end();
  });

  ff.on('error', err => {
    console.error('[merge] spawn error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });

  req.on('close', () => {
    if (!ff.killed) {
      ff.kill('SIGTERM');
      console.log('[merge] client disconnected, killed ffmpeg');
    }
  });
}

app.post('/merge-init', (req, res) => {
  const { videoUrl, audioUrl, filename } = req.body || {};
  if (!videoUrl || !audioUrl) {
    return res.status(400).json({ error: 'videoUrl and audioUrl required' });
  }

  const id = crypto.randomBytes(12).toString('hex');
  mergeJobs.set(id, {
    videoUrl: String(videoUrl),
    audioUrl: String(audioUrl),
    filename: String(filename || 'video.mp4'),
    createdAt: Date.now(),
  });

  const base = `${req.protocol}://${req.get('host')}`;
  return res.json({ ok: true, id, downloadUrl: `${base}/merge/${id}` });
});

app.head('/merge/:id', (req, res) => {
  const job = mergeJobs.get(req.params.id);
  if (!job) return res.status(404).end();

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-cache');
  return res.status(200).end();
});

app.get('/merge/:id', (req, res) => {
  const job = mergeJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'merge job not found or expired' });

  // keep briefly for duplicate browser requests
  setTimeout(() => mergeJobs.delete(req.params.id), 90 * 1000).unref();
  return streamMerge(job, req, res);
});

app.get('/merge', (req, res) => {
  const { videoUrl, audioUrl, filename } = req.query;
  if (!videoUrl || !audioUrl) {
    return res.status(400).json({ error: 'videoUrl and audioUrl required' });
  }
  return streamMerge(
    { videoUrl: String(videoUrl), audioUrl: String(audioUrl), filename: String(filename || 'video.mp4') },
    req,
    res
  );
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`yt-merger running on port ${PORT}`));

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

// ─────────────────────────────────────────────────────────────────────────────
// GET /merge?videoUrl=...&audioUrl=...&filename=...
//
// Chrome פותח הורדה ישירה לURL הזה.
// השרת מוריד וידאו ואודיו במקביל, ממזג עם ffmpeg, ומשדר ישר.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/merge', async (req, res) => {
  const { videoUrl, audioUrl, filename } = req.query;

  if (!videoUrl || !audioUrl) {
    return res.status(400).json({ error: 'videoUrl and audioUrl required' });
  }

  const safeFilename = (filename || 'video.mp4')
    .replace(/[^\w\s\-.()]/g, '_')
    .slice(0, 200);

  console.log('[merge] starting:', safeFilename);

  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  const tmpDir  = os.tmpdir();
  const videoTmp = path.join(tmpDir, `v_${Date.now()}.mp4`);
  const audioTmp = path.join(tmpDir, `a_${Date.now()}.webm`);

  // ניקוי קבצים זמניים
  function cleanup() {
    try { fs.unlinkSync(videoTmp); } catch(e) {}
    try { fs.unlinkSync(audioTmp); } catch(e) {}
  }

  try {
    // הורד וידאו ואודיו במקביל לדיסק זמני
    console.log('[merge] downloading video + audio in parallel...');
    const [videoResp, audioResp] = await Promise.all([
      fetch(decodeURIComponent(videoUrl), {
        headers: { 'User-Agent': UA, 'Referer': 'https://www.youtube.com/' }
      }),
      fetch(decodeURIComponent(audioUrl), {
        headers: { 'User-Agent': UA, 'Referer': 'https://www.youtube.com/' }
      }),
    ]);

    if (!videoResp.ok) throw new Error(`video fetch failed: ${videoResp.status} ${videoResp.statusText}`);
    if (!audioResp.ok) throw new Error(`audio fetch failed: ${audioResp.status} ${audioResp.statusText}`);

    // שמור לדיסק זמני במקביל
    await Promise.all([
      streamToFile(videoResp.body, videoTmp),
      streamToFile(audioResp.body, audioTmp),
    ]);

    const videoSize = fs.statSync(videoTmp).size;
    const audioSize = fs.statSync(audioTmp).size;
    console.log(`[merge] downloaded: video=${(videoSize/1e6).toFixed(1)}MB audio=${(audioSize/1e6).toFixed(1)}MB`);

    if (videoSize < 1000) throw new Error('video file too small — YouTube rejected the URL');
    if (audioSize < 1000) throw new Error('audio file too small — YouTube rejected the URL');

    // Headers לChrome — הורדה מיידית
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    res.setHeader('Transfer-Encoding', 'chunked');

    console.log('[merge] starting ffmpeg...');

    // ffmpeg ממזג ומשדר ישר ל-response
    ffmpeg()
      .input(videoTmp)
      .input(audioTmp)
      .outputOptions([
        '-c:v', 'copy',       // copy video — מהיר! אין re-encoding
        '-c:a', 'aac',        // encode audio ל-AAC
        '-ab', '192k',
        '-movflags', 'frag_keyframe+empty_moov+faststart',
        '-f', 'mp4',
      ])
      .on('start', cmd => console.log('[ffmpeg] cmd:', cmd.slice(0, 120)))
      .on('end', () => {
        console.log('[merge] done:', safeFilename);
        cleanup();
      })
      .on('error', (err) => {
        console.error('[ffmpeg] error:', err.message);
        cleanup();
        if (!res.writableEnded) res.end();
      })
      .pipe(res, { end: true });

  } catch (err) {
    cleanup();
    console.error('[merge] error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.end();
    }
  }
});

// helper: שמור ReadableStream לקובץ
function streamToFile(readableStream, filePath) {
  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(filePath);
    readableStream.pipe(writeStream);
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
    readableStream.on('error', reject);
  });
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`yt-merger running on port ${PORT}`));

/**
 * @author Rocky Chowdhury
 * YouTube Video API with MongoDB Cache + Cookie bypass
 */

const express = require("express");
const cors = require("cors");
const ytdl = require("@distube/ytdl-core");
const { MongoClient } = require("mongodb");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGODB_URI;
const YT_KEY = process.env.YOUTUBE_API_KEY;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── MongoDB ──────────────────────────────────────────────────────────────────
let db;
async function connectDB() {
  if (!MONGO_URI) return;
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db("rocky_api");
    await db.collection("video_cache").createIndex({ createdAt: 1 }, { expireAfterSeconds: 21600 });
    await db.collection("search_cache").createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600 });
    console.log("✅ MongoDB connected");
  } catch (e) { console.error("MongoDB:", e.message); }
}

async function getCache(col, query) {
  if (!db) return null;
  try { return await db.collection(col).findOne(query); } catch { return null; }
}
async function setCache(col, query, data) {
  if (!db) return;
  try {
    await db.collection(col).updateOne(query, { $set: { ...data, createdAt: new Date() } }, { upsert: true });
  } catch {}
}

// ── ytdl agent with cookies to bypass 429 ───────────────────────────────────
function getAgent() {
  // Use cookie-based agent to bypass YouTube bot detection
  const cookies = [
    { name: "CONSENT", value: "YES+", domain: ".youtube.com" },
    { name: "VISITOR_INFO1_LIVE", value: "random_" + Math.random().toString(36).substring(7), domain: ".youtube.com" },
  ];
  return ytdl.createAgent(cookies);
}

// ── Routes ───────────────────────────────────────────────────────────────────
app.get("/api", (req, res) => {
  res.json({
    author: "Rocky Chowdhury",
    name: "Rocky Video API",
    version: "3.0.0",
    status: "online",
    endpoints: {
      search: "/api/video/search?songName=<query>",
      download: "/api/video/download?link=<videoID>&format=mp4",
    },
  });
});

// ── Search ───────────────────────────────────────────────────────────────────
app.get("/api/video/search", async (req, res) => {
  const { songName } = req.query;
  if (!songName) return res.status(400).json({ error: "Missing: songName" });
  if (!YT_KEY) return res.status(500).json({ error: "YOUTUBE_API_KEY not set" });

  const cached = await getCache("search_cache", { query: songName.toLowerCase() });
  if (cached) return res.json(cached.results);

  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(songName)}&maxResults=10&type=video&key=${YT_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    const results = data.items.map(item => ({
      id: item.id.videoId,
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails.high?.url || item.snippet.thumbnails.default?.url,
      publishedAt: item.snippet.publishedAt,
      url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
    }));

    await setCache("search_cache", { query: songName.toLowerCase() }, { query: songName.toLowerCase(), results });
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Download ─────────────────────────────────────────────────────────────────
app.get("/api/video/download", async (req, res) => {
  const { link } = req.query;
  if (!link) return res.status(400).json({ error: "Missing: link" });

  const videoId = link.startsWith("http")
    ? (link.match(/(?:v=|youtu\.be\/)([\w-]{11})/) || [])[1]
    : link;

  if (!videoId) return res.status(400).json({ error: "Invalid video ID" });

  // Check cache
  const cached = await getCache("video_cache", { videoId });
  if (cached) {
    return res.json({ title: cached.title, videoId, thumbnail: cached.thumbnail, quality: cached.quality, downloadLink: cached.downloadLink, author: "Rocky Chowdhury", cached: true });
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // Method 1: ytdl with agent
  try {
    const agent = getAgent();
    const info = await ytdl.getInfo(videoUrl, {
      agent,
      requestOptions: {
        headers: {
          "User-Agent": "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          "Accept-Encoding": "gzip, deflate, br",
          "Connection": "keep-alive",
        },
      },
    });

    const title = info.videoDetails.title;
    const thumbnail = info.videoDetails.thumbnails.slice(-1)[0]?.url || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

    let formats = ytdl.filterFormats(info.formats, "videoandaudio")
      .filter(f => f.container === "mp4")
      .sort((a, b) => (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0));

    if (!formats.length) {
      formats = info.formats.filter(f => f.container === "mp4" && f.hasVideo)
        .sort((a, b) => (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0));
    }

    if (!formats.length) throw new Error("No mp4 format");

    const best = formats[0];
    const result = { title, videoId, thumbnail, quality: best.qualityLabel || "360p", downloadLink: best.url };
    await setCache("video_cache", { videoId }, result);
    return res.json({ ...result, author: "Rocky Chowdhury", cached: false });

  } catch (err) {
    console.error("ytdl error:", err.message);
  }

  // Method 2: Invidious fallback
  const instances = [
    "https://inv.nadeko.net",
    "https://invidious.privacyredirect.com",
    "https://iv.datura.network",
    "https://invidious.nerdvpn.de",
    "https://yt.cdaut.de",
    "https://invidious.io.lol",
    "https://invidious.lunar.icu",
    "https://invidious.sethforprivacy.com",
  ];

  for (const base of instances) {
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(`${base}/api/v1/videos/${videoId}`, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: ctrl.signal,
      });
      if (!r.ok) continue;
      const d = await r.json();

      const streams = (d.formatStreams || [])
        .filter(f => f.container === "mp4")
        .sort((a, b) => parseInt(b.resolution) - parseInt(a.resolution));

      if (streams.length > 0) {
        const result = {
          title: d.title || "YouTube Video",
          videoId,
          thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
          quality: streams[0].qualityLabel || "360p",
          downloadLink: streams[0].url,
        };
        await setCache("video_cache", { videoId }, result);
        return res.json({ ...result, author: "Rocky Chowdhury", cached: false, source: "invidious" });
      }
    } catch (_) { continue; }
  }

  // Method 3: Piped API
  const pipedInstances = [
    "https://pipedapi.kavin.rocks",
    "https://pipedapi.syncpundit.io",
    "https://pipedapi.moomoo.me",
  ];

  for (const base of pipedInstances) {
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(`${base}/streams/${videoId}`, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: ctrl.signal,
      });
      if (!r.ok) continue;
      const d = await r.json();

      const streams = (d.videoStreams || [])
        .filter(s => s.mimeType?.includes("video/mp4") && !s.videoOnly && s.url)
        .sort((a, b) => (b.quality || 0) - (a.quality || 0));

      if (streams.length > 0) {
        const result = {
          title: d.title || "YouTube Video",
          videoId,
          thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
          quality: streams[0].qualityLabel || "360p",
          downloadLink: streams[0].url,
        };
        await setCache("video_cache", { videoId }, result);
        return res.json({ ...result, author: "Rocky Chowdhury", cached: false, source: "piped" });
      }
    } catch (_) { continue; }
  }

  return res.status(500).json({ error: "Download failed: YouTube is blocking this server. Please try again later." });
});

// ── Start ─────────────────────────────────────────────────────────────────────
connectDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Rocky Video API on port ${PORT}`));
});

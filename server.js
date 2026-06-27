/**
 * @author Rocky Chowdhury
 * YouTube Video API with MongoDB Cache
 * Same structure as original MahMUD API
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

// ── MongoDB Connection ───────────────────────────────────────────────────────
let db;
async function connectDB() {
  if (!MONGO_URI) { console.log("No MongoDB URI, cache disabled"); return; }
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db("rocky_api");
    console.log("✅ MongoDB connected");
    // Create TTL index - cache expires after 6 hours
    await db.collection("video_cache").createIndex({ createdAt: 1 }, { expireAfterSeconds: 21600 });
  } catch (e) {
    console.error("MongoDB error:", e.message);
  }
}

// ── Cache helpers ────────────────────────────────────────────────────────────
async function getCache(videoId) {
  if (!db) return null;
  try {
    return await db.collection("video_cache").findOne({ videoId });
  } catch { return null; }
}

async function setCache(videoId, data) {
  if (!db) return;
  try {
    await db.collection("video_cache").updateOne(
      { videoId },
      { $set: { ...data, videoId, createdAt: new Date() } },
      { upsert: true }
    );
  } catch (e) { console.error("Cache set error:", e.message); }
}

// ── API: Home ────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

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
    example: {
      search: "/api/video/search?songName=shape+of+you",
      download: "/api/video/download?link=JGwWNGJdvx8&format=mp4",
    },
  });
});

// ── API: Search ──────────────────────────────────────────────────────────────
app.get("/api/video/search", async (req, res) => {
  const { songName } = req.query;
  if (!songName) return res.status(400).json({ error: "Missing: songName" });
  if (!YT_KEY) return res.status(500).json({ error: "YOUTUBE_API_KEY not set" });

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

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: Download ────────────────────────────────────────────────────────────
app.get("/api/video/download", async (req, res) => {
  const { link } = req.query;
  if (!link) return res.status(400).json({ error: "Missing: link" });

  const videoId = link.startsWith("http")
    ? (link.match(/(?:v=|youtu\.be\/)([\w-]{11})/) || [])[1]
    : link;

  if (!videoId) return res.status(400).json({ error: "Invalid video ID" });

  // Check MongoDB cache first
  const cached = await getCache(videoId);
  if (cached) {
    console.log(`Cache hit: ${videoId}`);
    return res.json({
      title: cached.title,
      videoId: cached.videoId,
      thumbnail: cached.thumbnail,
      quality: cached.quality,
      downloadLink: cached.downloadLink,
      author: "Rocky Chowdhury",
      cached: true,
    });
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    const agent = ytdl.createAgent(undefined, {
      localAddress: undefined,
    });

    const info = await ytdl.getInfo(videoUrl, {
      agent,
      requestOptions: {
        headers: {
          "User-Agent": "Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      },
    });

    const title = info.videoDetails.title;
    const thumbnail = info.videoDetails.thumbnails.slice(-1)[0]?.url
      || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

    // Best mp4 with audio+video
    let formats = ytdl.filterFormats(info.formats, "videoandaudio")
      .filter(f => f.container === "mp4")
      .sort((a, b) => (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0));

    // Fallback
    if (!formats.length) {
      formats = info.formats
        .filter(f => f.container === "mp4" && f.hasVideo)
        .sort((a, b) => (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0));
    }

    const best = formats[0];
    if (!best) return res.status(404).json({ error: "No mp4 format found" });

    const result = {
      title,
      videoId,
      thumbnail,
      quality: best.qualityLabel || "360p",
      downloadLink: best.url,
    };

    // Save to MongoDB cache
    await setCache(videoId, result);

    return res.json({ ...result, author: "Rocky Chowdhury", cached: false });

  } catch (err) {
    console.error("ytdl error:", err.message);

    // Try Invidious as fallback
    try {
      const inv = await tryInvidious(videoId);
      if (inv?.downloadLink) {
        await setCache(videoId, inv);
        return res.json({ ...inv, author: "Rocky Chowdhury", cached: false });
      }
    } catch (e2) {
      console.error("Invidious fallback failed:", e2.message);
    }

    return res.status(500).json({ error: "Download failed: " + err.message });
  }
});

// ── Invidious fallback ───────────────────────────────────────────────────────
async function tryInvidious(videoId) {
  const instances = [
    "https://inv.nadeko.net",
    "https://invidious.privacyredirect.com",
    "https://iv.datura.network",
    "https://invidious.nerdvpn.de",
  ];
  for (const base of instances) {
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 7000);
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
        return {
          title: d.title || "YouTube Video",
          videoId,
          thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
          quality: streams[0].qualityLabel || "360p",
          downloadLink: streams[0].url,
        };
      }
    } catch (_) { continue; }
  }
  return null;
}

// ── Start ────────────────────────────────────────────────────────────────────
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Rocky Video API on port ${PORT}`);
  });
});

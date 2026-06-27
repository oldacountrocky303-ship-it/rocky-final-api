/**
 * @author Rocky Chowdhury
 * YouTube Video Download
 * Route: /api/video/download?link=<videoID>&format=mp4
 */

const ytdl = require("@distube/ytdl-core");
const { MongoClient } = require("mongodb");

let db;
async function getDB() {
  if (db) return db;
  if (!process.env.MONGODB_URI) return null;
  try {
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    db = client.db("rocky_api");
    await db.collection("video_cache").createIndex({ createdAt: 1 }, { expireAfterSeconds: 21600 });
    return db;
  } catch (e) {
    console.error("MongoDB:", e.message);
    return null;
  }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  const { link } = req.query;
  if (!link) return res.status(400).json({ error: "Missing: link" });

  const videoId = link.startsWith("http")
    ? (link.match(/(?:v=|youtu\.be\/)([\w-]{11})/) || [])[1]
    : link;

  if (!videoId) return res.status(400).json({ error: "Invalid video ID" });

  // Check MongoDB cache first
  const database = await getDB();
  if (database) {
    try {
      const cached = await database.collection("video_cache").findOne({ videoId });
      if (cached) {
        console.log("Cache hit:", videoId);
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
    } catch (_) {}
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // Try ytdl-core first
  try {
    const info = await ytdl.getInfo(videoUrl, {
      requestOptions: {
        headers: {
          "User-Agent": "Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
        },
      },
    });

    const title = info.videoDetails.title;
    const thumbnail = info.videoDetails.thumbnails.slice(-1)[0]?.url
      || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

    // Best combined mp4 (video + audio)
    let formats = ytdl.filterFormats(info.formats, "videoandaudio")
      .filter(f => f.container === "mp4")
      .sort((a, b) => (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0));

    if (!formats.length) {
      formats = info.formats
        .filter(f => f.container === "mp4" && f.hasVideo)
        .sort((a, b) => (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0));
    }

    const best = formats[0];
    if (!best) throw new Error("No mp4 format found");

    const result = {
      title,
      videoId,
      thumbnail,
      quality: best.qualityLabel || "360p",
      downloadLink: best.url,
    };

    // Save to MongoDB cache
    if (database) {
      try {
        await database.collection("video_cache").updateOne(
          { videoId },
          { $set: { ...result, createdAt: new Date() } },
          { upsert: true }
        );
      } catch (_) {}
    }

    return res.json({ ...result, author: "Rocky Chowdhury", cached: false });

  } catch (ytdlErr) {
    console.error("ytdl failed:", ytdlErr.message);

    // Fallback: Invidious instances
    const instances = [
      "https://inv.nadeko.net",
      "https://invidious.privacyredirect.com",
      "https://iv.datura.network",
      "https://invidious.nerdvpn.de",
      "https://yt.cdaut.de",
      "https://invidious.io.lol",
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
          const result = {
            title: d.title || "YouTube Video",
            videoId,
            thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
            quality: streams[0].qualityLabel || "360p",
            downloadLink: streams[0].url,
          };

          // Cache it
          if (database) {
            try {
              await database.collection("video_cache").updateOne(
                { videoId },
                { $set: { ...result, createdAt: new Date() } },
                { upsert: true }
              );
            } catch (_) {}
          }

          return res.json({ ...result, author: "Rocky Chowdhury", cached: false, source: base });
        }
      } catch (_) { continue; }
    }

    return res.status(500).json({ error: "All download methods failed. Try again later." });
  }
};

/**
 * @author Rocky Chowdhury
 * YouTube Video Search
 * Route: /api/video/search?songName=<query>
 */

const { MongoClient } = require("mongodb");

let db;
async function getDB() {
  if (db) return db;
  if (!process.env.MONGODB_URI) return null;
  try {
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    db = client.db("rocky_api");
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

  const { songName } = req.query;
  if (!songName) return res.status(400).json({ error: "Missing: songName" });

  const YT_KEY = process.env.YOUTUBE_API_KEY;
  if (!YT_KEY) return res.status(500).json({ error: "YOUTUBE_API_KEY not set" });

  // Check cache
  const database = await getDB();
  if (database) {
    try {
      const cached = await database.collection("search_cache").findOne({ query: songName.toLowerCase() });
      if (cached) {
        console.log("Search cache hit:", songName);
        return res.json(cached.results);
      }
    } catch (_) {}
  }

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

    // Save to cache (expires in 1 hour)
    if (database) {
      try {
        await database.collection("search_cache").createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600 });
        await database.collection("search_cache").updateOne(
          { query: songName.toLowerCase() },
          { $set: { query: songName.toLowerCase(), results, createdAt: new Date() } },
          { upsert: true }
        );
      } catch (_) {}
    }

    return res.json(results);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

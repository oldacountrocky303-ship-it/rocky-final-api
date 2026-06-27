/**
 * @author Rocky Chowdhury
 * API Home
 */

module.exports = (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.status(200).json({
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
    message: "Welcome to Rocky Chowdhury's YouTube Video API 🎬",
  });
};

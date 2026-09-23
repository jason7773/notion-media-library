import { defineConfig, loadEnv } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { handleAlbums, handleCover, handleDemoCatalog, handleDemoCoverAsset, handleDemoMediaAsset, handleDemoPage, handleDemoSubtitleAsset, handleDemoTrackInfo, handleLibrary, handlePlaylist, handleTrackInfo, handleVideo, handleVideoCover, handleVideoStream, handleVideoSubtitle, handleVideos } from "./functions/server/handlers.js";
import { handleAdminAuditLogs, handleAdminUsers, handleAdminVideoReports, handleAdminWatchEvents, handleAdminWatchProgress, handleAdminWishlist, handleMe, handleSession, handleVideoReports, handleWatchEvents, handleWatchProgress, handleWishlist } from "./functions/server/auth.js";

function copyEnv(mode) {
  const env = loadEnv(mode, process.cwd(), "");
  for (const [key, value] of Object.entries(env)) {
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function apiPlugin(mode) {
  copyEnv(mode);

  return {
    name: "local-notion-api",
    configureServer(server) {
      server.middlewares.use("/api/albums", async (req, res) => {
        await handleAlbums(req, res);
      });

      server.middlewares.use("/api/session", async (req, res) => {
        await handleSession(req, res);
      });

      server.middlewares.use("/api/demo", async (req, res, next) => {
        const path = req.url.split("?")[0].replace(/^\/+/, "");
        const catalog = path.match(/^(albums|library|videos)\/?$/);
        if (catalog) {
          await handleDemoCatalog(req, res, catalog[1]);
          return;
        }
        const track = path.match(/^(track|track-info)\/([^/]+)\/([^/]+)\/?$/);
        if (track) {
          const [, kind, albumId, blockId] = track.map((item) => item && decodeURIComponent(item));
          if (kind === "track-info") await handleDemoTrackInfo(req, res, albumId, blockId);
          else await handleDemoMediaAsset(req, res, "music", albumId, blockId);
          return;
        }
        const subtitle = path.match(/^video-subtitle\/([^/]+)\/(\d+)\/?$/);
        if (subtitle) {
          await handleDemoSubtitleAsset(req, res, decodeURIComponent(subtitle[1]), subtitle[2]);
          return;
        }
        const item = path.match(/^(playlist|album|video|video-stream|cover|video-cover)\/([^/]+)\/?$/);
        if (item) {
          const [, kind, pageId] = item.map((value) => value && decodeURIComponent(value));
          if (kind === "video-stream") await handleDemoMediaAsset(req, res, "video", pageId);
          else if (kind === "cover" || kind === "video-cover") await handleDemoCoverAsset(req, res, kind === "cover" ? "music" : "video", pageId);
          else await handleDemoPage(req, res, kind, pageId);
          return;
        }
        next();
      });

      server.middlewares.use("/api/me", async (req, res) => {
        await handleMe(req, res);
      });

      server.middlewares.use("/api/admin/users", async (req, res) => {
        const uid = decodeURIComponent(req.url.split("?")[0].replace(/^\/+/, ""));
        await handleAdminUsers(req, res, uid || undefined);
      });

      server.middlewares.use("/api/admin/watch-progress", async (req, res) => {
        await handleAdminWatchProgress(req, res);
      });

      server.middlewares.use("/api/admin/watch-events", async (req, res) => {
        await handleAdminWatchEvents(req, res);
      });

      server.middlewares.use("/api/admin/wishlist", async (req, res) => {
        const wishId = decodeURIComponent(req.url.split("?")[0].replace(/^\/+/, ""));
        await handleAdminWishlist(req, res, wishId || undefined);
      });

      server.middlewares.use("/api/admin/video-reports", async (req, res) => {
        const reportId = decodeURIComponent(req.url.split("?")[0].replace(/^\/+/, ""));
        await handleAdminVideoReports(req, res, reportId || undefined);
      });

      server.middlewares.use("/api/admin/audit-logs", async (req, res) => {
        await handleAdminAuditLogs(req, res);
      });

      server.middlewares.use("/api/watch-progress", async (req, res) => {
        const videoId = decodeURIComponent(req.url.split("?")[0].replace(/^\/+/, ""));
        await handleWatchProgress(req, res, videoId || undefined);
      });

      server.middlewares.use("/api/watch-events", async (req, res) => {
        await handleWatchEvents(req, res);
      });

      server.middlewares.use("/api/video-reports", async (req, res) => {
        await handleVideoReports(req, res);
      });

      server.middlewares.use("/api/wishlist", async (req, res) => {
        const wishId = decodeURIComponent(req.url.split("?")[0].replace(/^\/+/, ""));
        await handleWishlist(req, res, wishId || undefined);
      });

      server.middlewares.use("/api/library", async (req, res) => {
        await handleLibrary(req, res);
      });

      server.middlewares.use("/api/videos", async (req, res) => {
        await handleVideos(req, res);
      });

      server.middlewares.use("/api/video-cover", async (req, res) => {
        const pageId = decodeURIComponent(req.url.split("?")[0].replace(/^\/+/, ""));
        await handleVideoCover(req, res, pageId);
      });

      server.middlewares.use("/api/video-subtitle", async (req, res) => {
        const [pageId, subtitleIndex] = req.url
          .split("?")[0]
          .replace(/^\/+/, "")
          .split("/")
          .map(decodeURIComponent);
        await handleVideoSubtitle(req, res, pageId, subtitleIndex);
      });

      server.middlewares.use("/api/video-stream", async (req, res) => {
        const pageId = decodeURIComponent(req.url.split("?")[0].replace(/^\/+/, ""));
        await handleVideoStream(req, res, pageId);
      });

      server.middlewares.use("/api/video", async (req, res) => {
        const pageId = decodeURIComponent(req.url.split("?")[0].replace(/^\/+/, ""));
        await handleVideo(req, res, pageId);
      });

      server.middlewares.use("/api/cover", async (req, res) => {
        const pageId = decodeURIComponent(req.url.split("?")[0].replace(/^\/+/, ""));
        await handleCover(req, res, pageId);
      });

      server.middlewares.use("/api/playlist", async (req, res) => {
        const pageId = decodeURIComponent(req.url.split("?")[0].replace(/^\/+/, ""));
        await handlePlaylist(req, res, pageId);
      });

      server.middlewares.use("/api/track-info", async (req, res) => {
        const [pageId, blockId] = req.url
          .split("?")[0]
          .replace(/^\/+/, "")
          .split("/")
          .map(decodeURIComponent);
        await handleTrackInfo(req, res, pageId, blockId);
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), apiPlugin(mode)],
}));

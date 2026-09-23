import { defineSecret, defineString } from "firebase-functions/params";
import { onRequest } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2/options";
import { handleAlbums, handleCover, handleDemoCatalog, handleDemoCoverAsset, handleDemoMediaAsset, handleDemoPage, handleDemoSubtitleAsset, handleDemoTrackInfo, handleLibrary, handlePlaylist, handleTrackInfo, handleVideo, handleVideoCover, handleVideoStream, handleVideoSubtitle, handleVideos } from "./server/handlers.js";
import {
  handleAdminAuditLogs,
  handleAdminUsers,
  handleAdminVideoReports,
  handleAdminWatchEvents,
  handleAdminWatchProgress,
  handleAdminWishlist,
  handleMe,
  handleSession,
  handleVideoReports,
  handleWatchEvents,
  handleWatchProgress,
  handleWishlist,
} from "./server/auth.js";

const notionToken = defineSecret("NOTION_TOKEN");
const notionDataSourceId = defineString("NOTION_DATA_SOURCE_ID");
const notionVideoDataSourceId = defineString("NOTION_VIDEO_DATA_SOURCE_ID");
const notionDemoMusicDataSourceId = defineString("NOTION_DEMO_MUSIC_DATA_SOURCE_ID", { default: "" });
const notionDemoVideoDataSourceId = defineString("NOTION_DEMO_VIDEO_DATA_SOURCE_ID", { default: "" });
const allowedOrigins = defineString("ALLOWED_ORIGINS", { default: "" });
const adminEmails = defineString("ADMIN_EMAILS", { default: "" });

setGlobalOptions({
  cpu: "gcf_gen1",
});

function prepareConfig() {
  process.env.NOTION_TOKEN = notionToken.value();
  process.env.NOTION_DATA_SOURCE_ID = notionDataSourceId.value();
  process.env.NOTION_VIDEO_DATA_SOURCE_ID = notionVideoDataSourceId.value();
  process.env.NOTION_DEMO_MUSIC_DATA_SOURCE_ID = notionDemoMusicDataSourceId.value();
  process.env.NOTION_DEMO_VIDEO_DATA_SOURCE_ID = notionDemoVideoDataSourceId.value();
  process.env.ALLOWED_ORIGINS = allowedOrigins.value();
  process.env.ADMIN_EMAILS = adminEmails.value();
}

export const api = onRequest(
  {
    region: "us-central1",
    secrets: [notionToken],
    timeoutSeconds: 3600,
    maxInstances: 10,
  },
  async (req, res) => {
    prepareConfig();

    const path = req.path.replace(/^\/api(?=\/|$)/, "");
    if (path === "/session" || path === "/session/") {
      await handleSession(req, res);
      return;
    }

    const demoCatalogMatch = path.match(/^\/demo\/(albums|library|videos)\/?$/);
    if (demoCatalogMatch) {
      await handleDemoCatalog(req, res, demoCatalogMatch[1]);
      return;
    }

    const demoPlaylistMatch = path.match(/^\/demo\/(playlist|album|video|video-stream|cover|video-cover)\/([^/]+)\/?$/);
    if (demoPlaylistMatch) {
      const [, kind, pageId] = demoPlaylistMatch;
      if (kind === "video-stream") {
        await handleDemoMediaAsset(req, res, "video", decodeURIComponent(pageId));
      } else if (kind === "cover" || kind === "video-cover") {
        await handleDemoCoverAsset(req, res, kind === "cover" ? "music" : "video", decodeURIComponent(pageId));
      } else {
        await handleDemoPage(req, res, kind, decodeURIComponent(pageId));
      }
      return;
    }

    const demoTrackMatch = path.match(/^\/demo\/(track|track-info)\/([^/]+)\/([^/]+)\/?$/);
    if (demoTrackMatch) {
      const [, kind, albumId, blockId] = demoTrackMatch;
      if (kind === "track-info") {
        await handleDemoTrackInfo(req, res, decodeURIComponent(albumId), decodeURIComponent(blockId));
      } else {
        await handleDemoMediaAsset(req, res, "music", decodeURIComponent(albumId), decodeURIComponent(blockId));
      }
      return;
    }

    const demoSubtitleMatch = path.match(/^\/demo\/video-subtitle\/([^/]+)\/(\d+)\/?$/);
    if (demoSubtitleMatch) {
      await handleDemoSubtitleAsset(req, res, decodeURIComponent(demoSubtitleMatch[1]), demoSubtitleMatch[2]);
      return;
    }

    if (path === "/me" || path === "/me/") {
      await handleMe(req, res);
      return;
    }

    if (path === "/admin/users" || path === "/admin/users/") {
      await handleAdminUsers(req, res);
      return;
    }

    const adminUserMatch = path.match(/^\/admin\/users\/([^/]+)\/?$/);
    if (adminUserMatch) {
      await handleAdminUsers(req, res, decodeURIComponent(adminUserMatch[1]));
      return;
    }

    if (path === "/admin/watch-progress" || path === "/admin/watch-progress/") {
      await handleAdminWatchProgress(req, res);
      return;
    }

    if (path === "/admin/watch-events" || path === "/admin/watch-events/") {
      await handleAdminWatchEvents(req, res);
      return;
    }

    if (path === "/admin/wishlist" || path === "/admin/wishlist/") {
      await handleAdminWishlist(req, res);
      return;
    }

    if (path === "/admin/wishlist:batch" || path === "/admin/wishlist:batch/") {
      await handleAdminWishlist(req, res, ":batch");
      return;
    }

    const adminWishlistMatch = path.match(/^\/admin\/wishlist\/([^/]+)\/?$/);
    if (adminWishlistMatch) {
      await handleAdminWishlist(req, res, decodeURIComponent(adminWishlistMatch[1]));
      return;
    }

    if (path === "/admin/video-reports" || path === "/admin/video-reports/") {
      await handleAdminVideoReports(req, res);
      return;
    }

    const adminVideoReportMatch = path.match(/^\/admin\/video-reports\/([^/]+)\/?$/);
    if (adminVideoReportMatch) {
      await handleAdminVideoReports(req, res, decodeURIComponent(adminVideoReportMatch[1]));
      return;
    }

    if (path === "/admin/audit-logs" || path === "/admin/audit-logs/") {
      await handleAdminAuditLogs(req, res);
      return;
    }

    if (path === "/watch-progress" || path === "/watch-progress/") {
      await handleWatchProgress(req, res);
      return;
    }

    const watchProgressMatch = path.match(/^\/watch-progress\/([^/]+)\/?$/);
    if (watchProgressMatch) {
      await handleWatchProgress(req, res, decodeURIComponent(watchProgressMatch[1]));
      return;
    }

    if (path === "/watch-events" || path === "/watch-events/") {
      await handleWatchEvents(req, res);
      return;
    }

    if (path === "/video-reports" || path === "/video-reports/") {
      await handleVideoReports(req, res);
      return;
    }

    if (path === "/wishlist" || path === "/wishlist/") {
      await handleWishlist(req, res);
      return;
    }

    const wishlistMatch = path.match(/^\/wishlist\/([^/]+)\/?$/);
    if (wishlistMatch) {
      await handleWishlist(req, res, decodeURIComponent(wishlistMatch[1]));
      return;
    }

    if (path === "/albums" || path === "/albums/") {
      await handleAlbums(req, res);
      return;
    }

    if (path === "/library" || path === "/library/") {
      await handleLibrary(req, res);
      return;
    }

    if (path === "/videos" || path === "/videos/") {
      await handleVideos(req, res);
      return;
    }

    const videoCoverMatch = path.match(/^\/video-cover\/([^/]+)\/?$/);
    if (videoCoverMatch) {
      await handleVideoCover(req, res, decodeURIComponent(videoCoverMatch[1]));
      return;
    }

    const videoStreamMatch = path.match(/^\/video-stream\/([^/]+)\/?$/);
    if (videoStreamMatch) {
      await handleVideoStream(req, res, decodeURIComponent(videoStreamMatch[1]));
      return;
    }

    const videoMatch = path.match(/^\/video\/([^/]+)\/?$/);
    if (videoMatch) {
      await handleVideo(req, res, decodeURIComponent(videoMatch[1]));
      return;
    }

    const videoSubtitleMatch = path.match(/^\/video-subtitle\/([^/]+)\/(\d+)\/?$/);
    if (videoSubtitleMatch) {
      await handleVideoSubtitle(
        req,
        res,
        decodeURIComponent(videoSubtitleMatch[1]),
        videoSubtitleMatch[2],
      );
      return;
    }

    const coverMatch = path.match(/^\/cover\/([^/]+)\/?$/);
    if (coverMatch) {
      await handleCover(req, res, decodeURIComponent(coverMatch[1]));
      return;
    }

    const playlistMatch = path.match(/^\/playlist\/([^/]+)\/?$/);
    if (playlistMatch) {
      await handlePlaylist(req, res, decodeURIComponent(playlistMatch[1]));
      return;
    }

    const trackInfoMatch = path.match(/^\/track-info\/([^/]+)\/([^/]+)\/?$/);
    if (trackInfoMatch) {
      await handleTrackInfo(
        req,
        res,
        decodeURIComponent(trackInfoMatch[1]),
        decodeURIComponent(trackInfoMatch[2]),
      );
      return;
    }

    res.status(404).json({ error: "Not found." });
  },
);

import { randomBytes } from "node:crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import { queryAllVideos } from "./notion.js";
import { mapVideos } from "./catalog.js";

const SESSION_COOKIE = "__session";
const SESSION_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000;
const SESSION_MAX_AGE_SECONDS = SESSION_MAX_AGE_MS / 1000;
const DEFAULT_FEATURE_FLAGS = {
  music: true,
  video: true,
  resumePlayback: true,
  beta: false,
};
const DEFAULT_CONTENT_ACCESS = {
  mode: "all",
  videoIds: [],
  series: [],
};
const WATCH_RECORD_RETENTION_DAYS = 7;
const WATCH_RECORD_PRUNE_LIMIT = 25;
const ADMIN_RESULT_LIMIT = 500;
const WISHLIST_RESULT_LIMIT = 100;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const WISHLIST_WRITE_LIMIT_PER_HOUR = 10;
const VIDEO_REPORT_WRITE_LIMIT_PER_HOUR = 20;
const MAX_PROGRESS_TITLE_LENGTH = 200;
const MAX_PROGRESS_SERIES_LENGTH = 120;
const MAX_EVENT_TYPE_LENGTH = 40;
const MAX_SESSION_ID_LENGTH = 120;
const MAX_USER_AGENT_LENGTH = 500;
const MAX_IP_ADDRESS_LENGTH = 120;
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const DEFAULT_ALLOWED_ORIGINS = [


  "http://localhost:5173",
  "http://127.0.0.1:5173",
];
const WISHLIST_STATUSES = new Set(["new", "reviewing", "planned", "added", "rejected", "cancelled"]);
const WISHLIST_TYPES = new Set(["movie", "feature"]);
const VIDEO_REPORT_STATUSES = new Set(["new", "reviewing", "fixed", "rejected"]);
const VIDEO_REPORT_TYPES = new Set([
  "broken_video",
  "wrong_subtitle",
  "missing_subtitle",
  "wrong_metadata",
  "other",
]);

function ensureFirebaseApp() {
  if (!getApps().length) {
    initializeApp();
  }
}

export function getAdminAuth() {
  ensureFirebaseApp();
  return getAuth();
}

export function getDb() {
  ensureFirebaseApp();
  return getFirestore();
}

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function adminEmails() {
  return new Set(
    String(process.env.ADMIN_EMAILS || "")
      .split(",")
      .map(normalizeEmail)
      .filter(Boolean),
  );
}

function makeError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function clientIp(req) {
  const forwardedFor = String(req.headers["x-forwarded-for"] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .at(-1);
  return (
    forwardedFor ||
    String(req.socket?.remoteAddress || "").trim() ||
    ""
  );
}

function requestMetadata(req) {
  return {
    ipAddress: limitedString(clientIp(req), MAX_IP_ADDRESS_LENGTH),
    userAgent: limitedString(req.headers["user-agent"], MAX_USER_AGENT_LENGTH),
  };
}

function limitedString(value, maximum) {
  return String(value || "").trim().slice(0, maximum);
}

function authProvider(decodedToken) {
  return decodedToken?.firebase?.sign_in_provider || "password";
}

function mergeFeatureFlags(featureFlags = {}) {
  return { ...DEFAULT_FEATURE_FLAGS, ...featureFlags };
}

function normalizeContentAccess(contentAccess = {}) {
  const mode = ["all", "custom", "videos", "series"].includes(contentAccess.mode)
    ? contentAccess.mode
    : "all";
  return {
    mode,
    videoIds: Array.isArray(contentAccess.videoIds)
      ? contentAccess.videoIds.map(String).filter(Boolean)
      : [],
    series: Array.isArray(contentAccess.series)
      ? contentAccess.series.map(String).filter(Boolean)
      : [],
  };
}

function normalizeAllowedProviders(allowedProviders = []) {
  const providers = new Set(
    allowedProviders
      .map(String)
      .map((provider) => provider.trim())
      .filter(Boolean),
  );
  return providers.size ? [...providers] : ["google.com", "password"];
}

function normalizeUserDoc(data = {}) {
  return {
    email: normalizeEmail(data.email),
    displayName: data.displayName || "",
    role: data.role === "admin" ? "admin" : "user",
    status: data.status === "disabled" ? "disabled" : "active",
    allowedProviders: normalizeAllowedProviders(data.allowedProviders),
    featureFlags: mergeFeatureFlags(data.featureFlags),
    contentAccess: normalizeContentAccess(data.contentAccess),
  };
}

function serializeValue(value) {
  if (value instanceof Timestamp) {
    return value.toDate().toISOString();
  }
  if (value?.toDate instanceof Function) {
    return value.toDate().toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(serializeValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, serializeValue(item)]),
    );
  }
  return value ?? null;
}

function serializeProfile(uid, data) {
  return {
    uid,
    ...serializeValue(normalizeUserDoc(data)),
    createdAt: serializeValue(data.createdAt),
    updatedAt: serializeValue(data.updatedAt),
    lastLoginAt: serializeValue(data.lastLoginAt),
  };
}

function cookieValue(req) {
  const cookies = String(req.headers.cookie || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  for (const cookie of cookies) {
    const [name, ...value] = cookie.split("=");
    if (name === SESSION_COOKIE) {
      return decodeURIComponent(value.join("="));
    }
  }
  return "";
}

function isSecureRequest(req) {
  return (
    req.headers["x-forwarded-proto"] === "https" ||
    String(req.headers.host || "").endsWith(".web.app") ||
    String(req.headers.host || "").endsWith(".firebaseapp.com")
  );
}

function serializeCookie(name, value, req, options = {}) {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isSecureRequest(req)) {
    attributes.push("Secure");
  }
  if (options.maxAge !== undefined) {
    attributes.push(`Max-Age=${options.maxAge}`);
  }
  return attributes.join("; ");
}

function setSessionCookie(req, res, sessionCookie) {
  res.setHeader(
    "Set-Cookie",
    serializeCookie(SESSION_COOKIE, sessionCookie, req, {
      maxAge: SESSION_MAX_AGE_SECONDS,
    }),
  );
}

function clearSessionCookie(req, res) {
  res.setHeader(
    "Set-Cookie",
    serializeCookie(SESSION_COOKIE, "", req, { maxAge: 0 }),
  );
}

export function setApiCors(req, res) {
  const configured = process.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(",");
  const origin = req.headers.origin;
  const allowed =
    configured === "*"
      ? DEFAULT_ALLOWED_ORIGINS
      : configured
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

  if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  } else if (!origin) {
    res.setHeader("Access-Control-Allow-Origin", allowed[0] || DEFAULT_ALLOWED_ORIGINS[0]);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Vary", "Origin");
}

export function sendApiJson(req, res, status, payload, cacheControl = "no-store") {
  setApiCors(req, res);
  res.statusCode = status;
  res.setHeader("Cache-Control", cacheControl);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

export function handleApiOptions(req, res) {
  if (req.method !== "OPTIONS") {
    return false;
  }
  setApiCors(req, res);
  res.statusCode = 204;
  res.end();
  return true;
}

export function sendAuthError(req, res, error) {
  const status = error.status >= 400 && error.status < 600 ? error.status : 500;
  if (status === 500) {
    console.error(error);
  }
  sendApiJson(req, res, status, {
    error: status === 500 ? "Unable to verify access right now." : error.message,
  });
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
  }
  if (!raw.trim()) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw makeError(400, "Request body must be valid JSON.");
  }
}

async function decodedTokenFromRequest(req) {
  const authorization = String(req.headers.authorization || "");
  const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) {
    return getAdminAuth().verifyIdToken(bearerMatch[1], true);
  }

  const sessionCookie = cookieValue(req);
  if (sessionCookie) {
    return getAdminAuth().verifySessionCookie(sessionCookie, true);
  }

  throw makeError(401, "Sign in is required.");
}

async function profileForDecodedToken(decodedToken, options = {}) {
  const uid = decodedToken.uid;
  const email = normalizeEmail(decodedToken.email);
  if (!uid || !email) {
    throw makeError(403, "This account does not have a verified email identity.");
  }

  const db = getDb();
  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  const provider = authProvider(decodedToken);
  const now = FieldValue.serverTimestamp();

  if (!userSnap.exists) {
    const inviteRef = db.collection("invites").doc(email);
    const inviteSnap = await inviteRef.get();
    const isBootstrapAdmin = adminEmails().has(email);

    if (!inviteSnap.exists && !isBootstrapAdmin) {
      throw makeError(403, "This account is not allowed. Add it in the admin dashboard first.");
    }

    const invite = inviteSnap.exists ? inviteSnap.data() : {};
    const nextProfile = normalizeUserDoc({
      email,
      displayName: decodedToken.name || invite.displayName || "",
      role: isBootstrapAdmin ? "admin" : invite.role,
      status: invite.status,
      allowedProviders: invite.allowedProviders,
      featureFlags: invite.featureFlags,
      contentAccess: invite.contentAccess,
    });

    if (!nextProfile.allowedProviders.includes(provider)) {
      throw makeError(403, "This login method is not enabled for this user.");
    }

    await userRef.set({
      ...nextProfile,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: options.touchLogin ? now : null,
    });
    if (inviteSnap.exists) {
      await inviteRef.delete();
    }
    return serializeProfile(uid, {
      ...nextProfile,
      createdAt: null,
      updatedAt: null,
      lastLoginAt: null,
    });
  }

  const profile = normalizeUserDoc(userSnap.data());
  if (adminEmails().has(email) && profile.role !== "admin") {
    profile.role = "admin";
    await userRef.update({ role: "admin", updatedAt: now });
  }
  if (profile.status !== "active") {
    throw makeError(403, "This account is disabled.");
  }
  if (!profile.allowedProviders.includes(provider)) {
    throw makeError(403, "This login method is not enabled for this user.");
  }
  if (options.touchLogin) {
    await userRef.update({ lastLoginAt: now, updatedAt: now });
  }
  return serializeProfile(uid, { ...userSnap.data(), ...profile });
}

export async function requireAuthenticatedUser(req, options = {}) {
  const decodedToken = await decodedTokenFromRequest(req);
  return profileForDecodedToken(decodedToken, options);
}

export function requireFeature(user, feature) {
  if (!user?.featureFlags?.[feature]) {
    throw makeError(403, `This account is not allowed to use ${feature}.`);
  }
}

export function requireAdmin(user) {
  if (user?.role !== "admin") {
    throw makeError(403, "Admin access is required.");
  }
}

export function filterVideosForUser(videos, user) {
  if (!user?.featureFlags?.video) {
    return [];
  }
  const access = normalizeContentAccess(user.contentAccess);
  if (access.mode === "all") {
    return videos;
  }
  if (access.mode === "videos") {
    const allowed = new Set(access.videoIds);
    return videos.filter((video) => allowed.has(video.id));
  }
  if (access.mode === "series") {
    const allowedSeries = new Set(access.series);
    return videos.filter((video) => video.series && allowedSeries.has(video.series));
  }
  const allowed = new Set(access.videoIds);
  const allowedSeries = new Set(access.series);
  return videos.filter(
    (video) => allowed.has(video.id) || (video.series && allowedSeries.has(video.series)),
  );
}

export function ensureVideoAllowed(user, video) {
  if (!filterVideosForUser([video], user).length) {
    throw makeError(403, "This account is not allowed to view this video.");
  }
}

function generatedPassword() {
  const bytes = randomBytes(16);
  let password = "";
  for (const byte of bytes) {
    password += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
  }
  return `${password}!9`;
}

async function listCollection(collectionName) {
  const snapshot = await getDb().collection(collectionName).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...serializeValue(doc.data()) }));
}

export async function handleSession(req, res) {
  if (handleApiOptions(req, res)) {
    return;
  }
  if (req.method === "DELETE") {
    clearSessionCookie(req, res);
    sendApiJson(req, res, 200, { ok: true });
    return;
  }
  if (req.method !== "POST") {
    sendApiJson(req, res, 405, { error: "Method not allowed." });
    return;
  }

  try {
    const { idToken } = await readJsonBody(req);
    if (!idToken) {
      throw makeError(400, "Missing Firebase ID token.");
    }
    const decodedToken = await getAdminAuth().verifyIdToken(idToken, true);
    const user = await profileForDecodedToken(decodedToken, { touchLogin: true });
    const sessionCookie = await getAdminAuth().createSessionCookie(idToken, {
      expiresIn: SESSION_MAX_AGE_MS,
    });
    setSessionCookie(req, res, sessionCookie);
    sendApiJson(req, res, 200, { user });
  } catch (error) {
    clearSessionCookie(req, res);
    sendAuthError(req, res, error);
  }
}

export async function handleMe(req, res) {
  if (handleApiOptions(req, res)) {
    return;
  }
  if (!["GET", "PATCH"].includes(req.method)) {
    sendApiJson(req, res, 405, { error: "Method not allowed." });
    return;
  }
  try {
    const user = await requireAuthenticatedUser(req);
    if (req.method === "PATCH") {
      const body = await readJsonBody(req);
      const displayName = String(body.displayName || "").trim();
      if (displayName.length > 60) {
        throw makeError(400, "Display name is too long.");
      }
      await getDb().collection("users").doc(user.uid).set(
        {
          displayName,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      await getAdminAuth().updateUser(user.uid, {
        displayName: displayName || null,
      }).catch(() => {});
      sendApiJson(req, res, 200, {
        user: {
          ...user,
          displayName,
          updatedAt: new Date().toISOString(),
        },
      });
      return;
    }
    sendApiJson(req, res, 200, { user });
  } catch (error) {
    sendAuthError(req, res, error);
  }
}

export async function handleAdminUsers(req, res, uid) {
  if (handleApiOptions(req, res)) {
    return;
  }
  try {
    const currentUser = await requireAuthenticatedUser(req);
    requireAdmin(currentUser);

    if (req.method === "GET" && !uid) {
      const [users, invites] = await Promise.all([
        listCollection("users"),
        listCollection("invites"),
      ]);
      sendApiJson(req, res, 200, {
        users,
        invites: invites.map((invite) => ({ ...invite, id: `invite:${invite.id}` })),
      });
      return;
    }

    if (req.method === "POST" && !uid) {
      const body = await readJsonBody(req);
      const email = normalizeEmail(body.email);
      if (!email) {
        throw makeError(400, "Email is required.");
      }

      const allowedProviders = normalizeAllowedProviders(body.allowedProviders);
      const profile = normalizeUserDoc({ ...body, email, allowedProviders });
      const now = FieldValue.serverTimestamp();
      let createdUid = null;
      let temporaryPassword = null;

      if (allowedProviders.includes("password")) {
        let authUser;
        try {
          authUser = await getAdminAuth().getUserByEmail(email);
          if (body.password || body.resetPassword) {
            temporaryPassword = body.password || generatedPassword();
          }
          const authUpdates = {
            disabled: profile.status !== "active",
            displayName: profile.displayName || undefined,
          };
          if (temporaryPassword) {
            authUpdates.password = temporaryPassword;
          }
          await getAdminAuth().updateUser(authUser.uid, authUpdates);
        } catch (error) {
          if (error.code !== "auth/user-not-found") {
            throw error;
          }
          temporaryPassword = body.password || generatedPassword();
          authUser = await getAdminAuth().createUser({
            email,
            emailVerified: false,
            disabled: profile.status !== "active",
            displayName: profile.displayName || undefined,
            password: temporaryPassword,
          });
        }
        createdUid = authUser.uid;
        await getDb().collection("users").doc(createdUid).set(
          {
            ...profile,
            createdAt: now,
            updatedAt: now,
          },
          { merge: true },
        );
      } else {
        let existingAuthUser = null;
        await getAdminAuth()
          .getUserByEmail(email)
          .then((authUser) => {
            existingAuthUser = authUser;
          })
          .catch((error) => {
            if (error.code !== "auth/user-not-found") {
              throw error;
            }
          });

        if (existingAuthUser) {
          createdUid = existingAuthUser.uid;
          await getAdminAuth().updateUser(createdUid, {
            disabled: profile.status !== "active",
            displayName: profile.displayName || undefined,
          });
          await getDb().collection("users").doc(createdUid).set(
            {
              ...profile,
              createdAt: now,
              updatedAt: now,
            },
            { merge: true },
          );
        } else {
          await getDb().collection("invites").doc(email).set(
            {
              ...profile,
              createdAt: now,
              updatedAt: now,
            },
            { merge: true },
          );
        }
      }

      sendApiJson(req, res, 201, {
        user: createdUid ? { uid: createdUid, ...profile } : null,
        invite: createdUid ? null : { id: `invite:${email}`, ...profile },
        temporaryPassword: body.password ? null : temporaryPassword,
      });
      return;
    }

    if (req.method === "PATCH" && uid) {
      const body = await readJsonBody(req);
      const now = FieldValue.serverTimestamp();
      const db = getDb();

      if (uid.startsWith("invite:")) {
        const email = uid.slice("invite:".length);
        const currentSnap = await db.collection("invites").doc(email).get();
        const currentData = currentSnap.exists ? currentSnap.data() : {};
        const updates = normalizeUserDoc({
          ...currentData,
          ...body,
          email,
        });
        await db.collection("invites").doc(email).set(
          {
            ...updates,
            email,
            updatedAt: now,
          },
          { merge: true },
        );
        await writeAdminAuditLog(db, currentUser, "admin_user_update", "invite", uid, currentData, updates);
        sendApiJson(req, res, 200, { invite: { id: uid, ...updates } });
        return;
      }

      const currentSnap = await db.collection("users").doc(uid).get();
      const currentData = currentSnap.exists ? currentSnap.data() : {};
      const updates = normalizeUserDoc({
        ...currentData,
        ...body,
        email: body.email || currentData.email,
      });
      await db.collection("users").doc(uid).set(
        {
          ...updates,
          updatedAt: now,
        },
        { merge: true },
      );
      await getAdminAuth()
        .updateUser(uid, { disabled: updates.status !== "active" })
        .catch(() => {});
      await writeAdminAuditLog(db, currentUser, "admin_user_update", "user", uid, currentData, updates);
      sendApiJson(req, res, 200, { user: { uid, ...updates } });
      return;
    }

    sendApiJson(req, res, 405, { error: "Method not allowed." });
  } catch (error) {
    sendAuthError(req, res, error);
  }
}

function progressDocId(uid, videoId) {
  return `${uid}_${videoId}`;
}

async function pruneOldWatchEvents(db) {
  const cutoff = Timestamp.fromDate(
    new Date(Date.now() - WATCH_RECORD_RETENTION_DAYS * 24 * 60 * 60 * 1000),
  );
  const snapshot = await db
    .collection("watchEvents")
    .where("createdAt", "<", cutoff)
    .limit(WATCH_RECORD_PRUNE_LIMIT)
    .get();

  if (snapshot.empty) {
    return 0;
  }

  const batch = db.batch();
  for (const doc of snapshot.docs) {
    batch.delete(doc.ref);
  }
  await batch.commit();
  return snapshot.size;
}

export function normalizeProgressBody(body, user, videoId) {
  const durationSeconds = Number(body.durationSeconds || 0);
  const positionSeconds = Number(body.positionSeconds || 0);
  const percent =
    durationSeconds > 0
      ? Math.max(0, Math.min(100, (positionSeconds / durationSeconds) * 100))
      : 0;
  return {
    uid: user.uid,
    email: user.email,
    videoId,
    title: limitedString(body.title, MAX_PROGRESS_TITLE_LENGTH),
    series: limitedString(body.series, MAX_PROGRESS_SERIES_LENGTH),
    durationSeconds,
    positionSeconds,
    percent,
    completed: Boolean(body.completed) || percent >= 92,
    eventType: limitedString(body.eventType || "progress", MAX_EVENT_TYPE_LENGTH),
  };
}

function normalizeWishlistStatus(status) {
  const nextStatus = String(status || "new").trim();
  return WISHLIST_STATUSES.has(nextStatus) ? nextStatus : "new";
}

function normalizeWishlistType(type) {
  const nextType = String(type || "movie").trim();
  return WISHLIST_TYPES.has(nextType) ? nextType : "movie";
}

function queryParam(req, name) {
  return new URL(req.url, "http://localhost").searchParams.get(name);
}

function normalizeWishlistBody(body, user) {
  const title = String(body.title || "").trim();
  if (!title) {
    throw makeError(400, "Wish title is required.");
  }
  if (title.length > 160) {
    throw makeError(400, "Wish title is too long.");
  }
  const note = String(body.note || "").trim();
  if (note.length > 1000) {
    throw makeError(400, "Wish note is too long.");
  }
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName || "",
    title,
    note,
    type: normalizeWishlistType(body.type),
    status: normalizeWishlistStatus(body.status),
  };
}

function normalizeVideoReportStatus(status) {
  const nextStatus = String(status || "new").trim();
  return VIDEO_REPORT_STATUSES.has(nextStatus) ? nextStatus : "new";
}

function normalizeVideoReportType(type) {
  const nextType = String(type || "other").trim();
  return VIDEO_REPORT_TYPES.has(nextType) ? nextType : "other";
}

function normalizeVideoReportBody(body, user) {
  const videoId = String(body.videoId || "").trim();
  const videoTitle = String(body.videoTitle || "").trim();
  const note = String(body.note || "").trim();
  if (!videoId) {
    throw makeError(400, "Video ID is required.");
  }
  if (!videoTitle) {
    throw makeError(400, "Video title is required.");
  }
  if (note.length > 1000) {
    throw makeError(400, "Report note is too long.");
  }
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName || "",
    videoId,
    videoTitle: videoTitle.slice(0, 200),
    type: normalizeVideoReportType(body.type),
    note,
    status: "new",
  };
}

function normalizeAdminReportUpdates(body) {
  const updates = {
    updatedAt: FieldValue.serverTimestamp(),
  };
  if ("status" in body) {
    updates.status = normalizeVideoReportStatus(body.status);
  }
  if ("adminNote" in body) {
    updates.adminNote = String(body.adminNote || "").trim().slice(0, 1000);
  }
  return updates;
}

async function writeAdminAuditLog(db, actor, action, targetType, targetId, before, after) {
  try {
    await db.collection("adminAuditLogs").add({
      action,
      actorName: actor.displayName || actor.email || "",
      actorUid: actor.uid,
      after: serializeValue(after),
      before: serializeValue(before),
      createdAt: FieldValue.serverTimestamp(),
      targetId,
      targetType,
    });
  } catch (error) {
    console.warn("Unable to write admin audit log.", error);
  }
}

function boundedLimit(value, fallback, maximum) {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0) {
    return fallback;
  }
  return Math.min(limit, maximum);
}

function safeRateLimitPart(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
}

export function rateLimitBucketId(user, action, windowMs, nowMs = Date.now()) {
  const bucket = Math.floor(nowMs / windowMs);
  return `${safeRateLimitPart(action)}_${safeRateLimitPart(user.uid)}_${bucket}`;
}

export async function enforceUserWriteRateLimit(db, user, action, limit, windowMs = RATE_LIMIT_WINDOW_MS, nowMs = Date.now()) {
  const bucketStart = Math.floor(nowMs / windowMs) * windowMs;
  const bucketId = rateLimitBucketId(user, action, windowMs, nowMs);
  const ref = db.collection("rateLimits").doc(bucketId);

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const currentCount = snapshot.exists ? Number(snapshot.data()?.count || 0) : 0;
    if (currentCount >= limit) {
      throw makeError(429, "Too many requests. Please try again later.");
    }
    transaction.set(
      ref,
      {
        action,
        bucketStart: Timestamp.fromDate(new Date(bucketStart)),
        count: currentCount + 1,
        uid: user.uid,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });
}

async function visibleVideosById(user) {
  const videos = filterVideosForUser(mapVideos(await queryAllVideos()), user);
  return new Map(videos.map((video) => [video.id, video]));
}

function normalizeEditableWishBody(body) {
  const updates = {
    updatedAt: FieldValue.serverTimestamp(),
  };
  if ("title" in body) {
    const title = String(body.title || "").trim();
    if (!title) {
      throw makeError(400, "Wish title is required.");
    }
    if (title.length > 160) {
      throw makeError(400, "Wish title is too long.");
    }
    updates.title = title;
  }
  if ("note" in body) {
    const note = String(body.note || "").trim();
    if (note.length > 1000) {
      throw makeError(400, "Wish note is too long.");
    }
    updates.note = note;
  }
  if ("type" in body) {
    updates.type = normalizeWishlistType(body.type);
  }
  if ("status" in body) {
    const status = normalizeWishlistStatus(body.status);
    if (status !== "cancelled") {
      throw makeError(400, "Users can only cancel wishlist requests.");
    }
    updates.status = status;
  }
  return updates;
}

export async function handleWatchProgress(req, res, videoId) {
  if (handleApiOptions(req, res)) {
    return;
  }
  try {
    const user = await requireAuthenticatedUser(req);
    requireFeature(user, "video");

    if (req.method === "GET" && !videoId) {
      const limit = boundedLimit(queryParam(req, "limit"), 12, 50);
      const snapshot = await getDb()
        .collection("watchProgress")
        .where("uid", "==", user.uid)
        .orderBy("lastWatchedAt", "desc")
        .limit(limit * 2)
        .get();
      const videos = await visibleVideosById(user);
      const progress = snapshot.docs
        .map((doc) => ({ id: doc.id, ...serializeValue(doc.data()) }))
        .filter((item) => videos.has(item.videoId))
        .slice(0, limit);
      sendApiJson(req, res, 200, { progress });
      return;
    }

    if (!videoId) {
      throw makeError(400, "Missing video ID.");
    }

    const db = getDb();
    const ref = db.collection("watchProgress").doc(progressDocId(user.uid, videoId));

    if (req.method === "GET") {
      const snap = await ref.get();
      if (!snap.exists) {
        sendApiJson(req, res, 200, { progress: null });
        return;
      }
      const progress = serializeValue(snap.data());
      sendApiJson(req, res, 200, { progress });
      return;
    }

    if (req.method === "DELETE") {
      await ref.delete();
      sendApiJson(req, res, 200, { ok: true });
      return;
    }

    if (req.method === "PUT") {
      const body = await readJsonBody(req);
      const progress = normalizeProgressBody(body, user, videoId);
      const existing = await ref.get();
      await ref.set(
        {
          ...progress,
          lastIpAddress: clientIp(req),
          userAgent: req.headers["user-agent"] || "",
          ...(existing.exists ? {} : { firstWatchedAt: FieldValue.serverTimestamp() }),
          lastWatchedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      sendApiJson(req, res, 200, { progress });
      return;
    }

    sendApiJson(req, res, 405, { error: "Method not allowed." });
  } catch (error) {
    sendAuthError(req, res, error);
  }
}

export async function handleWatchEvents(req, res) {
  if (handleApiOptions(req, res)) {
    return;
  }
  if (req.method !== "POST") {
    sendApiJson(req, res, 405, { error: "Method not allowed." });
    return;
  }
  try {
    const user = await requireAuthenticatedUser(req);
    requireFeature(user, "video");
    const body = await readJsonBody(req);
    const videoId = String(body.videoId || "");
    if (!videoId) {
      throw makeError(400, "Missing video ID.");
    }
    const event = {
      ...normalizeProgressBody(body, user, videoId),
      ...requestMetadata(req),
      sessionId: limitedString(body.sessionId, MAX_SESSION_ID_LENGTH),
      createdAt: FieldValue.serverTimestamp(),
    };
    const db = getDb();
    await db.collection("watchEvents").add(event);
    await pruneOldWatchEvents(db).catch((error) => {
      console.warn("Unable to prune old watch events.", error);
    });
    sendApiJson(req, res, 201, { event });
  } catch (error) {
    sendAuthError(req, res, error);
  }
}

export async function handleWishlist(req, res, wishId) {
  if (handleApiOptions(req, res)) {
    return;
  }
  try {
    const user = await requireAuthenticatedUser(req);

    if (req.method === "GET" && !wishId) {
      const snapshot = await getDb()
        .collection("wishlist")
        .where("uid", "==", user.uid)
        .orderBy("createdAt", "desc")
        .limit(WISHLIST_RESULT_LIMIT)
        .get();
      const wishes = snapshot.docs
        .map((doc) => ({ id: doc.id, ...serializeValue(doc.data()) }));
      sendApiJson(req, res, 200, { wishes });
      return;
    }

    if (req.method === "POST" && !wishId) {
      const body = await readJsonBody(req);
      const db = getDb();
      await enforceUserWriteRateLimit(
        db,
        user,
        "wishlist",
        WISHLIST_WRITE_LIMIT_PER_HOUR,
      );
      const wish = {
        ...normalizeWishlistBody(body, user),
        ...requestMetadata(req),
        status: "new",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      const ref = await db.collection("wishlist").add(wish);
      sendApiJson(req, res, 201, {
        wish: {
          id: ref.id,
          ...serializeValue({ ...wish, createdAt: null, updatedAt: null }),
        },
      });
      return;
    }

    if (req.method === "PATCH" && wishId) {
      const ref = getDb().collection("wishlist").doc(wishId);
      const snap = await ref.get();
      if (!snap.exists) {
        throw makeError(404, "Wishlist request not found.");
      }
      const current = snap.data();
      if (current.uid !== user.uid) {
        throw makeError(403, "You can only edit your own wishlist requests.");
      }
      if (current.status !== "new") {
        throw makeError(409, "Only new wishlist requests can be edited.");
      }
      const body = await readJsonBody(req);
      const updates = normalizeEditableWishBody(body);
      await ref.set(updates, { merge: true });
      sendApiJson(req, res, 200, {
        wish: { id: wishId, ...serializeValue({ ...updates, updatedAt: null }) },
      });
      return;
    }

    sendApiJson(req, res, 405, { error: "Method not allowed." });
  } catch (error) {
    sendAuthError(req, res, error);
  }
}

export async function handleAdminWishlist(req, res, wishId) {
  if (handleApiOptions(req, res)) {
    return;
  }
  try {
    const user = await requireAuthenticatedUser(req);
    requireAdmin(user);

    if (req.method === "PATCH" && wishId === ":batch") {
      const body = await readJsonBody(req);
      const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean).slice(0, 50) : [];
      if (!ids.length) {
        throw makeError(400, "Select at least one wishlist request.");
      }
      const bodyUpdates = body.updates && typeof body.updates === "object" ? body.updates : {};
      const updates = {
        updatedAt: FieldValue.serverTimestamp(),
        reviewedBy: user.email,
      };
      if ("status" in bodyUpdates) {
        updates.status = normalizeWishlistStatus(bodyUpdates.status);
      }
      if ("adminNote" in bodyUpdates) {
        updates.adminNote = String(bodyUpdates.adminNote || "").trim().slice(0, 1000);
      }
      const db = getDb();
      const refs = ids.map((id) => db.collection("wishlist").doc(id));
      const snaps = await Promise.all(refs.map((ref) => ref.get()));
      const missingIds = snaps.filter((snap) => !snap.exists).map((snap) => snap.id);
      if (missingIds.length) {
        throw makeError(400, `Wishlist request not found: ${missingIds.join(", ")}`);
      }
      const batch = db.batch();
      for (const ref of refs) {
        batch.update(ref, updates);
      }
      await batch.commit();
      await writeAdminAuditLog(
        db,
        user,
        "wishlist_batch_update",
        "wishlist",
        ids.join(","),
        snaps.map((snap) => ({ id: snap.id, ...snap.data() })),
        { ids, updates },
      );
      sendApiJson(req, res, 200, {
        wishes: ids.map((id) => ({ id, ...serializeValue({ ...updates, updatedAt: null }) })),
      });
      return;
    }

    if (req.method === "GET" && !wishId) {
      const type = queryParam(req, "type");
      const status = queryParam(req, "status");
      const search = String(queryParam(req, "q") || "").trim().toLowerCase();
      const limit = boundedLimit(queryParam(req, "limit"), ADMIN_RESULT_LIMIT, ADMIN_RESULT_LIMIT);
      let query = getDb().collection("wishlist");
      if (type && WISHLIST_TYPES.has(type)) {
        query = query.where("type", "==", type);
      }
      if (status && status !== "all" && WISHLIST_STATUSES.has(status)) {
        query = query.where("status", "==", status);
      }
      const snapshot = await query
        .orderBy("createdAt", "desc")
        .limit(limit)
        .get();
      const wishes = snapshot.docs
        .map((doc) => ({ id: doc.id, ...serializeValue(doc.data()) }))
        .filter((wish) => {
          if (!search) {
            return true;
          }
          return `${wish.title || ""} ${wish.note || ""} ${wish.email || ""}`.toLowerCase().includes(search);
        });
      sendApiJson(req, res, 200, { wishes });
      return;
    }

    if (req.method === "PATCH" && wishId) {
      const db = getDb();
      const ref = db.collection("wishlist").doc(wishId);
      const snap = await ref.get();
      if (!snap.exists) {
        throw makeError(404, "Wishlist request not found.");
      }
      const body = await readJsonBody(req);
      const updates = {
        updatedAt: FieldValue.serverTimestamp(),
        reviewedBy: user.email,
      };
      if ("status" in body) {
        updates.status = normalizeWishlistStatus(body.status);
      }
      if ("adminNote" in body) {
        updates.adminNote = String(body.adminNote || "").trim().slice(0, 1000);
      }
      await ref.update(updates);
      await writeAdminAuditLog(db, user, "wishlist_update", "wishlist", wishId, snap.data(), updates);
      sendApiJson(req, res, 200, {
        wish: { id: wishId, ...serializeValue({ ...updates, updatedAt: null }) },
      });
      return;
    }

    sendApiJson(req, res, 405, { error: "Method not allowed." });
  } catch (error) {
    sendAuthError(req, res, error);
  }
}

export async function handleVideoReports(req, res) {
  if (handleApiOptions(req, res)) {
    return;
  }
  if (req.method !== "POST") {
    sendApiJson(req, res, 405, { error: "Method not allowed." });
    return;
  }
  try {
    const user = await requireAuthenticatedUser(req);
    requireFeature(user, "video");
    const body = await readJsonBody(req);
    const db = getDb();
    await enforceUserWriteRateLimit(
      db,
      user,
      "videoReports",
      VIDEO_REPORT_WRITE_LIMIT_PER_HOUR,
    );
    const report = {
      ...normalizeVideoReportBody(body, user),
      ...requestMetadata(req),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    const ref = await db.collection("videoReports").add(report);
    sendApiJson(req, res, 201, {
      report: {
        id: ref.id,
        ...serializeValue({ ...report, createdAt: null, updatedAt: null }),
      },
    });
  } catch (error) {
    sendAuthError(req, res, error);
  }
}

export async function handleAdminVideoReports(req, res, reportId) {
  if (handleApiOptions(req, res)) {
    return;
  }
  try {
    const user = await requireAuthenticatedUser(req);
    requireAdmin(user);

    if (req.method === "GET" && !reportId) {
      const status = queryParam(req, "status");
      const search = String(queryParam(req, "q") || "").trim().toLowerCase();
      const limit = boundedLimit(queryParam(req, "limit"), ADMIN_RESULT_LIMIT, ADMIN_RESULT_LIMIT);
      let query = getDb().collection("videoReports");
      if (status && status !== "all" && VIDEO_REPORT_STATUSES.has(status)) {
        query = query.where("status", "==", status);
      }
      const snapshot = await query
        .orderBy("createdAt", "desc")
        .limit(limit)
        .get();
      const reports = snapshot.docs
        .map((doc) => ({ id: doc.id, ...serializeValue(doc.data()) }))
        .filter((report) => {
          if (!search) {
            return true;
          }
          return `${report.videoTitle || ""} ${report.note || ""} ${report.email || ""} ${report.type || ""}`.toLowerCase().includes(search);
        });
      sendApiJson(req, res, 200, { reports });
      return;
    }

    if (req.method === "PATCH" && reportId) {
      const db = getDb();
      const ref = db.collection("videoReports").doc(reportId);
      const snap = await ref.get();
      if (!snap.exists) {
        throw makeError(404, "Video report not found.");
      }
      const body = await readJsonBody(req);
      const updates = {
        ...normalizeAdminReportUpdates(body),
        reviewedBy: user.email,
      };
      await ref.update(updates);
      await writeAdminAuditLog(db, user, "video_report_update", "videoReport", reportId, snap.data(), updates);
      sendApiJson(req, res, 200, {
        report: { id: reportId, ...serializeValue({ ...updates, updatedAt: null }) },
      });
      return;
    }

    sendApiJson(req, res, 405, { error: "Method not allowed." });
  } catch (error) {
    sendAuthError(req, res, error);
  }
}

export async function handleAdminAuditLogs(req, res) {
  if (handleApiOptions(req, res)) {
    return;
  }
  if (req.method !== "GET") {
    sendApiJson(req, res, 405, { error: "Method not allowed." });
    return;
  }
  try {
    const user = await requireAuthenticatedUser(req);
    requireAdmin(user);
    const action = String(queryParam(req, "action") || "").trim();
    const targetType = String(queryParam(req, "targetType") || "").trim();
    const search = String(queryParam(req, "q") || "").trim().toLowerCase();
    const limit = boundedLimit(queryParam(req, "limit"), ADMIN_RESULT_LIMIT, ADMIN_RESULT_LIMIT);
    let query = getDb().collection("adminAuditLogs");
    if (action && action !== "all") {
      query = query.where("action", "==", action);
    }
    if (targetType && targetType !== "all") {
      query = query.where("targetType", "==", targetType);
    }
    const snapshot = await query
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();
    const logs = snapshot.docs
      .map((doc) => ({ id: doc.id, ...serializeValue(doc.data()) }))
      .filter((log) => {
        if (!search) {
          return true;
        }
        return `${log.actorName || ""} ${log.actorUid || ""} ${log.action || ""} ${log.targetType || ""} ${log.targetId || ""}`.toLowerCase().includes(search);
      });
    sendApiJson(req, res, 200, { logs });
  } catch (error) {
    sendAuthError(req, res, error);
  }
}

export async function handleAdminWatchProgress(req, res) {
  if (handleApiOptions(req, res)) {
    return;
  }
  if (req.method !== "GET") {
    sendApiJson(req, res, 405, { error: "Method not allowed." });
    return;
  }
  try {
    const user = await requireAuthenticatedUser(req);
    requireAdmin(user);
    const snapshot = await getDb()
      .collection("watchProgress")
      .orderBy("lastWatchedAt", "desc")
      .limit(ADMIN_RESULT_LIMIT)
      .get();
    const progress = snapshot.docs
      .map((doc) => ({ id: doc.id, ...serializeValue(doc.data()) }));
    sendApiJson(req, res, 200, { progress });
  } catch (error) {
    sendAuthError(req, res, error);
  }
}

export async function handleAdminWatchEvents(req, res) {
  if (handleApiOptions(req, res)) {
    return;
  }
  if (req.method !== "GET") {
    sendApiJson(req, res, 405, { error: "Method not allowed." });
    return;
  }
  try {
    const user = await requireAuthenticatedUser(req);
    requireAdmin(user);
    const uid = queryParam(req, "uid");
    let query = getDb().collection("watchEvents");
    if (uid) {
      query = query.where("uid", "==", uid);
    }
    const snapshot = await query
      .orderBy("createdAt", "desc")
      .limit(ADMIN_RESULT_LIMIT)
      .get();
    const events = snapshot.docs
      .map((doc) => ({ id: doc.id, ...serializeValue(doc.data()) }));
    sendApiJson(req, res, 200, { events });
  } catch (error) {
    sendAuthError(req, res, error);
  }
}

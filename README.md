# Notion Media Library

可自行部署的 Notion 媒體庫：用 React/Vite 提供音樂與影片介面，用 Firebase
Authentication、Cloud Functions 與 Firestore 管理登入、權限及播放紀錄。Notion
token 只存在後端，瀏覽器只會取得短效檔案 URL。

> 本專案只授權程式碼。請只放入你擁有或已取得再散布授權的音樂、影片、封面與字幕。

## 這個公開版本包含什麼

- 音樂專輯、FLAC 曲目、搜尋、篩選、播放佇列與 FLAC metadata。
- 影片、系列、MP4/WebM 播放、WebVTT 字幕、續播與播放事件。
- Firebase 管理員核准登入、影片存取範圍、願望清單與問題回報。
- 同站公開 Demo 首頁：訪客可播放少量公開素材，登入後才進入私人媒體庫。
- Firestore rules、Node 測試、GitHub Actions CI 與系統架構圖。

## 系統架構

```text
瀏覽器（React/Vite）
        │ Firebase token / session cookie
        ▼
Firebase Hosting ── /api ──► Cloud Function
                                  ├─ Notion API / 暫時檔案 URL
                                  └─ Firestore（使用者與私人活動）
```

完整信任邊界、播放流程與部署設定見 [系統架構圖](docs/architecture.md)。從私人內容整理到公開發布的階段、閘門與驗收條件見 [開源路線圖](docs/open-source-roadmap.md)。英文完整文件見 [README.en.md](README.en.md)。

## 快速開始

需要 Node.js 22 或更新版本，以及一個自己的 Firebase 專案與 Notion integration。

```bash
npm install
npm --prefix functions install
npm test
npm run dev
```

Vite 開發伺服器會掛載 `functions/server/*` 的本機 `/api` handlers，因此前端與部署函式使用同一套路由。設定值請從 `.env.example` 與 `functions/.env.example` 複製；真實 Notion token 請使用 Secret Manager：

```bash
firebase login
firebase use --add
firebase functions:secrets:set NOTION_TOKEN
npm run deploy
```

Cloud Functions 可能需要啟用計費。部署前請把 Hosting 網域、preview channel 網域與本機網址加入 Firebase Authentication authorized domains，並把 `ALLOWED_ORIGINS` 設成實際來源的逗號分隔清單。

## Notion 資料格式

音樂 data source 至少需要 `Name`（標題）、`Artist`（文字）；可選 `Year`、`Genre`、`Cover`。每一列是專輯頁，曲目以頁面內的 `audio` block 或檔名以 `.flac` 結尾的 `file` block 表示。

影片 data source 至少需要 `Name`、`Video`（檔案）；可選 `Year`、`Genre`、`Series`、`Series Order`、`Cover`、`Subtitles`、`Audio Language`、`Runtime`、`Status`。`Vedio` 仍作為舊資料的拼字 fallback。影片建議使用 MP4/WebM，字幕使用 `.vtt`。

Demo 素材請放在獨立的 `Demo Media` data source；每列是一首歌或一段影片。欄位包含 `Name`、`Type`（`Music`／`Video`）、`Media`、`Published`，並可加入 `Artist`、`Cover`、`Subtitles`、`Description`、`Order`、`Credit`、`Source URL`。只有 `Published=true` 且檔案格式受支援的列會被公開。

## 同站 Demo

Demo 使用目前網站的 Firebase project 與同一個 Notion integration，但資料放在獨立 data source。設定：

```dotenv
NOTION_DEMO_DATA_SOURCE_ID=your_demo_data_source_id
```

訪客不需登入即可讀取 Demo 目錄、封面、串流與字幕；右上角登入後才會載入私人目錄。Demo 不寫入 Firestore，也不能使用私人 API。展示素材請標註來源與授權，並限制檔案大小與流量；Function 預設設有實例上限與 IP 讀取速率限制，仍應在 Firebase 監看用量與費用。

私人資料庫與 Demo data source 分開管理。公開 repository 不包含任何媒體檔、token、Firebase project binding 或私人使用者資料。

## 授權

程式碼採 [MIT License](LICENSE)。影音內容的著作權與再散布責任由各部署者自行確認。

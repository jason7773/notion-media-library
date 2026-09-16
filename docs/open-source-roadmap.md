# 開源路線圖與公開前檢核

本文件說明如何把原本連接私人 Notion 媒體庫的應用程式，整理成其他人可以自行部署的開源專案。程式碼與內容資料分開管理；公開版本只提供可重建的軟體，不提供未取得再散布授權的影音檔案。

## 目標架構

| 區域 | 放置內容 | 公開狀態 |
| --- | --- | --- |
| `notion-media-library`（本目錄） | React 前端、Firebase Functions、Firestore 規則、測試、文件 | 可公開，MIT |
| 私人部署 | 自己的 Notion integration、資料庫、影音檔與 Firebase 專案設定 | 私有，依內容授權管理 |
| 同站 Demo | 同一 Firebase project 裡的 `Demo Media` data source | 可公開，只放自有或可再散布素材 |

私人資料庫與 Demo data source 分開管理；Demo 素材可在 Notion 更新，不需要重新部署。這能避免私人內容、使用者紀錄或部署密鑰因同步流程誤進公開環境。

## 階段與交付物

### 1. 程式碼清理（已完成）

- 以全新 Git 歷史建立 `public-release`，不複製原專案的 `.git`、建置產物或本機依賴。
- 將專案名稱、環境變數、Firebase 設定與 Analytics 設定改為佔位值。
- 將測試資料改成中性名稱，不把私人媒體目錄或真實帳號寫進 fixture。
- 補上 MIT、貢獻規範、安全回報、部署文件與 CI。
- 所有 Notion token 只由 Cloud Functions 讀取，瀏覽器只取得短效檔案 URL。

### 2. 自行部署驗證（待每位部署者執行）

1. 建立自己的 Firebase 專案，啟用 Hosting、Functions、Authentication、Firestore 與 Secret Manager。
2. 建立 Notion integration，將自己的私人音樂、影片與 `Demo Media` data source 分享給 integration。
3. 依 `.env.example` 填入 Firebase web config；以 `firebase functions:secrets:set NOTION_TOKEN` 儲存 token。
4. 設定 `NOTION_DATA_SOURCE_ID`、`NOTION_VIDEO_DATA_SOURCE_ID`、`ALLOWED_ORIGINS` 與 `ADMIN_EMAILS`。
5. 先部署 Functions，再使用 Hosting preview channel 測試登入、檔案串流、字幕與權限。
6. 確認 Firestore rules、Demo 路由與自有網域後，再部署正式 Hosting。

驗收條件：新部署者不需要取得原作者的帳號、Notion workspace、Firebase project 或媒體檔，就能依文件完成建置；私人部署的 token、資料與使用者紀錄不會出現在瀏覽器或 Git 歷史。

### 3. 同站合法 Demo（待建立）

- 使用既有 Firebase project 與獨立 `Demo Media` Notion data source。
- 只匯入自有、已取得展示授權，或明確允許再散布的短片、音樂、封面與字幕。
- 設定 `NOTION_DEMO_DATA_SOURCE_ID`；訪客直接讀取公開 Demo API，不建立 Firebase 匿名帳號。
- 展示訪客只可讀取 Demo 目錄、封面、串流與字幕；私人目錄仍要求核准登入。
- 在 Demo 頁標示素材來源與授權，並提供移除內容的聯絡方式。

Demo 不是私人媒體庫的鏡像，也不應使用私人 Notion URL、Firebase project ID 或 Analytics ID。

### 4. 公開 GitHub 發布（最後閘門）

公開前由另一位協作者執行以下檢查：

- `git log --all --stat` 與 `git grep` 沒有 token、私鑰、服務帳號、私人網域、真實使用者資料或未授權媒體檔。
- `git ls-files` 只包含程式碼、設定範本、測試與文件；沒有 `.env`、`dist/`、`node_modules/`、備份或匯出檔。
- 全新目錄可執行 `npm ci`、`cd functions; npm ci`、`npm test` 與 `npm run build`。
- CI 通過後才建立 GitHub repository；建立後再推送本候選版本，確認遠端 commit SHA 與本地一致。
- 發布頁面清楚說明 MIT 只授權程式碼，影音內容的權利由各部署者自行負責。

若檢查失敗，先修正並重新建立乾淨提交；不要把私人 repository 的歷史直接轉成公開 repository。即使刪除最新提交，已存在的 clone 或舊歷史仍可能保留內容。

## 風險與處理

- **內容權利**：示範素材必須可再散布；收到權利人要求時，先從展示 Notion data source 移除檔案，再清除快取與部署版本。
- **密鑰外洩**：Notion token 使用 Secret Manager；一旦懷疑外洩，立即撤銷並重發 token，不能只刪除 Git 檔案。
- **費用**：Functions、Notion API、網路傳輸與快取可能產生費用；展示站應限制素材大小與流量並監看 Firebase billing。
- **暫存 URL**：Notion 檔案 URL 會過期，應透過 `/api` 取得新 URL，不要把 URL 固定寫入 README、測試或前端常數。
- **資料隔離**：Demo API 不接觸 Firestore；私人環境仍須使用邀請與管理員核准的登入流程。

系統元件、信任邊界與播放流程見 [architecture.md](architecture.md)。

# 系統架構圖

## 系統總覽

```mermaid
flowchart LR
  Browser[瀏覽器 React + Vite]
  Hosting[Firebase Hosting]
  Function[Cloud Function v2 /api]
  Auth[Firebase Authentication]
  Firestore[(Firestore)]
  Secret[Secret Manager]
  NotionAPI[Notion API]
  NotionFiles[Notion 暫時檔案]
  Browser --> Hosting
  Browser -->|私人模式：核准 Google token / session cookie| Function
  Browser -->|核准帳號登入| Auth
  Hosting --> Function
  Function --> Auth
  Function --> Firestore
  Function --> Secret
  Function --> NotionAPI
  NotionAPI --> NotionFiles
  Function -->|短效 URL 或受控 proxy| NotionFiles
  Browser -->|Demo 或私人 proxy 串流| Function
```

Cloud Function 是媒體信任邊界：驗證 Notion page 所屬 data source 與 Demo `Published` 狀態，再套用私人模式的使用者影片權限；`NOTION_TOKEN` 永遠不會送到瀏覽器。Firestore rules 拒絕前端直接讀寫。Demo 個人資料只存在訪客瀏覽器，不會寫入 Firestore。

## 播放流程

```mermaid
sequenceDiagram
  participant UI as 瀏覽器
  participant API as API Function
  participant N as Notion
  UI->>API: GET 目錄
  API->>N: 查詢 data source
  N-->>API: 目錄頁面
  API-->>UI: metadata（不含長期密鑰）
  UI->>API: 選擇專輯或影片
  API->>N: 讀取頁面與 blocks
  N-->>API: 新的暫時檔案 URL
  API-->>UI: playlist 或影片 metadata
  UI->>API: GET media + Range
  API->>N: 更新暫時 URL 並轉送 Range
  N-->>API: 媒體回應
  API-->>UI: 串流回應
```

## 部署剖面

Demo 與私人模式共用音樂／影片瀏覽及播放器介面。私人部署的目錄與雲端使用者資料必須經核准登入；Firestore 儲存私人模式進度與內容請求。Demo 使用相同 schema 的獨立 Demo Music、Demo Video Notion data source。

未登入訪客只能讀取兩個 Demo data source 中 `Published=true` 的專輯／影片，不能讀取私人 data source。進度、播放器偏好、願望清單與問題回報只存本機。Google 登入且帳號通過核准後，才會載入私人目錄與雲端功能。

## 運作限制

Notion 目錄與頁面使用 Function instance 內的 TTL cache；封面、字幕與 FLAC metadata cache 以筆數或位元組數限制，冷啟動後會清空。影音 proxy 支援瀏覽器 Range。Demo API 另有每個 instance 的 IP 讀取速率限制，Function 預設 `maxInstances` 上限可降低意外費用，但這不是完整的流量防護；正式公開前應監看 Function invocation 與網路傳輸。

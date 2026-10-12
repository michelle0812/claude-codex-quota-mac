# 每個面板各選瀏覽器

齒輪 → 用量來源 →「瀏覽器登入」，再選 Safari／Chrome／Firefox／Zen。
選擇只保存於此面板的 `browser-usage-settings.json`，不會修改系統預設瀏覽器或 CLI 登入。
按「登入 ChatGPT」會在指定瀏覽器開啟配對頁，再開 ChatGPT 用量頁；收到有效用量後才顯示已連線。

## 安裝橋接

- Chrome：在擴充功能管理頁載入 `chromium` 資料夾。
- Firefox／Zen：執行專案的 `node scripts/build-browser-extension.js` 產生 `firefox`，於 `about:debugging` 載入 `manifest.json`。
  暫時載入的擴充套件在瀏覽器重新啟動後須重載；正式使用仍須 Mozilla 簽署。
- Safari：使用 Apple 的 `safari-web-extension-converter` 將 `chromium` 包成 macOS Safari 擴充套件 App。
  正式安裝需要建置、簽署及啟用 Safari 擴充套件，不能直接載入 Chrome 資料夾。
  專案的 `node scripts/build-safari-bridge.js` 可建置 ad-hoc 預覽版到 `safari`，不會安裝或更改 Safari 設定。
  ad-hoc 預覽版不等於正式簽署版；啟用它可能需要 Safari 開發者設定，需另外確認。

擴充套件只請求 `chatgpt.com` 與本機 `127.0.0.1` 的存取權，以及本機儲存、定時更新。
只在瀏覽器內使用網頁登入工作階段；傳回面板的資料白名單為帳號 email／ID、方案、用量視窗和重設時間。
不傳回 cookie、access token、refresh token，不讀對話，不開放任意網址代理。
橋接只監聽 loopback，每次連線有隨機配對密鑰；面板關閉後失效。

請保持瀏覽器及 ChatGPT 分頁開啟。每 3 分鐘讀取一次；10 分鐘未收到資料會報過期。
App 重新啟動後要再按「登入 ChatGPT」配對，不必登出瀏覽器。
瀏覽器改登入不同帳號時，面板會拒絕新帳號資料；重新按登入才解除原帳號綁定。
面板的「登出」只解除本機橋接，不會登出 Safari／Chrome／Firefox／Zen。

## 驗證狀態

2026-10-12 已在 Zen 暫時載入 Firefox 版橋接，用測試帳號完成指定瀏覽器開啟、配對、
自動抓取與面板顯示的實測：Plus、本週已用 0%／剩餘 100%，與網頁一致。
此帳號的每週視窗位於 API 的 `primary_window`，程式依視窗時長辨識，不依欄位順序猜 5 小時／每週。
沒提供的視窗顯示「--」。Safari、Chrome 與原生 Firefox 的真實登入與讀取仍待各自驗證。
程式使用的網頁工作階段端點與用量端點為未公開介面，服務端改版仍可能影響抓取。
端點失敗會回報錯誤，不會假設剩餘 100%。

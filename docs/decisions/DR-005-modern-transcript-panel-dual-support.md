# DR-005: Modern Transcript Panel のデュアルサポート

- **日付**: 2026-03-11
- **ステータス**: 採用

## 背景

YouTubeが字幕パネルのUIを刷新し、一部の動画/ブラウザで新しい「Modern Transcript View」が表示されるようになった。Braveブラウザで字幕取得が完全に動作しなくなったことで発覚。

## 原因

YouTubeがA/Bテストまたは段階的ロールアウトで新しいトランスクリプトパネルを導入。新旧パネルのDOM構造が完全に異なる:

| 項目 | 旧パネル | 新パネル |
|------|---------|---------|
| パネル target-id | `engagement-panel-searchable-transcript` | `PAmodern_transcript_view` |
| セグメント要素 | `ytd-transcript-segment-renderer` | `transcript-segment-view-model` |
| タイムスタンプ | `.segment-timestamp` | `.ytwTranscriptSegmentViewModelTimestamp` |
| テキスト | `.segment-text` | `span.yt-core-attributed-string` |
| 言語ドロップダウン | `yt-dropdown-menu` あり | なし |

## 代替案の検討

- **API方式** (`/api/timedtext`, `/youtubei/v1/get_transcript`): 認証(SAPISIDHASH)が必要で断念
- **DOM デュアルサポート**: 新旧両方のセレクタを持ち、検出結果に応じて切り替える → 採用

## 修正

1. 新旧パネルの検出関数 `detectPanel()` を追加
2. パネル検出結果に基づきセグメントのスクレイピングセレクタを切り替え
3. 新パネルでは言語切替が不可のため、`playerResponse` から言語名を取得
4. `movie_player.getPlayerResponse()` を優先使用（SPA遷移後も最新データを取得可能）

## 変更ファイル

- `extension/background.js` — `injectedGetTranscriptInfo()`, `injectedFetchTranscript()` のデュアルパネル対応
- `extension/content.js` — セレクタ・検出ロジック・スクレイピングのデュアルパネル対応

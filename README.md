# YouTube Summary to Markdown

YouTube動画の字幕（文字起こし）を取得し、動画メタデータとともにMarkdown形式に変換するChrome拡張機能。

## 機能

- YouTube動画ページから字幕（トランスクリプト）を取得
- 動画メタデータ（タイトル、チャンネル名、公開日、説明文）を自動収集
- 元言語の自動検出・選択（`defaultAudioLanguage` ベース）
- 複数言語の字幕切り替え対応
- Markdown形式で出力・クリップボードコピー

## 出力例

````markdown
# 動画情報
- タイトル: Example Video Title
- チャンネル: Example Channel
- URL: https://www.youtube.com/watch?v=XXXXXXXXXXX
- 公開日: 2025/01/01

## 説明
```
Video description here
```

## Transcript (英語)

**[00:00]** Hello and welcome...

**[00:15]** Today we'll be discussing...
````

## インストール方法

1. このリポジトリをクローンまたはダウンロード
2. Chrome で `chrome://extensions/` を開く
3. 右上の「デベロッパーモード」を有効化
4. 「パッケージ化されていない拡張機能を読み込む」をクリック
5. `extension/` フォルダを選択

## 使い方

1. YouTube の動画ページを開く
2. 拡張機能アイコンをクリック
3. 字幕言語を選択（元言語が自動選択されます）
4. 「Markdownをコピー」ボタンでクリップボードにコピー

## 技術詳細

### アーキテクチャ

```
popup.js  ──(message)──>  background.js  ──(executeScript)──>  YouTube Tab
   UI表示                   Service Worker                     DOM Scraping
   言語選択                 スクリプト注入                      字幕パネル操作
   Markdown表示             結果中継                           メタデータ収集
```

### 字幕取得方式

YouTube の字幕パネル（トランスクリプト）をDOMスクレイピングで取得します。

- `chrome.scripting.executeScript` で動画ページにスクリプトを動的注入
- `world: 'MAIN'` でページコンテキストにアクセスし、`ytInitialPlayerResponse` から言語情報を取得
- 字幕パネルのボタンをクリックして開き、`ytd-transcript-segment-renderer` からセグメントを読み取り

### 元言語の検出ロジック

1. `ytInitialPlayerResponse.videoDetails.defaultAudioLanguage` を取得
2. 一致する手動字幕（non-ASR）を優先選択
3. 手動字幕がなければ自動生成（ASR）字幕にフォールバック
4. `defaultAudioLanguage` が未設定の場合、手動字幕の先頭を選択

### 技術スタック

- Manifest V3
- `chrome.scripting` API（動的スクリプト注入）
- `chrome.tabs` API
- 純粋なHTML/CSS/JS（フレームワークなし、ビルドツールなし）

### ファイル構成

```
extension/
├── manifest.json          # Manifest V3 設定
├── background.js          # Service Worker（字幕取得ロジック）
├── content.js             # (未使用・レガシー)
├── popup/
│   ├── popup.html         # ポップアップUI
│   ├── popup.js           # ポップアップロジック
│   └── popup.css          # スタイル
└── icons/
    ├── icon-16.png
    ├── icon-48.png
    └── icon-128.png
```

## 必要な権限

- `activeTab` - アクティブタブへのアクセス
- `scripting` - タブへのスクリプト注入
- `https://www.youtube.com/*` - YouTube ページへのホストアクセス

## 制限事項

- 字幕（トランスクリプト）が存在しない動画では取得できません
- YouTube のDOM構造変更により動作しなくなる可能性があります
- YouTube動画ページ（`youtube.com/watch`）でのみ動作します

## ライセンス

MIT

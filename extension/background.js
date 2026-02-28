/**
 * Background Script (Service Worker)
 * chrome.scripting.executeScript でタブにスクリプトを動的注入し、
 * 字幕パネルのDOMスクレイピング結果を返す
 */

/**
 * タブ内で実行: 字幕パネルを開き、メタデータ・言語一覧を取得
 */
async function injectedGetTranscriptInfo() {
  const PANEL_SELECTOR =
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]';
  const SEGMENT_SELECTOR = 'ytd-transcript-segment-renderer';
  const DROPDOWN_SELECTOR = 'yt-dropdown-menu';
  const OPTION_SELECTOR = 'tp-yt-paper-item[role="option"]';

  function waitForElement(selector, timeout = 5000) {
    return new Promise((resolve) => {
      if (document.querySelector(selector)) { resolve(true); return; }
      const observer = new MutationObserver(() => {
        if (document.querySelector(selector)) { observer.disconnect(); resolve(true); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { observer.disconnect(); resolve(!!document.querySelector(selector)); }, timeout);
    });
  }

  // --- Video ID ---
  const videoId = new URLSearchParams(window.location.search).get('v');
  if (!videoId) return { error: 'YouTube動画ページではありません' };

  // --- メタデータ収集 ---
  const ogTitle = document.querySelector('meta[property="og:title"]');
  const title = ogTitle ? ogTitle.content : document.title.replace(' - YouTube', '').trim();

  const channelEl = document.querySelector('ytd-channel-name yt-formatted-string a');
  const channel = channelEl ? channelEl.textContent.trim() : '';

  const dateEl = document.querySelector('#info-strings yt-formatted-string');
  const publishDate = dateEl ? dateEl.textContent.trim() : '';

  // 説明欄を展開してから全文を取得する
  const expandBtn = document.querySelector('tp-yt-paper-button#expand, ytd-text-inline-expander #expand');
  if (expandBtn) {
    expandBtn.click();
    await new Promise(r => setTimeout(r, 500));
  }
  // 展開後の全文は #expanded 内の yt-attributed-string に格納される
  const descEl = document.querySelector('ytd-text-inline-expander #expanded yt-attributed-string')
    || document.querySelector('ytd-text-inline-expander #attributed-snippet-text');
  const description = descEl ? descEl.textContent.trim() : '';

  // --- 元言語の検出 ---
  // 優先順位:
  //   1. defaultAudioLanguage に一致する手動字幕
  //   2. defaultAudioLanguage に一致する字幕（自動生成含む）
  //   3. 手動字幕の先頭
  let originalLangCode = null;
  let originalLangName = null;
  try {
    if (typeof ytInitialPlayerResponse !== 'undefined' && ytInitialPlayerResponse) {
      const vd = ytInitialPlayerResponse.videoDetails || {};
      const mf = (ytInitialPlayerResponse.microformat || {}).playerMicroformatRenderer || {};
      const audioLang = vd.defaultAudioLanguage || mf.defaultAudioLanguage || null;

      const caps = ytInitialPlayerResponse.captions;
      if (caps && caps.playerCaptionsTracklistRenderer) {
        const tracks = caps.playerCaptionsTracklistRenderer.captionTracks || [];
        const manualTracks = tracks.filter(t => t.kind !== 'asr');
        let chosen = null;

        if (audioLang) {
          // audioLang に一致する手動字幕を探す（"en" は "en-US" 等にもマッチ）
          chosen = manualTracks.find(t =>
            t.languageCode === audioLang || t.languageCode.startsWith(audioLang.split('-')[0])
          );
          // 手動がなければ自動生成でもOK
          if (!chosen) {
            chosen = tracks.find(t =>
              t.languageCode === audioLang || t.languageCode.startsWith(audioLang.split('-')[0])
            );
          }
        }

        // audioLang が不明の場合、手動字幕の先頭にフォールバック
        if (!chosen && manualTracks.length > 0) {
          chosen = manualTracks[0];
        }

        if (chosen) {
          originalLangCode = chosen.languageCode;
          originalLangName = chosen.name ? chosen.name.simpleText : chosen.languageCode;
        }
      }
    }
  } catch (e) { /* ignore */ }

  // --- 字幕パネルを開く（SPA遷移対策: 前の動画のパネルが残っている場合は閉じて開き直す） ---
  let panel = document.querySelector(PANEL_SELECTOR);
  const isOpen = panel &&
    panel.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED';

  if (isOpen) {
    // パネルが開いているが、前の動画のものかもしれない
    // 一度閉じて開き直すことで確実に現在の動画の字幕を取得する
    const closeBtn = panel.querySelector('#visibility-button button, button[aria-label="閉じる"], button[aria-label="Close"]');
    if (closeBtn) {
      closeBtn.click();
      await new Promise(r => setTimeout(r, 500));
    }
  }

  {
    const ariaLabels = [
      '文字起こしを表示', 'Show transcript',
      'Transkript anzeigen', 'Afficher la transcription', 'Mostrar transcripción',
    ];
    let clicked = false;
    for (const label of ariaLabels) {
      const btn = document.querySelector(`button[aria-label="${label}"]`);
      if (btn) { btn.click(); clicked = true; break; }
    }
    if (!clicked) {
      const expandBtn = document.querySelector('tp-yt-paper-button#expand, ytd-text-inline-expander #expand');
      if (expandBtn) {
        expandBtn.click();
        await new Promise(r => setTimeout(r, 1000));
        for (const label of ariaLabels) {
          const btn = document.querySelector(`button[aria-label="${label}"]`);
          if (btn) { btn.click(); clicked = true; break; }
        }
      }
    }
    if (!clicked) return { error: 'この動画には字幕パネルがありません' };
    await new Promise(r => setTimeout(r, 1500));
    await waitForElement(SEGMENT_SELECTOR, 5000);
  }

  // --- 言語一覧 ---
  panel = document.querySelector(PANEL_SELECTOR);
  const languages = [];
  let currentLangName = '';
  if (panel) {
    const dropdown = panel.querySelector(DROPDOWN_SELECTOR);
    if (dropdown) {
      const options = dropdown.querySelectorAll(OPTION_SELECTOR);
      const currentLabel = dropdown.querySelector('#label');
      currentLangName = currentLabel ? currentLabel.textContent.trim() : '';
      options.forEach((option, index) => {
        const name = option.textContent.trim();
        languages.push({ index, name, isCurrent: name === currentLangName });
      });
    }
  }

  // --- 元言語に対応するドロップダウンのインデックスを特定 ---
  let originalLangIndex = null;
  if (originalLangName) {
    const match = languages.find(l => l.name === originalLangName);
    if (match) originalLangIndex = match.index;
  }

  const segmentCount = document.querySelectorAll(SEGMENT_SELECTOR).length;

  return {
    videoId, title, channel, publishDate, description,
    languages, currentLangName,
    originalLangCode, originalLangName, originalLangIndex,
    segmentCount,
  };
}

/**
 * タブ内で実行: 字幕セグメントをスクレイピングしてMarkdownに変換
 * @param {number|null} languageIndex
 * @param {object} meta - 動画メタデータ
 */
async function injectedFetchTranscript(languageIndex, meta) {
  const PANEL_SELECTOR =
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]';
  const SEGMENT_SELECTOR = 'ytd-transcript-segment-renderer';
  const DROPDOWN_SELECTOR = 'yt-dropdown-menu';
  const OPTION_SELECTOR = 'tp-yt-paper-item[role="option"]';

  function waitForElement(selector, timeout = 5000) {
    return new Promise((resolve) => {
      if (document.querySelector(selector)) { resolve(true); return; }
      const observer = new MutationObserver(() => {
        if (document.querySelector(selector)) { observer.disconnect(); resolve(true); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { observer.disconnect(); resolve(!!document.querySelector(selector)); }, timeout);
    });
  }

  // 言語切り替え
  if (languageIndex !== undefined && languageIndex !== null) {
    const panel = document.querySelector(PANEL_SELECTOR);
    if (panel) {
      const dropdown = panel.querySelector(DROPDOWN_SELECTOR);
      if (dropdown) {
        const options = dropdown.querySelectorAll(OPTION_SELECTOR);
        if (options[languageIndex]) {
          options[languageIndex].click();
          await new Promise(r => setTimeout(r, 2000));
          await waitForElement(SEGMENT_SELECTOR, 5000);
        }
      }
    }
  }

  // セグメント読み取り
  const segments = [];
  document.querySelectorAll(SEGMENT_SELECTOR).forEach(seg => {
    const timeEl = seg.querySelector('.segment-timestamp');
    const textEl = seg.querySelector('.segment-text');
    if (!timeEl || !textEl) return;
    const timeStr = timeEl.textContent.trim();
    const text = textEl.textContent.trim().replace(/\n/g, ' ');
    const parts = timeStr.split(':').map(Number);
    let seconds = 0;
    if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
    else if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
    segments.push({ start: seconds, time: timeStr, text });
  });

  if (segments.length === 0) {
    return { error: '字幕セグメントが取得できませんでした' };
  }

  // 現在の言語
  let currentLang = '不明';
  const panel = document.querySelector(PANEL_SELECTOR);
  if (panel) {
    const dropdown = panel.querySelector(DROPDOWN_SELECTOR);
    if (dropdown) {
      const label = dropdown.querySelector('#label');
      if (label) currentLang = label.textContent.trim();
    }
  }

  // Markdown 生成
  function fmt(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  const m = meta || {};
  const lines = [
    '# 動画情報',
    `- タイトル: ${m.title || ''}`,
  ];
  if (m.channel) lines.push(`- チャンネル: ${m.channel}`);
  lines.push(`- URL: https://www.youtube.com/watch?v=${m.videoId || ''}`);
  if (m.publishDate) lines.push(`- 公開日: ${m.publishDate}`);

  if (m.description) {
    lines.push('');
    lines.push('## 説明');
    lines.push('```');
    lines.push(m.description);
    lines.push('```');
  }

  lines.push('');
  lines.push(`## Transcript (${currentLang})`);
  lines.push('');

  for (const seg of segments) {
    lines.push(`**[${fmt(seg.start)}]** ${seg.text}`);
    lines.push('');
  }

  const markdown = lines.join('\n');
  return { segments, markdown, language: currentLang };
}

// Popupからのメッセージを処理
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'background') return false;

  const { type, tabId } = message;

  if (type === 'GET_TRANSCRIPT_INFO') {
    chrome.scripting.executeScript({
      target: { tabId },
      func: injectedGetTranscriptInfo,
      world: 'MAIN',
    })
    .then(results => {
      sendResponse(results?.[0]?.result || { error: 'スクリプト実行結果が取得できませんでした' });
    })
    .catch(err => {
      sendResponse({ error: `スクリプト注入エラー: ${err.message}` });
    });
    return true;
  }

  if (type === 'FETCH_TRANSCRIPT') {
    chrome.scripting.executeScript({
      target: { tabId },
      func: injectedFetchTranscript,
      args: [message.languageIndex ?? null, message.meta ?? null],
      world: 'MAIN',
    })
    .then(results => {
      sendResponse(results?.[0]?.result || { error: 'スクリプト実行結果が取得できませんでした' });
    })
    .catch(err => {
      sendResponse({ error: `スクリプト注入エラー: ${err.message}` });
    });
    return true;
  }

  return false;
});

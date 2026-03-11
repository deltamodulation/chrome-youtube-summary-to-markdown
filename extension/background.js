/**
 * Background Script (Service Worker)
 * chrome.scripting.executeScript でタブにスクリプトを動的注入し、
 * 字幕パネルのDOMスクレイピング結果を返す
 */

/**
 * タブ内で実行: 字幕パネルを開き、メタデータ・言語一覧を取得
 */
async function injectedGetTranscriptInfo() {
  // --- 新旧パネル対応セレクタ ---
  const OLD_PANEL_SELECTOR =
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]';
  const NEW_PANEL_SELECTOR =
    'ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"]';
  const OLD_SEGMENT_SELECTOR = 'ytd-transcript-segment-renderer';
  const NEW_SEGMENT_SELECTOR = 'transcript-segment-view-model';
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

  // 新旧いずれかのセグメントが出現するまで待つ
  function waitForSegments(timeout = 5000) {
    return new Promise((resolve) => {
      if (document.querySelector(OLD_SEGMENT_SELECTOR) || document.querySelector(NEW_SEGMENT_SELECTOR)) {
        resolve(true); return;
      }
      const observer = new MutationObserver(() => {
        if (document.querySelector(OLD_SEGMENT_SELECTOR) || document.querySelector(NEW_SEGMENT_SELECTOR)) {
          observer.disconnect(); resolve(true);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        resolve(!!(document.querySelector(OLD_SEGMENT_SELECTOR) || document.querySelector(NEW_SEGMENT_SELECTOR)));
      }, timeout);
    });
  }

  // どちらのパネルが使われているか判定
  function detectPanel() {
    const newPanel = document.querySelector(NEW_PANEL_SELECTOR);
    if (newPanel && newPanel.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED') {
      return { panel: newPanel, isModern: true };
    }
    const oldPanel = document.querySelector(OLD_PANEL_SELECTOR);
    if (oldPanel && oldPanel.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED') {
      return { panel: oldPanel, isModern: false };
    }
    // どちらも未展開の場合、存在するパネルを返す（ボタンクリック後に展開される）
    if (newPanel) return { panel: newPanel, isModern: true };
    if (oldPanel) return { panel: oldPanel, isModern: false };
    return { panel: null, isModern: false };
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
  // textContent だとリンクが短縮表示のままになるため、
  // <a> タグの表示テキストを href の完全URLで置換して取得する
  let description = '';
  if (descEl) {
    const clone = descEl.cloneNode(true);
    clone.querySelectorAll('a').forEach(a => {
      const href = a.getAttribute('href') || '';
      // YouTube のリダイレクトURL (/redirect?q=...) から実際のURLを抽出
      let url = href;
      try {
        const u = new URL(href, window.location.origin);
        if (u.pathname === '/redirect' && u.searchParams.has('q')) {
          url = u.searchParams.get('q');
        }
      } catch (e) { /* そのまま使う */ }
      a.textContent = url;
    });
    description = clone.textContent.trim();
  }

  // --- 元言語の検出 ---
  // movie_player.getPlayerResponse() はSPA遷移後も最新データを返す
  // ytInitialPlayerResponse は初回ロード時の値が残る可能性があるためフォールバックとして使用
  let originalLangCode = null;
  let originalLangName = null;
  try {
    let playerResponse = null;
    const player = document.querySelector('#movie_player');
    if (player && player.getPlayerResponse) {
      playerResponse = player.getPlayerResponse();
    }
    if (!playerResponse && typeof ytInitialPlayerResponse !== 'undefined') {
      playerResponse = ytInitialPlayerResponse;
    }
    if (playerResponse) {
      const vd = playerResponse.videoDetails || {};
      const mf = (playerResponse.microformat || {}).playerMicroformatRenderer || {};
      const audioLang = vd.defaultAudioLanguage || mf.defaultAudioLanguage || null;

      const caps = playerResponse.captions;
      if (caps && caps.playerCaptionsTracklistRenderer) {
        const tracks = caps.playerCaptionsTracklistRenderer.captionTracks || [];
        const manualTracks = tracks.filter(t => t.kind !== 'asr');
        let chosen = null;

        if (audioLang) {
          chosen = manualTracks.find(t =>
            t.languageCode === audioLang || t.languageCode.startsWith(audioLang.split('-')[0])
          );
          if (!chosen) {
            chosen = tracks.find(t =>
              t.languageCode === audioLang || t.languageCode.startsWith(audioLang.split('-')[0])
            );
          }
        }

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
  // 新旧いずれかの開いているパネルを閉じる
  for (const sel of [NEW_PANEL_SELECTOR, OLD_PANEL_SELECTOR]) {
    const p = document.querySelector(sel);
    if (p && p.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED') {
      const closeBtn = p.querySelector('#visibility-button button, button[aria-label="閉じる"], button[aria-label="Close"]');
      if (closeBtn) {
        closeBtn.click();
        await new Promise(r => setTimeout(r, 500));
      }
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
    await waitForSegments(5000);
  }

  // --- パネル種別を判定 ---
  const { panel, isModern } = detectPanel();

  // --- 言語一覧（旧パネルのみ。新パネルにはドロップダウンがない） ---
  const languages = [];
  let currentLangName = '';
  if (!isModern && panel) {
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

  const segSelector = isModern ? NEW_SEGMENT_SELECTOR : OLD_SEGMENT_SELECTOR;
  const segmentCount = document.querySelectorAll(segSelector).length;

  return {
    videoId, title, channel, publishDate, description,
    languages, currentLangName,
    originalLangCode, originalLangName, originalLangIndex,
    segmentCount, isModern,
  };
}

/**
 * タブ内で実行: 字幕セグメントをスクレイピングしてMarkdownに変換
 * @param {number|null} languageIndex
 * @param {object} meta - 動画メタデータ
 */
async function injectedFetchTranscript(languageIndex, meta) {
  const OLD_PANEL_SELECTOR =
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]';
  const NEW_PANEL_SELECTOR =
    'ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"]';
  const OLD_SEGMENT_SELECTOR = 'ytd-transcript-segment-renderer';
  const NEW_SEGMENT_SELECTOR = 'transcript-segment-view-model';
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

  // 新旧どちらのパネルが展開されているか判定
  const isModern = meta && meta.isModern;
  const PANEL_SELECTOR = isModern ? NEW_PANEL_SELECTOR : OLD_PANEL_SELECTOR;
  const SEGMENT_SELECTOR = isModern ? NEW_SEGMENT_SELECTOR : OLD_SEGMENT_SELECTOR;

  // 言語切り替え（旧パネルのみ）
  if (!isModern && languageIndex !== undefined && languageIndex !== null) {
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

  // セグメント読み取り（新旧セレクタ対応）
  const segments = [];
  document.querySelectorAll(SEGMENT_SELECTOR).forEach(seg => {
    let timeStr, text;
    if (isModern) {
      const timeEl = seg.querySelector('.ytwTranscriptSegmentViewModelTimestamp');
      const textEl = seg.querySelector('span.yt-core-attributed-string');
      if (!timeEl || !textEl) return;
      timeStr = timeEl.textContent.trim();
      text = textEl.textContent.trim().replace(/\n/g, ' ');
    } else {
      const timeEl = seg.querySelector('.segment-timestamp');
      const textEl = seg.querySelector('.segment-text');
      if (!timeEl || !textEl) return;
      timeStr = timeEl.textContent.trim();
      text = textEl.textContent.trim().replace(/\n/g, ' ');
    }
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
  if (!isModern) {
    const panel = document.querySelector(PANEL_SELECTOR);
    if (panel) {
      const dropdown = panel.querySelector(DROPDOWN_SELECTOR);
      if (dropdown) {
        const label = dropdown.querySelector('#label');
        if (label) currentLang = label.textContent.trim();
      }
    }
  } else {
    // 新パネルにはドロップダウンがないため、playerResponseから言語名を取得
    try {
      const player = document.querySelector('#movie_player');
      if (player && player.getPlayerResponse) {
        const pr = player.getPlayerResponse();
        const tracks = pr.captions.playerCaptionsTracklistRenderer.captionTracks || [];
        if (tracks.length > 0) {
          currentLang = tracks[0].name ? tracks[0].name.simpleText : tracks[0].languageCode;
        }
      }
    } catch (e) { /* ignore */ }
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

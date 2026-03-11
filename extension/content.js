/**
 * Content Script - YouTube動画ページに注入
 * YouTubeの字幕パネルをDOMスクレイピングして字幕データを取得する
 */
(() => {
  'use strict';

  // 新旧パネル対応セレクタ
  const OLD_PANEL_SELECTOR =
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]';
  const NEW_PANEL_SELECTOR =
    'ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"]';
  const OLD_SEGMENT_SELECTOR = 'ytd-transcript-segment-renderer';
  const NEW_SEGMENT_SELECTOR = 'transcript-segment-view-model';
  const DROPDOWN_SELECTOR = 'yt-dropdown-menu';
  const OPTION_SELECTOR = 'tp-yt-paper-item[role="option"]';

  // 新旧どちらのパネルが開いているか判定
  function detectPanel() {
    const newPanel = document.querySelector(NEW_PANEL_SELECTOR);
    if (newPanel && newPanel.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED') {
      return { panel: newPanel, isModern: true };
    }
    const oldPanel = document.querySelector(OLD_PANEL_SELECTOR);
    if (oldPanel && oldPanel.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED') {
      return { panel: oldPanel, isModern: false };
    }
    if (newPanel) return { panel: newPanel, isModern: true };
    if (oldPanel) return { panel: oldPanel, isModern: false };
    return { panel: null, isModern: false };
  }

  function getSegmentSelector() {
    return document.querySelector(NEW_SEGMENT_SELECTOR) ? NEW_SEGMENT_SELECTOR : OLD_SEGMENT_SELECTOR;
  }

  const log = (...args) => console.log('[YT-Summary]', ...args);

  function getVideoId() {
    return new URLSearchParams(window.location.search).get('v');
  }

  function getVideoTitle() {
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) return ogTitle.content;
    const titleEl = document.querySelector(
      'h1.ytd-watch-metadata yt-formatted-string'
    );
    if (titleEl) return titleEl.textContent.trim();
    return document.title.replace(' - YouTube', '').trim();
  }

  /**
   * 指定セレクタの要素が出現するまで待つ
   */
  function waitForElement(selector, timeout = 5000) {
    return new Promise((resolve) => {
      const existing = document.querySelector(selector);
      if (existing) {
        resolve(true);
        return;
      }
      const observer = new MutationObserver(() => {
        if (document.querySelector(selector)) {
          observer.disconnect();
          resolve(true);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        resolve(!!document.querySelector(selector));
      }, timeout);
    });
  }

  /**
   * 字幕パネルを開く（複数のボタンセレクタをフォールバック）
   */
  async function openTranscriptPanel() {
    // SPA遷移対策: 新旧いずれかのパネルが開いていたら閉じて開き直す
    for (const sel of [NEW_PANEL_SELECTOR, OLD_PANEL_SELECTOR]) {
      const panel = document.querySelector(sel);
      if (
        panel &&
        panel.getAttribute('visibility') ===
          'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED'
      ) {
        log('Transcript panel open — closing to refresh for current video');
        const closeBtn = panel.querySelector('#visibility-button button, button[aria-label="閉じる"], button[aria-label="Close"]');
        if (closeBtn) {
          closeBtn.click();
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }

    // 「文字起こしを表示」ボタンを探す（複数パターン）
    const buttonSelectors = [
      'button[aria-label="文字起こしを表示"]',
      'button[aria-label="Show transcript"]',
      'button[aria-label="Transkript anzeigen"]',
      'button[aria-label="Afficher la transcription"]',
    ];

    let clicked = false;
    for (const sel of buttonSelectors) {
      const btn = document.querySelector(sel);
      if (btn) {
        log('Found transcript button:', sel);
        btn.click();
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      // 説明欄を展開して再検索
      log('Trying to expand description first...');
      const expandBtn = document.querySelector(
        'tp-yt-paper-button#expand, ytd-text-inline-expander #expand'
      );
      if (expandBtn) {
        expandBtn.click();
        await new Promise((r) => setTimeout(r, 1000));

        for (const sel of buttonSelectors) {
          const btn = document.querySelector(sel);
          if (btn) {
            log('Found transcript button after expand:', sel);
            btn.click();
            clicked = true;
            break;
          }
        }
      }
    }

    if (!clicked) {
      log('Transcript button not found');
      return false;
    }

    // パネルが開くのを待つ（新旧いずれかのセグメントが出現するまで）
    await new Promise((r) => setTimeout(r, 1500));
    const found = await new Promise((resolve) => {
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
      }, 5000);
    });
    log('Segments found after panel open:', found);
    return found;
  }

  /**
   * 字幕パネルから利用可能な言語一覧を取得
   */
  function getAvailableLanguages() {
    const { panel, isModern } = detectPanel();
    if (!panel || isModern) return []; // 新パネルにはドロップダウンがない

    const dropdown = panel.querySelector(DROPDOWN_SELECTOR);
    if (!dropdown) return [];

    const options = dropdown.querySelectorAll(OPTION_SELECTOR);
    const currentLabel = dropdown.querySelector('#label');
    const currentLang = currentLabel ? currentLabel.textContent.trim() : '';

    const languages = [];
    options.forEach((option, index) => {
      const name = option.textContent.trim();
      languages.push({
        index,
        name,
        isCurrent: name === currentLang,
      });
    });

    return languages;
  }

  /**
   * 言語を切り替える
   */
  async function switchLanguage(index) {
    const { panel, isModern } = detectPanel();
    if (!panel || isModern) return false; // 新パネルでは言語切替不可

    const dropdown = panel.querySelector(DROPDOWN_SELECTOR);
    if (!dropdown) return false;

    const options = dropdown.querySelectorAll(OPTION_SELECTOR);
    if (index >= options.length) return false;

    options[index].click();
    await new Promise((r) => setTimeout(r, 1500));
    await waitForElement(getSegmentSelector(), 5000);
    return true;
  }

  /**
   * 字幕パネルからセグメントを読み取る
   */
  function scrapeSegments() {
    const { isModern } = detectPanel();
    const segSelector = isModern ? NEW_SEGMENT_SELECTOR : OLD_SEGMENT_SELECTOR;
    const segments = document.querySelectorAll(segSelector);
    const result = [];

    segments.forEach((seg) => {
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
      if (parts.length === 3) {
        seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
      } else if (parts.length === 2) {
        seconds = parts[0] * 60 + parts[1];
      }

      result.push({ start: seconds, time: timeStr, text });
    });

    return result;
  }

  function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function toMarkdown(segments, videoTitle, videoId, languageName) {
    const lines = [
      `# ${videoTitle}`,
      '',
      `- URL: https://www.youtube.com/watch?v=${videoId}`,
      `- Language: ${languageName}`,
      `- Extracted: ${new Date().toISOString().split('T')[0]}`,
      '',
      '## Transcript',
      '',
    ];
    for (const seg of segments) {
      lines.push(`**[${formatTime(seg.start)}]** ${seg.text}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  // メッセージリスナー
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    log('Received message:', message.type);

    if (message.type === 'GET_TRANSCRIPT_INFO') {
      const videoId = getVideoId();
      if (!videoId) {
        sendResponse({ error: 'YouTube動画ページではありません' });
        return true;
      }

      // 全ての非同期処理をtry-catchで囲み、必ずsendResponseを呼ぶ
      (async () => {
        try {
          const opened = await openTranscriptPanel();
          if (!opened) {
            return { error: 'この動画には字幕パネルがありません' };
          }

          const title = getVideoTitle();
          const languages = getAvailableLanguages();
          const segments = scrapeSegments();

          log('Got info:', { title, langCount: languages.length, segCount: segments.length });
          return { videoId, title, languages, segmentCount: segments.length };
        } catch (err) {
          log('Error in GET_TRANSCRIPT_INFO:', err);
          return { error: err.message || String(err) };
        }
      })().then(sendResponse);

      return true; // 非同期レスポンスを示す
    }

    if (message.type === 'FETCH_TRANSCRIPT') {
      (async () => {
        try {
          const { languageIndex } = message;

          if (languageIndex !== undefined && languageIndex !== null) {
            await switchLanguage(languageIndex);
          }

          const segments = scrapeSegments();
          if (segments.length === 0) {
            return { error: '字幕セグメントが取得できませんでした' };
          }

          const videoId = getVideoId();
          const title = getVideoTitle();
          const languages = getAvailableLanguages();
          const currentLang =
            languages.find((l) => l.isCurrent)?.name || '不明';

          const markdown = toMarkdown(segments, title, videoId, currentLang);
          log('Got transcript:', { segCount: segments.length, lang: currentLang });
          return { segments, markdown, language: currentLang };
        } catch (err) {
          log('Error in FETCH_TRANSCRIPT:', err);
          return { error: err.message || String(err) };
        }
      })().then(sendResponse);

      return true;
    }

    return false;
  });

  log('Content script loaded for:', window.location.href);
})();

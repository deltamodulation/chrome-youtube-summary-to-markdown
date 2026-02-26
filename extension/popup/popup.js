/**
 * Popup Script
 * 字幕トラック一覧の表示、取得、Markdown表示・コピー
 */
(() => {
  'use strict';

  const statusEl = document.getElementById('status');
  const trackSelectorEl = document.getElementById('track-selector');
  const languageSelectEl = document.getElementById('language-select');
  const fetchBtn = document.getElementById('fetch-btn');
  const resultEl = document.getElementById('result');
  const markdownOutputEl = document.getElementById('markdown-output');
  const copyBtn = document.getElementById('copy-btn');
  const copyFeedbackEl = document.getElementById('copy-feedback');

  let currentTabId = null;
  let currentMeta = null; // 動画メタデータ
  let currentMarkdown = '';

  function showStatus(text, type = 'loading') {
    statusEl.textContent = text;
    statusEl.className = `status ${type}`;
    statusEl.classList.remove('hidden');
  }

  function hideStatus() {
    statusEl.classList.add('hidden');
  }

  async function getActiveTabId() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('アクティブなタブが見つかりません');
    if (!tab.url || !tab.url.includes('youtube.com/watch')) {
      throw new Error('YouTube動画ページを開いてください');
    }
    return tab.id;
  }

  function sendToBackground(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response?.error) {
          reject(new Error(response.error));
          return;
        }
        resolve(response);
      });
    });
  }

  /**
   * 字幕情報を取得して言語一覧を表示
   */
  async function loadTranscriptInfo() {
    showStatus('字幕パネルを開いています...');
    trackSelectorEl.classList.add('hidden');
    resultEl.classList.add('hidden');

    try {
      currentTabId = await getActiveTabId();
      const info = await sendToBackground({
        target: 'background',
        type: 'GET_TRANSCRIPT_INFO',
        tabId: currentTabId,
      });

      // メタデータを保存
      currentMeta = {
        videoId: info.videoId,
        title: info.title,
        channel: info.channel,
        publishDate: info.publishDate,
        description: info.description,
      };

      const { languages, originalLangIndex } = info;

      if (!languages || languages.length === 0) {
        showStatus('言語情報を取得できませんでした', 'error');
        return;
      }

      // 言語選択プルダウンを構築
      languageSelectEl.innerHTML = '';
      for (const lang of languages) {
        const option = document.createElement('option');
        option.value = lang.index;
        option.textContent = lang.name;
        languageSelectEl.appendChild(option);
      }

      // 元言語を自動選択（見つからなければ現在の言語のまま）
      if (originalLangIndex !== null && originalLangIndex !== undefined) {
        languageSelectEl.value = String(originalLangIndex);
      }

      hideStatus();
      trackSelectorEl.classList.remove('hidden');

      // 自動取得
      await fetchTranscript();
    } catch (err) {
      showStatus(err.message, 'error');
    }
  }

  /**
   * 選択した言語の字幕を取得
   */
  async function fetchTranscript() {
    const languageIndex = parseInt(languageSelectEl.value, 10);

    showStatus('字幕を取得中...');
    fetchBtn.disabled = true;

    try {
      const response = await sendToBackground({
        target: 'background',
        type: 'FETCH_TRANSCRIPT',
        tabId: currentTabId,
        languageIndex,
        meta: currentMeta,
      });

      currentMarkdown = response.markdown;
      markdownOutputEl.textContent = currentMarkdown;
      showStatus(`取得完了（${response.language}・${response.segments.length}セグメント）`, 'success');
      resultEl.classList.remove('hidden');
    } catch (err) {
      showStatus(err.message, 'error');
    } finally {
      fetchBtn.disabled = false;
    }
  }

  async function copyMarkdown() {
    try {
      await navigator.clipboard.writeText(currentMarkdown);
      copyFeedbackEl.classList.remove('hidden');
      setTimeout(() => copyFeedbackEl.classList.add('hidden'), 2000);
    } catch (err) {
      showStatus('コピーに失敗しました', 'error');
    }
  }

  fetchBtn.addEventListener('click', fetchTranscript);
  copyBtn.addEventListener('click', copyMarkdown);

  loadTranscriptInfo();
})();

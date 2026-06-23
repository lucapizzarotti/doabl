// Track video state per tab: tabId → { videoId, url, isWatch }
const tabVideoState = new Map();

// Enable side panel on toolbar icon click
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(console.error);

// ── URL helpers ────────────────────────────────────────────────

function parseYouTubeUrl(url) {
  if (!url) return { isWatch: false, videoId: null };
  try {
    const u = new URL(url);
    const isWatch =
      (u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com') &&
      u.pathname === '/watch';
    const videoId = isWatch ? u.searchParams.get('v') : null;
    return { isWatch: isWatch && !!videoId, videoId };
  } catch {
    return { isWatch: false, videoId: null };
  }
}

// ── Tab change detection (SPA + normal navigation) ─────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;

  const { isWatch, videoId } = parseYouTubeUrl(changeInfo.url);
  const prev = tabVideoState.get(tabId);
  const newState = { videoId, isWatch, url: changeInfo.url };
  tabVideoState.set(tabId, newState);

  if (!prev || prev.videoId !== videoId || prev.isWatch !== isWatch) {
    notifyPanel({ type: 'VIDEO_CHANGED', tabId, videoId, isWatch, url: changeInfo.url });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabVideoState.delete(tabId);
});

// ── Broadcast to panel (may not be open — swallow errors) ──────

function notifyPanel(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

// ── Message hub ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'GET_ACTIVE_TAB_VIDEO': {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs.length) {
          sendResponse({ videoId: null, isWatch: false, tabId: null });
          return;
        }
        const tab = tabs[0];
        let state = tabVideoState.get(tab.id);
        if (!state) {
          const parsed = parseYouTubeUrl(tab.url);
          state = { ...parsed, url: tab.url || '' };
          tabVideoState.set(tab.id, state);
        }
        sendResponse({ ...state, tabId: tab.id });
      });
      return true; // async
    }

    case 'FORWARD_TO_CONTENT': {
      const { tabId, payload } = message;
      chrome.tabs.sendMessage(tabId, payload, (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          sendResponse(response);
        }
      });
      return true; // async
    }

    case 'AD_STATE_CHANGED': {
      notifyPanel({ type: 'AD_STATE_CHANGED', isAd: message.isAd, tabId: sender.tab?.id });
      break;
    }

    default:
      break;
  }
});

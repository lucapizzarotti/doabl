// Minimal surface: only interact with <video>.
// Injected into youtube.com pages — stays alive across SPA navigations.
// Wrapped in a guard so on-demand re-injection (from the service worker) is a
// no-op when this script is already running in the tab.

(() => {
  if (window.__doablLoaded) return;
  window.__doablLoaded = true;

  function getVideo() {
    return (
      document.querySelector('#movie_player video.html5-main-video') ||
      document.querySelector('.html5-main-video') ||
      document.querySelector('#movie_player video') ||
      document.querySelector('video')
    );
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const video = getVideo();

    switch (message.type) {
      case 'GET_VIDEO_STATE': {
        if (!video) {
          sendResponse({ error: 'no video element found' });
          break;
        }
        sendResponse({
          currentTime: video.currentTime,
          paused: video.paused,
          title: document.title.replace(/ - YouTube$/, '').trim(),
          isAd: !!document.querySelector('#movie_player.ad-showing'),
        });
        break;
      }

      case 'PAUSE_VIDEO': {
        video?.pause();
        sendResponse({ ok: true });
        break;
      }

      case 'PLAY_VIDEO': {
        video?.play().catch(() => {});
        sendResponse({ ok: true });
        break;
      }

      case 'SEEK_VIDEO': {
        if (video) video.currentTime = message.time;
        sendResponse({ ok: true });
        break;
      }

      default:
        sendResponse({ error: 'unknown message type' });
    }
  });

  // ── Ad observer ───────────────────────────────────────────────
  // Watches #movie_player class changes and pushes AD_STATE_CHANGED to the panel
  // via the service worker. Uses a MutationObserver (no polling).

  let adObserver = null;

  function setupAdObserver() {
    if (adObserver) return;
    const player = document.querySelector('#movie_player');
    if (!player) return;

    let wasAd = player.classList.contains('ad-showing');
    adObserver = new MutationObserver(() => {
      const isAd = player.classList.contains('ad-showing');
      if (isAd !== wasAd) {
        wasAd = isAd;
        chrome.runtime.sendMessage({ type: 'AD_STATE_CHANGED', isAd }).catch(() => {});
      }
    });
    adObserver.observe(player, { attributes: true, attributeFilter: ['class'] });
  }

  // Try immediately and after short delays — #movie_player may not exist yet
  // on non-watch pages when the content script first loads.
  setupAdObserver();
  [500, 1500, 3000].forEach((ms) => setTimeout(setupAdObserver, ms));

  // Re-observe after SPA navigation (player element may be recreated).
  document.addEventListener('yt-navigate-finish', () => {
    if (adObserver) { adObserver.disconnect(); adObserver = null; }
    setupAdObserver();
    setTimeout(setupAdObserver, 500);
  });
})();

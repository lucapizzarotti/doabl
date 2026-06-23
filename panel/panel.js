// ── Utilities ─────────────────────────────────────────────────

function formatTime(seconds) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Parse the videoId out of a youtube.com/watch URL (null otherwise).
function parseVideoId(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const isWatch =
      (u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com') &&
      u.pathname === '/watch';
    return isWatch ? u.searchParams.get('v') : null;
  } catch {
    return null;
  }
}

// ── Storage helpers ───────────────────────────────────────────

async function getVideoRecord(videoId) {
  const result = await chrome.storage.local.get(videoId);
  return result[videoId] || null;
}

async function saveVideoRecord(record) {
  await chrome.storage.local.set({ [record.videoId]: record });
}

async function getAllVideos() {
  const all = await chrome.storage.local.get(null);
  return Object.values(all).filter((v) => v && typeof v === 'object' && v.videoId && Array.isArray(v.steps));
}

// Central rule: completedAt is set only when steps.length > 0 and all done.
// Called after every mutation so the rule is never scattered across callers.
function recomputeCompletion(record) {
  const allDone = record.steps.length > 0 && record.steps.every((s) => s.done);
  if (!allDone) {
    delete record.completedAt;
  }
  // completedAt is only written by markCompleted(); here we only clear it.
}

async function markCompleted(videoId) {
  const record = await getVideoRecord(videoId);
  if (!record || record.steps.length === 0) return;
  if (!record.steps.every((s) => s.done)) return;
  record.completedAt = Date.now();
  await saveVideoRecord(record);
}

async function createStep(videoId, title, url, text, timestamp) {
  let record = await getVideoRecord(videoId);
  if (!record) {
    record = {
      videoId,
      title: title || videoId,
      url: url || `https://www.youtube.com/watch?v=${videoId}`,
      createdAt: Date.now(),
      steps: [],
    };
  } else if (!record.title || record.title === videoId) {
    if (title) record.title = title;
  }
  const step = {
    id: crypto.randomUUID(),
    text,
    timestamp,
    done: false,
    createdAt: Date.now(),
  };
  record.steps.push(step);
  recomputeCompletion(record); // adding a step always clears completedAt
  await saveVideoRecord(record);
  return step;
}

async function toggleStep(videoId, stepId) {
  const record = await getVideoRecord(videoId);
  if (!record) return;
  const step = record.steps.find((s) => s.id === stepId);
  if (step) step.done = !step.done;
  recomputeCompletion(record); // un-checking clears completedAt
  await saveVideoRecord(record);
}

async function deleteStep(videoId, stepId) {
  const record = await getVideoRecord(videoId);
  if (!record) return;
  record.steps = record.steps.filter((s) => s.id !== stepId);
  recomputeCompletion(record); // may clear completedAt if steps drop to 0
  await saveVideoRecord(record);
}

async function editStepText(videoId, stepId, newText) {
  const record = await getVideoRecord(videoId);
  if (!record) return;
  const step = record.steps.find((s) => s.id === stepId);
  if (step) step.text = newText;
  await saveVideoRecord(record);
}

async function renameVideo(videoId, newTitle) {
  const record = await getVideoRecord(videoId);
  if (!record) return;
  record.title = newTitle;
  await saveVideoRecord(record);
}

function sortedSteps(steps) {
  return [...steps].sort((a, b) => a.timestamp - b.timestamp);
}

// ── Communication helpers ─────────────────────────────────────

function sendToSW(message) {
  return chrome.runtime.sendMessage(message);
}

async function getActiveTabState() {
  return sendToSW({ type: 'GET_ACTIVE_TAB_VIDEO' });
}

async function sendToContent(tabId, payload) {
  return sendToSW({ type: 'FORWARD_TO_CONTENT', tabId, payload });
}

// Try to get the video state from the content script. Retries a few times
// because the <video> element may not be in the DOM immediately after SPA
// navigation. Falls back to null if unavailable (caller uses safe defaults).
async function getVideoState(tabId) {
  if (tabId == null) return null;
  for (let i = 0; i < 4; i++) {
    try {
      const vs = await sendToContent(tabId, { type: 'GET_VIDEO_STATE' });
      if (vs && !vs.error) return vs;
    } catch { /* content script not ready yet */ }
    if (i < 3) await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

// Read the page title straight from the tab (no content script needed).
// Strips YouTube's "(N)" notification count prefix and " - YouTube" suffix.
// Returns '' while YouTube still shows the placeholder (e.g. "(209) YouTube"),
// so callers keep polling until the real video title is set after SPA nav.
async function getTabTitle(tabId) {
  if (tabId == null) return '';
  try {
    const tab = await chrome.tabs.get(tabId);
    let t = (tab?.title || '').trim();
    t = t.replace(/^\(\d+\)\s*/, '');          // notification count prefix
    t = t.replace(/\s*-\s*YouTube$/, '').trim(); // " - YouTube" suffix
    return t && t !== 'YouTube' ? t : '';
  } catch {
    return '';
  }
}

// ── State: context (reactive) vs viewing (user-chosen) ────────

// CONTEXT — what's happening in the active tab. Reacts to tab events.
const context = {
  activeTabId: null,
  contextVideoId: null,
  contextIsWatch: false,
  contextUrl: '',
};

// Ad state pushed from the content script via service worker.
let isAdPlaying = false;

// VIEWING — what the panel is showing. Only the user (or a same-tab
// navigation while live) changes viewingVideoId.
const viewing = {
  view: 'library',          // 'library' | 'detail'
  viewingVideoId: null,
  pinned: false,            // true = user opened this checklist on purpose
  title: '',
  url: '',
  steps: [],
  captureMode: false,
  captureTimestamp: 0,
  captureWasPlaying: false,
  editingStepId: null,
  allVideos: [],
};

// "Live" is DERIVED, never stored: the video on screen is the one
// playing in the active /watch tab.
function isLive() {
  return (
    viewing.view === 'detail' &&
    viewing.viewingVideoId != null &&
    viewing.viewingVideoId === context.contextVideoId &&
    context.contextIsWatch
  );
}

// ── DOM refs ──────────────────────────────────────────────────

const els = {
  btnBack:              document.getElementById('btn-back'),
  logo:                 document.getElementById('logo'),
  headerTitle:          document.getElementById('header-title'),
  headerTitleText:      document.getElementById('header-title-text'),
  headerTitleInput:     document.getElementById('header-title-input'),
  viewDetail:           document.getElementById('view-detail'),
  viewLibrary:          document.getElementById('view-library'),
  activeVideoPill:      document.getElementById('active-video-pill'),
  pillTitle:            document.getElementById('pill-title'),
  completionAffordance: document.getElementById('completion-affordance'),
  btnMarkComplete:      document.getElementById('btn-mark-complete'),
  stepsList:            document.getElementById('steps-list'),
  emptyNoSteps:         document.getElementById('empty-no-steps'),
  emptyNoStepsDesc:     document.getElementById('empty-no-steps-desc'),
  emptyNotWatch:        document.getElementById('empty-not-watch'),
  captureZone:          document.getElementById('capture-zone'),
  btnAddStep:           document.getElementById('btn-add-step'),
  captureMode:          document.getElementById('capture-mode'),
  captureTimeDisplay:   document.getElementById('capture-time-display'),
  stepInput:            document.getElementById('step-input'),
  btnSaveStep:          document.getElementById('btn-save-step'),
  libraryList:          document.getElementById('library-list'),
  emptyLibrary:         document.getElementById('empty-library'),
  homeVideoPill:        document.getElementById('home-video-pill'),
  homePillTitle:        document.getElementById('home-pill-title'),
  captureAdState:       document.getElementById('capture-ad-state'),
  headerCompletedRow:   document.getElementById('header-completed-row'),
};

// ── Render dispatcher ─────────────────────────────────────────

function renderCurrent() {
  const isDetail = viewing.view === 'detail';
  els.viewDetail.classList.toggle('hidden', !isDetail);
  els.viewLibrary.classList.toggle('hidden', isDetail);
  renderHeader();
  if (isDetail) renderDetail(); // async, intentionally not awaited
  else renderLibrary();
}

function renderHeader() {
  const isDetail = viewing.view === 'detail';
  els.btnBack.classList.toggle('hidden', !isDetail);
  els.logo.classList.toggle('hidden', isDetail);
  els.headerTitle.classList.toggle('hidden', !isDetail);
  if (isDetail) {
    els.headerTitleText.textContent =
      viewing.title || (isLive() ? 'Cargando…' : (viewing.viewingVideoId || '—'));
    // Tooltip: full title (so truncated names are readable on hover).
    els.headerTitleText.title = viewing.title || 'Renombrar';
  }
}

// ── Navigation ────────────────────────────────────────────────

function goHome() {
  viewing.view = 'library';
  viewing.editingStepId = null;
  if (viewing.captureMode) exitCaptureMode(true);
  clearCompletedBadge();
  renderCurrent();
}

function clearCompletedBadge() {
  if (els.headerCompletedRow) els.headerCompletedRow.classList.add('hidden');
}

function showCompletedBadge(completedAt) {
  if (!els.headerCompletedRow) return;
  const date = new Date(completedAt || Date.now());
  const formatted = date.toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' });
  els.headerCompletedRow.textContent = `✓ Completado el ${formatted}`;
  els.headerCompletedRow.classList.remove('hidden');
}

// Open the detail (checklist) of a video.
// pinned = the user opened it on purpose (library item / pill) and it should
// survive context changes; unpinned = auto-opened, driven by the active video.
async function openDetail(videoId, url, { pinned = false, justNavigated = false } = {}) {
  clearCompletedBadge();
  viewing.view = 'detail';
  viewing.viewingVideoId = videoId;
  viewing.pinned = pinned;
  viewing.url = url || `https://www.youtube.com/watch?v=${videoId}`;
  viewing.editingStepId = null;
  viewing.captureMode = false;
  els.captureMode.classList.add('hidden');
  els.btnAddStep.classList.remove('hidden');

  const record = await getVideoRecord(videoId);
  if (record) {
    viewing.steps = record.steps;
    viewing.title = record.title;
    renderCurrent();
    if (record.completedAt) showCompletedBadge(record.completedAt);
    return;
  }

  // Brand-new video (no record yet): no steps, and the title may not be
  // ready (YouTube updates the tab title async after SPA navigation).
  viewing.steps = [];
  viewing.title = '';
  renderCurrent();
  if (isLiveCandidate(videoId)) {
    ensureLiveTitle(videoId, justNavigated);
  } else {
    viewing.title = videoId;
    renderHeader();
  }
}

// Would this video be "live" if we were viewing it right now?
function isLiveCandidate(videoId) {
  return context.contextIsWatch && context.contextVideoId === videoId;
}

// Resolve the tab title for a brand-new video. The tab title updates async
// after SPA navigation, and during the transition it still holds the PREVIOUS
// page's title (the old video, the playlist page, etc.). When we just
// navigated, we capture that stale title and wait until it actually changes.
// When the video was already loaded (pill, panel opened on it), the title is
// already correct and we take the first valid read.
async function ensureLiveTitle(videoId, justNavigated) {
  const stale = justNavigated ? await getTabTitle(context.activeTabId) : null;

  for (let attempt = 0; attempt < 12; attempt++) {
    if (viewing.viewingVideoId !== videoId) return; // user moved on
    const t = await getTabTitle(context.activeTabId);
    if (t && t !== videoId && (!justNavigated || t !== stale)) {
      if (viewing.viewingVideoId === videoId) {
        viewing.title = t;
        renderHeader();
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  // Last resort: take whatever the tab title is now, else the id.
  if (viewing.viewingVideoId === videoId && !viewing.title) {
    const t = await getTabTitle(context.activeTabId);
    viewing.title = t && t !== videoId ? t : videoId;
    renderHeader();
  }
}

// ── Detail view rendering ─────────────────────────────────────

async function renderDetail() {
  const live = isLive();

  // No video selected → fallback empty state.
  if (!viewing.viewingVideoId) {
    els.stepsList.innerHTML = '';
    els.emptyNoSteps.classList.add('hidden');
    els.captureZone.classList.add('hidden');
    els.activeVideoPill.classList.add('hidden');
    els.emptyNotWatch.classList.remove('hidden');
    return;
  }
  els.emptyNotWatch.classList.add('hidden');

  // Pill: a different /watch video is active in the current tab.
  const showPill =
    context.contextIsWatch &&
    context.contextVideoId &&
    context.contextVideoId !== viewing.viewingVideoId;
  els.activeVideoPill.classList.toggle('hidden', !showPill);
  if (showPill) {
    getVideoRecord(context.contextVideoId).then((rec) => {
      els.pillTitle.textContent = rec?.title || 'otro video';
    });
  }

  // Completion affordance: show when all steps done but not yet marked complete.
  const allDone = viewing.steps.length > 0 && viewing.steps.every((s) => s.done);
  const isCompleted = !!(await getVideoRecord(viewing.viewingVideoId))?.completedAt;
  const showAffordance = allDone && !isCompleted;
  els.completionAffordance.classList.toggle('hidden', !showAffordance);

  // Capture only when live.
  els.captureZone.classList.toggle('hidden', !live);

  // Ad state: override capture zone contents when an ad is playing.
  if (live && els.captureAdState) {
    els.captureAdState.classList.toggle('hidden', !isAdPlaying);
    if (isAdPlaying) {
      els.btnAddStep.classList.add('hidden');
      if (viewing.captureMode) {
        viewing.captureMode = false;
        viewing.captureWasPlaying = false;
        viewing.captureTimestamp = 0;
        els.captureMode.classList.add('hidden');
        els.stepInput.value = '';
      }
    } else if (!viewing.captureMode) {
      els.btnAddStep.classList.remove('hidden');
    }
  }

  // Empty state when no steps yet.
  const showNoSteps = viewing.steps.length === 0;
  els.emptyNoSteps.classList.toggle('hidden', !showNoSteps);
  els.emptyNoStepsDesc.textContent = live
    ? 'Tocá "+ agregar paso" para capturar el primer momento del tutorial.'
    : 'Este tutorial todavía no tiene pasos. Abrí el video para capturar.';

  // Render steps.
  els.stepsList.innerHTML = '';
  for (const step of sortedSteps(viewing.steps)) {
    els.stepsList.appendChild(buildStepEl(step));
  }
}

function buildStepEl(step) {
  const item = document.createElement('div');
  item.className = `step-item${step.done ? ' done' : ''}`;
  item.dataset.id = step.id;
  item.setAttribute('role', 'listitem');

  // Edit mode for this step.
  if (viewing.editingStepId === step.id) {
    item.innerHTML = `
      <div class="step-body" style="padding-top:2px;">
        <input
          type="text"
          class="step-edit-input"
          value="${escHtml(step.text)}"
          data-edit-id="${step.id}"
          spellcheck="false"
        />
      </div>
    `;
    const editInput = item.querySelector('.step-edit-input');
    setTimeout(() => { editInput.focus(); editInput.select(); }, 0);
    editInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirmEdit(step.id, editInput.value);
      if (e.key === 'Escape') cancelEdit();
    });
    editInput.addEventListener('blur', () => confirmEdit(step.id, editInput.value));
    return item;
  }

  // Check (toggle done)
  const checkEl = document.createElement('div');
  checkEl.className = 'step-check';
  checkEl.setAttribute('role', 'checkbox');
  checkEl.setAttribute('aria-checked', step.done ? 'true' : 'false');
  checkEl.setAttribute('tabindex', '0');
  checkEl.setAttribute('aria-label', step.done ? 'Marcar como pendiente' : 'Marcar como hecho');
  checkEl.innerHTML = `
    <svg class="step-check-icon" width="9" height="9" viewBox="0 0 9 9" fill="none">
      <path d="M1.5 4.5L3.5 6.5L7.5 2.5" stroke="#0B0B0F" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `;
  checkEl.addEventListener('click', (e) => { e.stopPropagation(); handleToggle(step.id); });
  checkEl.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); handleToggle(step.id); }
  });

  // Body
  const body = document.createElement('div');
  body.className = 'step-body';
  body.innerHTML = `
    <div class="step-text">${escHtml(step.text)}</div>
    <div class="step-timestamp">${formatTime(step.timestamp)}</div>
  `;

  // Actions
  const actions = document.createElement('div');
  actions.className = 'step-actions';

  const editBtn = document.createElement('button');
  editBtn.className = 'step-action-btn';
  editBtn.title = 'Editar';
  editBtn.setAttribute('aria-label', 'Editar paso');
  editBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <path d="M8.5 1.5L10.5 3.5L4 10H2V8L8.5 1.5Z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  editBtn.addEventListener('click', (e) => { e.stopPropagation(); startEdit(step.id); });

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'step-action-btn danger';
  deleteBtn.title = 'Borrar';
  deleteBtn.setAttribute('aria-label', 'Borrar paso');
  deleteBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <path d="M2 3H10M4 3V2H8V3M5 5.5V9M7 5.5V9M3 3L3.5 10H8.5L9 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  deleteBtn.addEventListener('click', (e) => { e.stopPropagation(); handleDelete(step.id); });

  actions.appendChild(editBtn);
  actions.appendChild(deleteBtn);

  // Click on body → seek to timestamp (live: direct; browsing: open video)
  body.style.cursor = 'pointer';
  body.addEventListener('click', () => handleSeek(step.timestamp));
  body.title = isLive() ? `Saltar a ${formatTime(step.timestamp)}` : `Abrir el video en ${formatTime(step.timestamp)}`;

  item.appendChild(checkEl);
  item.appendChild(body);
  item.appendChild(actions);

  return item;
}

// ── Library view rendering ────────────────────────────────────

async function renderLibrary() {
  const videos = await getAllVideos();
  viewing.allVideos = videos;

  // In-progress first (recency), completed at the bottom (recency within group).
  const byRecency = (a, b) => {
    const aTime = Math.max(a.createdAt, ...a.steps.map((s) => s.createdAt));
    const bTime = Math.max(b.createdAt, ...b.steps.map((s) => s.createdAt));
    return bTime - aTime;
  };
  const inProgress = videos.filter((v) => !v.completedAt).sort(byRecency);
  const completed  = videos.filter((v) =>  v.completedAt).sort(byRecency);

  // Home pill: show only when active /watch is NOT already in the list.
  const showHomePill =
    context.contextIsWatch &&
    context.contextVideoId &&
    !videos.some((v) => v.videoId === context.contextVideoId);
  els.homeVideoPill.classList.toggle('hidden', !showHomePill);
  if (showHomePill) {
    getTabTitle(context.activeTabId).then((t) => {
      els.homePillTitle.textContent = t || 'Estás viendo un video ahora';
    });
  }

  const total = videos.length;

  if (total === 0) {
    els.libraryList.innerHTML = '';
    els.emptyLibrary.classList.remove('hidden');
    return;
  }

  els.emptyLibrary.classList.add('hidden');
  els.libraryList.innerHTML = '';

  if (inProgress.length > 0) {
    const inProgressHeader = document.createElement('div');
    inProgressHeader.className = 'inprogress-section-header';
    inProgressHeader.innerHTML = `
      <span class="inprogress-section-label">En curso</span>
      <span class="inprogress-section-count">${inProgress.length}</span>
    `;
    els.libraryList.appendChild(inProgressHeader);
  }
  for (const video of inProgress) {
    els.libraryList.appendChild(buildLibraryItemEl(video));
  }

  if (completed.length > 0) {
    const { 'ui.completedCollapsed': savedCollapsed } = await chrome.storage.local.get('ui.completedCollapsed');
    let collapsed = savedCollapsed ?? true;

    const section = document.createElement('div');
    section.className = 'completed-section';

    const sectionHeader = document.createElement('button');
    sectionHeader.className = 'completed-section-header';
    sectionHeader.innerHTML = `
      <span class="completed-section-chevron${collapsed ? '' : ' open'}">▸</span>
      <span class="completed-section-label">Completados</span>
      <span class="completed-section-count">${completed.length}</span>
    `;

    const itemsWrapper = document.createElement('div');
    itemsWrapper.className = 'completed-section-items';
    if (collapsed) itemsWrapper.classList.add('hidden');
    for (const video of completed) {
      itemsWrapper.appendChild(buildLibraryItemEl(video));
    }

    sectionHeader.addEventListener('click', async () => {
      collapsed = !collapsed;
      await chrome.storage.local.set({ 'ui.completedCollapsed': collapsed });
      itemsWrapper.classList.toggle('hidden', collapsed);
      const chevron = sectionHeader.querySelector('.completed-section-chevron');
      if (chevron) chevron.classList.toggle('open', !collapsed);
    });

    section.appendChild(sectionHeader);
    section.appendChild(itemsWrapper);
    els.libraryList.appendChild(section);
  }
}

function buildLibraryItemEl(video) {
  const isCompleted = !!video.completedAt;
  const item = document.createElement('div');
  item.className = `library-item${isCompleted ? ' completed' : ''}`;
  item.setAttribute('role', 'listitem');
  item.setAttribute('tabindex', '0');
  item.setAttribute('title', `Abrir checklist: ${video.title}`);

  const stepCount = video.steps.length;
  const doneCount = video.steps.filter((s) => s.done).length;
  const pct = stepCount > 0 ? Math.round((doneCount / stepCount) * 100) : 0;

  const icon = document.createElement('div');
  icon.className = `library-item-icon${isCompleted ? ' completed' : ''}`;

  // Real YouTube thumbnail (recognizable, anti-generic). Falls back to a
  // play glyph if the image can't load.
  const thumb = document.createElement('img');
  thumb.className = 'library-item-thumb';
  thumb.src = `https://i.ytimg.com/vi/${video.videoId}/mqdefault.jpg`;
  thumb.alt = '';
  thumb.loading = 'lazy';
  thumb.addEventListener('error', () => {
    thumb.remove();
    icon.classList.add('fallback');
    const glyph = document.createElement('span');
    glyph.className = 'library-item-glyph';
    glyph.textContent = '▸';
    icon.prepend(glyph);
  });
  icon.appendChild(thumb);

  // Completed: check overlay over the dimmed thumbnail.
  if (isCompleted) {
    const check = document.createElement('div');
    check.className = 'library-item-thumb-check';
    check.innerHTML = `<svg width="13" height="13" viewBox="0 0 12 12" fill="none"><path d="M2 6L5 9L10 3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    icon.appendChild(check);
  }

  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'library-item-body';
  bodyWrap.innerHTML = `
    <div class="library-item-title">${escHtml(video.title)}</div>
    <div class="library-item-meta">${doneCount}/${stepCount} paso${stepCount !== 1 ? 's' : ''}</div>
    <div class="library-item-progress">
      <div class="library-item-progress-fill" style="width:${pct}%"></div>
    </div>
  `;

  // Secondary action: go to the video.
  const goBtn = document.createElement('button');
  goBtn.className = 'library-item-go';
  goBtn.title = 'Ir al video';
  goBtn.setAttribute('aria-label', 'Ir al video');
  goBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <path d="M5 3H11V9M11 3L3 11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  goBtn.addEventListener('click', (e) => { e.stopPropagation(); abrirVideo(video.videoId); });

  // Primary action: open the detail (checklist), pinned by the user.
  const openDetailFromList = () => openDetail(video.videoId, video.url, { pinned: true });
  item.addEventListener('click', openDetailFromList);
  item.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetailFromList(); }
  });

  item.appendChild(icon);
  item.appendChild(bodyWrap);
  item.appendChild(goBtn);
  return item;
}

// ── Video routing: abrirVideo ─────────────────────────────────

// Focus an existing /watch tab for videoId in the CURRENT window
// (seek without reload), or open a new tab. t is optional (seconds).
async function abrirVideo(videoId, t) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({
      url: ['*://www.youtube.com/watch*', '*://youtube.com/watch*'],
      currentWindow: true,
    });
  } catch {
    tabs = [];
  }
  const match = tabs.find((tab) => parseVideoId(tab.url) === videoId);

  if (match) {
    await chrome.tabs.update(match.id, { active: true });
    if (t != null) {
      // Seek in place — never navigate by URL (that would reload the video).
      sendToContent(match.id, { type: 'SEEK_VIDEO', time: t }).catch(() => {});
    }
    return;
  }

  let url = `https://www.youtube.com/watch?v=${videoId}`;
  if (t != null) url += `&t=${Math.floor(t)}s`;
  await chrome.tabs.create({ url });
}

// ── Step actions ──────────────────────────────────────────────

async function handleToggle(stepId) {
  if (!viewing.viewingVideoId) return;
  await toggleStep(viewing.viewingVideoId, stepId);
  const step = viewing.steps.find((s) => s.id === stepId);
  if (step) step.done = !step.done;
  // If un-checking clears completedAt, remove the badge.
  const rec = await getVideoRecord(viewing.viewingVideoId);
  if (!rec?.completedAt) clearCompletedBadge();
  renderDetail();
}

async function handleDelete(stepId) {
  if (!viewing.viewingVideoId) return;
  await deleteStep(viewing.viewingVideoId, stepId);
  viewing.steps = viewing.steps.filter((s) => s.id !== stepId);
  const rec = await getVideoRecord(viewing.viewingVideoId);
  if (!rec?.completedAt) clearCompletedBadge();
  renderDetail();
}

// Seek: live → move the player directly; browsing → open the video at t.
async function handleSeek(timestamp) {
  if (isLive()) {
    await sendToContent(context.activeTabId, { type: 'SEEK_VIDEO', time: timestamp });
  } else {
    await abrirVideo(viewing.viewingVideoId, timestamp);
  }
}

function startEdit(stepId) {
  viewing.editingStepId = stepId;
  renderDetail();
}

function cancelEdit() {
  viewing.editingStepId = null;
  renderDetail();
}

async function confirmEdit(stepId, newText) {
  if (!viewing.viewingVideoId) return;
  const trimmed = newText.trim();
  if (trimmed) {
    await editStepText(viewing.viewingVideoId, stepId, trimmed);
    const step = viewing.steps.find((s) => s.id === stepId);
    if (step) step.text = trimmed;
  }
  viewing.editingStepId = null;
  renderDetail();
}

// ── Title editing ─────────────────────────────────────────────

function startTitleEdit() {
  if (!viewing.viewingVideoId) return;
  els.headerTitleInput.value = viewing.title || '';
  els.headerTitleText.classList.add('hidden');
  els.headerTitleInput.classList.remove('hidden');
  setTimeout(() => { els.headerTitleInput.focus(); els.headerTitleInput.select(); }, 0);
}

async function confirmTitleEdit() {
  const trimmed = els.headerTitleInput.value.trim();
  els.headerTitleInput.classList.add('hidden');
  els.headerTitleText.classList.remove('hidden');
  if (trimmed && trimmed !== viewing.title && viewing.viewingVideoId) {
    viewing.title = trimmed;
    await renameVideo(viewing.viewingVideoId, trimmed);
  }
  renderHeader();
}

function cancelTitleEdit() {
  els.headerTitleInput.classList.add('hidden');
  els.headerTitleText.classList.remove('hidden');
  renderHeader();
}

els.headerTitleText.addEventListener('click', startTitleEdit);
els.headerTitleText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startTitleEdit(); }
});
els.headerTitleInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); confirmTitleEdit(); }
  if (e.key === 'Escape') { e.preventDefault(); cancelTitleEdit(); }
});
els.headerTitleInput.addEventListener('blur', confirmTitleEdit);

// ── Capture mode (only available when live) ───────────────────

async function enterCaptureMode() {
  if (!isLive() || isAdPlaying) return;

  const videoState = await getVideoState(context.activeTabId);

  // videoState can be null if the content script isn't reachable yet.
  // Fall back to safe defaults: timestamp 0, assume not playing.
  const currentTime = videoState?.currentTime ?? 0;
  const wasPlaying = videoState ? !videoState.paused : false;

  viewing.captureTimestamp = currentTime;
  viewing.captureWasPlaying = wasPlaying;
  viewing.captureMode = true;

  if (wasPlaying) {
    sendToContent(context.activeTabId, { type: 'PAUSE_VIDEO' });
  }

  els.btnAddStep.classList.add('hidden');
  els.captureMode.classList.remove('hidden');
  els.captureTimeDisplay.textContent = formatTime(currentTime);
  els.stepInput.value = '';

  setTimeout(() => els.stepInput.focus(), 50);
}

async function exitCaptureMode(restore) {
  viewing.captureMode = false;

  if (restore && viewing.captureWasPlaying && context.activeTabId) {
    sendToContent(context.activeTabId, { type: 'PLAY_VIDEO' });
  }

  viewing.captureWasPlaying = false;
  viewing.captureTimestamp = 0;

  els.captureMode.classList.add('hidden');
  els.btnAddStep.classList.remove('hidden');
  els.stepInput.value = '';
}

async function saveStep() {
  const text = els.stepInput.value.trim();

  if (!text || !viewing.viewingVideoId) {
    await exitCaptureMode(true);
    return;
  }

  let title = viewing.title;
  if (!title && context.activeTabId) {
    title = (await getTabTitle(context.activeTabId)) || viewing.viewingVideoId;
  }

  const step = await createStep(
    viewing.viewingVideoId,
    title,
    viewing.url,
    text,
    viewing.captureTimestamp
  );
  viewing.steps.push(step);
  if (!viewing.title) viewing.title = title;
  clearCompletedBadge(); // adding a step always clears completion

  await exitCaptureMode(true);
  renderDetail();
  renderHeader();
}

// ── Capture input handling ────────────────────────────────────

let blurTimeout = null;

els.stepInput.addEventListener('blur', () => {
  // Only auto-cancel an EMPTY draft on blur. If the user already typed
  // something (e.g. clicked back to the video to re-check the moment),
  // keep capture mode open so their text + frozen timestamp aren't lost.
  // Explicit exits (Escape, navigation) still cancel regardless.
  if (els.stepInput.value.trim()) return;
  blurTimeout = setTimeout(() => {
    if (viewing.captureMode) exitCaptureMode(true);
  }, 150);
});

els.stepInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(blurTimeout);
    saveStep();
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    clearTimeout(blurTimeout);
    exitCaptureMode(true);
  }
});

els.btnSaveStep.addEventListener('mousedown', (e) => { e.preventDefault(); });
els.btnSaveStep.addEventListener('click', () => { clearTimeout(blurTimeout); saveStep(); });
els.btnAddStep.addEventListener('click', enterCaptureMode);

// ── Header / pill actions ─────────────────────────────────────

els.btnBack.addEventListener('click', goHome);

els.activeVideoPill.addEventListener('click', () => {
  if (context.contextVideoId) openDetail(context.contextVideoId, context.contextUrl);
});

els.homeVideoPill.addEventListener('click', () => {
  if (context.contextVideoId) openDetail(context.contextVideoId, context.contextUrl);
});

els.btnMarkComplete.addEventListener('click', async () => {
  if (!viewing.viewingVideoId) return;
  await markCompleted(viewing.viewingVideoId);
  const record = await getVideoRecord(viewing.viewingVideoId);
  if (record) {
    viewing.steps = record.steps;
    showCompletedBadge(record.completedAt);
  }
  renderDetail();
});

// ── Context updates (reactive, never yank viewing) ────────────

function applyContext(tabState) {
  context.activeTabId = tabState?.tabId ?? null;
  context.contextVideoId = tabState?.videoId ?? null;
  context.contextIsWatch = tabState?.isWatch ?? false;
  context.contextUrl = tabState?.url ?? '';
}

// Decide what the panel shows after the active context changed.
// `wasLive` = were we live BEFORE applying the new context?
// `justNavigated` = the active tab changed URL (vs the user switching tabs).
function resolveViewAfterContext(wasLive, justNavigated = false) {
  // 1. Drop into the live detail when watching along (follow) or arriving from
  //    the library home (no checklist to protect → ready to annotate).
  if (shouldOpenLiveOnContext(wasLive)) {
    openDetail(context.contextVideoId, context.contextUrl, { pinned: false, justNavigated });
    return;
  }
  // 2. An auto-opened (unpinned) detail whose video is no longer active falls
  //    back to the library. A pinned checklist (opened on purpose) stays.
  if (viewing.view === 'detail' && !viewing.pinned && !isLive()) {
    if (viewing.captureMode) exitCaptureMode(true);
    viewing.view = 'library';
  }
  renderCurrent();
}

// Should a context change drop us into the live detail of the active video?
function shouldOpenLiveOnContext(wasLive) {
  return (
    context.contextIsWatch &&
    !!context.contextVideoId &&
    !viewing.captureMode &&
    (wasLive || viewing.view === 'library')
  );
}

// Same-tab navigation in the ACTIVE tab.
function onActiveTabNavigated(videoId, isWatch, url) {
  const wasLive = isLive();
  context.contextVideoId = videoId;
  context.contextIsWatch = isWatch;
  context.contextUrl = url || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : '');
  resolveViewAfterContext(wasLive, true); // same-tab navigation → title will lag
}

// Navigation events and ad state from the service worker.
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'AD_STATE_CHANGED') {
    if (message.tabId === context.activeTabId) {
      isAdPlaying = !!message.isAd;
      if (isLive()) renderDetail();
    }
    return;
  }
  if (message.type !== 'VIDEO_CHANGED') return;

  if (message.tabId === context.activeTabId) {
    onActiveTabNavigated(message.videoId, message.isWatch, message.url);
  }
  // Background-tab navigation doesn't change the active context — ignore.
});

// Tab switches (the active tab changed). Refresh context only — never
// touch what the user is viewing.
chrome.tabs.onActivated.addListener(async () => {
  const wasLive = isLive();
  try {
    const tabState = await getActiveTabState();
    applyContext(tabState);
  } catch {
    /* leave context as-is */
  }
  resolveViewAfterContext(wasLive);
});

// ── Init ──────────────────────────────────────────────────────

async function init() {
  let tabState;
  try {
    tabState = await getActiveTabState();
  } catch {
    tabState = { videoId: null, isWatch: false, tabId: null, url: '' };
  }

  applyContext(tabState);

  // Default view: live detail when on a /watch, otherwise the library home.
  if (context.contextIsWatch && context.contextVideoId) {
    await openDetail(context.contextVideoId, context.contextUrl);
  } else {
    viewing.view = 'library';
    renderCurrent();
  }
}

init();

import { initUIEventListeners } from "./ui-events.js";
import { fetchAndStoreThreads, refreshActiveView } from "./thread-manager.js";
import { CATEGORY_API_MAP } from "./config.js";
import { setCurrentCategory } from "./state.js";
import { showToast } from "./ui-render.js";

const RESUME_REFRESH_THROTTLE_MS = 15000;

let lifecycleListenersBound = false;
let appBootInProgress = false;
let appBootCompleted = false;
let lastResumeRefreshAt = 0;
let resumeRefreshPromise = null;

function applyInitialUrlState() {
  const params = new URLSearchParams(window.location.search);
  const categoryParam = params.get("category");
  const searchParam = params.get("search") || "";
  const filterParam = params.get("filter") || "";
  let selectedCategory = "hiring";
  let invalidCategory = false;

  if (categoryParam) {
    if (CATEGORY_API_MAP[categoryParam]) {
      selectedCategory = categoryParam;
    } else {
      invalidCategory = true;
    }
  }

  setCurrentCategory(selectedCategory);

  if (invalidCategory) {
    showToast(
      `Invalid category: '${categoryParam}'. Showing 'hiring' instead.`,
      4000
    );
  }

  window.__initialSearchParam = searchParam;
  window.__initialFilterParam = filterParam;
}

function bindLifecycleListeners() {
  if (lifecycleListenersBound) {
    return;
  }
  lifecycleListenersBound = true;

  window.addEventListener("pageshow", (event) => {
    if (!event.persisted && !appBootCompleted) {
      return;
    }

    scheduleResumeRefresh("pageshow");
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      scheduleResumeRefresh("visibilitychange");
    }
  });

  window.addEventListener("focus", () => {
    scheduleResumeRefresh("focus");
  });

  window.addEventListener("online", () => {
    scheduleResumeRefresh("online");
  });
}

async function scheduleResumeRefresh(source) {
  if (appBootInProgress) {
    return;
  }

  if (source !== "online" && document.visibilityState === "hidden") {
    return;
  }

  if (resumeRefreshPromise) {
    return resumeRefreshPromise;
  }

  const now = Date.now();
  if (
    source !== "online" &&
    now - lastResumeRefreshAt < RESUME_REFRESH_THROTTLE_MS
  ) {
    return;
  }

  lastResumeRefreshAt = now;
  resumeRefreshPromise = refreshActiveView()
    .catch((error) => {
      console.error(`Failed to refresh app after ${source}:`, error);
    })
    .finally(() => {
      resumeRefreshPromise = null;
    });

  return resumeRefreshPromise;
}

async function initializeApp() {
  applyInitialUrlState();
  initUIEventListeners();
  bindLifecycleListeners();

  appBootInProgress = true;

  try {
    await fetchAndStoreThreads();
  } finally {
    appBootInProgress = false;
    appBootCompleted = true;
    lastResumeRefreshAt = Date.now();
  }
}

initializeApp();

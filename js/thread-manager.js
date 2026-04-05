import { CATEGORY_API_MAP, CATEGORY_CACHE_KEY } from "./config.js";

import {
  allThreads,
  currentCategory,
  currentThreadId,
  setAllThreads,
  setCurrentThreadId,
  setAllComments,
  setSelectedYear,
  setInitialThreadsLoadingCompleted,
} from "./state.js";

import { getCache, setCache, minimizeCommentObject } from "./cache.js";

import {
  fetchLatestThreadListFromApi,
  fetchThreadComments,
  fetchNewerComments,
} from "./api.js";

import {
  clearLastRefreshedInfo,
  renderJobs,
  renderCategorySwitcher,
  renderThreadSwitcher,
  setLastRefreshedInfo,
  setLoadTimeInfo,
} from "./ui-render.js";

let activeThreadRequestToken = 0;
let activeCategoryRefreshPromise = null;
let activeInitialLoadPromise = null;

function isCurrentThreadRequest(threadId, requestToken) {
  return (
    String(threadId) === String(currentThreadId) &&
    requestToken === activeThreadRequestToken
  );
}

function getJobsContainer() {
  return document.getElementById("jobs");
}

function hasRenderableJobs() {
  return !!document.querySelector("#jobs .job-card");
}

function isJobsContainerInErrorState() {
  return /Failed to load/i.test(getJobsContainer()?.textContent || "");
}

function setThreadButtonsActive(threadId) {
  document
    .querySelectorAll(".year-selector button, .month-selector button")
    .forEach((btn) => {
      btn.classList.remove("active");

      if (btn.dataset.threadId === String(threadId)) {
        btn.classList.add("active");

        const yearBtn = document.querySelector(
          `.year-selector button[data-year="${btn.dataset.year}"]`
        );
        yearBtn?.classList.add("active");
      }
    });
}

function showBlockingThreadLoader() {
  getJobsContainer().innerHTML =
    '<div class="loading"><i class="fas fa-circle-notch"></i> Loading...</div>';
  setLoadTimeInfo("");
  clearLastRefreshedInfo();
}

function showNoThreadsMessage(message) {
  getJobsContainer().innerHTML = `<div class="loading"><i class="fas fa-info-circle"></i> ${message}</div>`;
  setLoadTimeInfo("");
  clearLastRefreshedInfo();
}

function getThreadCacheKey(threadId) {
  return `hn_thread_comments_${threadId}`;
}

function normalizeCategoryCache(cachedData) {
  if (!cachedData) {
    return null;
  }

  return cachedData.threads || cachedData;
}

function buildThreadsState(source = {}) {
  const nextThreads = {};

  for (const category in CATEGORY_API_MAP) {
    nextThreads[category] = Array.isArray(source[category])
      ? source[category]
      : [];
  }

  return nextThreads;
}

function getLatestThreadForCategory(category = currentCategory) {
  return allThreads[category]?.[0] || null;
}

function setSelectedYearForThread(thread) {
  if (!thread) {
    setSelectedYear(null);
    return;
  }

  const match = thread.title.match(/\b(\d{4})\b/);
  setSelectedYear(match ? parseInt(match[1], 10) : null);
}

function areThreadListsEqual(first = [], second = []) {
  return JSON.stringify(first) === JSON.stringify(second);
}

function hasKnownThreads() {
  return Object.values(allThreads).some(
    (threads) => Array.isArray(threads) && threads.length > 0
  );
}

async function fetchCategoryThreadLists() {
  const categories = Object.keys(CATEGORY_API_MAP);

  return Promise.all(
    categories.map(async (category) => {
      try {
        const hits = await fetchLatestThreadListFromApi(CATEGORY_API_MAP[category]);
        return { category, hits };
      } catch (error) {
        console.error(`Error fetching threads for category ${category}:`, error);
        return { category, hits: null };
      }
    })
  );
}

export async function loadThread(id, options = {}) {
  const { preserveVisibleContent = false } = options;
  const startTime = performance.now();
  const requestedIdForThisCall = id;
  const requestToken = ++activeThreadRequestToken;
  const isReloadingCurrentThread = String(currentThreadId) === String(id);
  const keepVisibleContent =
    preserveVisibleContent &&
    isReloadingCurrentThread &&
    hasRenderableJobs() &&
    !isJobsContainerInErrorState();

  setCurrentThreadId(id);
  setThreadButtonsActive(requestedIdForThisCall);

  if (!keepVisibleContent) {
    showBlockingThreadLoader();
  }

  const cacheKey = getThreadCacheKey(requestedIdForThisCall);

  try {
    const cachedData = getCache(cacheKey);
    let commentsForThisRequest = [];

    if (
      cachedData &&
      Array.isArray(cachedData.comments) &&
      cachedData.cachedAt
    ) {
      commentsForThisRequest = cachedData.comments;

      if (!isCurrentThreadRequest(requestedIdForThisCall, requestToken)) {
        return false;
      }

      setAllComments(commentsForThisRequest);
      if (!keepVisibleContent) {
        renderJobs(commentsForThisRequest);
      }
      setLastRefreshedInfo(cachedData.cachedAt);
      setLoadTimeInfo(
        `Displayed ${commentsForThisRequest.length} job posts. Checking for updates...`
      );

      const fetchedHits = await fetchNewerComments(
        requestedIdForThisCall,
        cachedData.cachedAt
      );

      if (!isCurrentThreadRequest(requestedIdForThisCall, requestToken)) {
        return false;
      }

      let newTopLevelComments = fetchedHits
        .filter(
          (comment) =>
            String(comment.parent_id) === String(requestedIdForThisCall)
        )
        .map((comment) => ({
          ...comment,
          id: comment.id || comment.objectID,
          text: comment.text || comment.comment_text,
        }));

      let uniqueNewComments = [];
      if (newTopLevelComments.length > 0) {
        const existingCommentIds = new Set(
          commentsForThisRequest.map((comment) => String(comment.id))
        );

        uniqueNewComments = newTopLevelComments.filter(
          (comment) =>
            comment.id && !existingCommentIds.has(String(comment.id))
        );

        commentsForThisRequest = [
          ...uniqueNewComments,
          ...commentsForThisRequest,
        ];
      }

      const refreshedAt = Date.now();
      setCache(cacheKey, {
        comments: commentsForThisRequest.map(minimizeCommentObject),
        cachedAt: refreshedAt,
      });

      setAllComments(commentsForThisRequest);
      if (uniqueNewComments.length > 0) {
        renderJobs(commentsForThisRequest);
      }

      const duration = ((performance.now() - startTime) / 1000).toFixed(2);
      setLastRefreshedInfo(refreshedAt);
      setLoadTimeInfo(
        `Loaded ${commentsForThisRequest.length} jobs (${uniqueNewComments.length} new jobs added) in ${duration} seconds`
      );

      return true;
    }

    commentsForThisRequest = await fetchThreadComments(requestedIdForThisCall);

    if (!isCurrentThreadRequest(requestedIdForThisCall, requestToken)) {
      return false;
    }

    const refreshedAt = Date.now();
    setCache(cacheKey, {
      comments: commentsForThisRequest.map(minimizeCommentObject),
      cachedAt: refreshedAt,
    });

    setAllComments(commentsForThisRequest);
    renderJobs(commentsForThisRequest);

    const duration = ((performance.now() - startTime) / 1000).toFixed(2);
    setLastRefreshedInfo(refreshedAt);
    setLoadTimeInfo(
      `Loaded ${commentsForThisRequest.length} jobs in ${duration} seconds`
    );

    return true;
  } catch (error) {
    if (!isCurrentThreadRequest(requestedIdForThisCall, requestToken)) {
      return false;
    }

    if (keepVisibleContent && hasRenderableJobs()) {
      setLoadTimeInfo("Failed to refresh jobs");
      return false;
    }

    getJobsContainer().innerHTML = `
          <div class="loading">
            <i class="fas fa-exclamation-circle"></i>
            Failed to load thread details for ${requestedIdForThisCall}. ${
      error.message || ""
    }
          </div>`;
    setLoadTimeInfo("Failed to load jobs");
    clearLastRefreshedInfo();

    return false;
  }
}

async function fetchAllCategoryThreads() {
  const results = await fetchCategoryThreadLists();
  const nextThreads = buildThreadsState();

  for (const result of results) {
    nextThreads[result.category] = result.hits || [];
  }

  setAllThreads(nextThreads);
  setCache(CATEGORY_CACHE_KEY, nextThreads);

  return nextThreads;
}

async function fetchLatestCategoryThreadsInBackground({
  allowThreadPromotion = false,
} = {}) {
  if (activeCategoryRefreshPromise) {
    return activeCategoryRefreshPromise;
  }

  activeCategoryRefreshPromise = (async () => {
    const cachedThreadsSnapshot = buildThreadsState(allThreads);
    const previousLatestThreadId =
      cachedThreadsSnapshot[currentCategory]?.[0]?.objectID || null;
    const results = await fetchCategoryThreadLists();
    const nextThreads = buildThreadsState(cachedThreadsSnapshot);
    let updated = false;

    for (const result of results) {
      if (
        Array.isArray(result.hits) &&
        !areThreadListsEqual(result.hits, cachedThreadsSnapshot[result.category])
      ) {
        nextThreads[result.category] = result.hits;
        updated = true;
      }
    }

    if (updated) {
      setAllThreads(nextThreads);
      setCache(CATEGORY_CACHE_KEY, nextThreads);
      renderCategorySwitcher();
    }

    const latestThreadAfterRefresh = nextThreads[currentCategory]?.[0] || null;
    const shouldPromoteLatestThread =
      allowThreadPromotion &&
      latestThreadAfterRefresh &&
      String(latestThreadAfterRefresh.objectID) !==
        String(previousLatestThreadId) &&
      (!currentThreadId ||
        String(currentThreadId) === String(previousLatestThreadId));

    if (updated) {
      if (
        shouldPromoteLatestThread ||
        !nextThreads[currentCategory]?.some(
          (thread) => String(thread.objectID) === String(currentThreadId)
        )
      ) {
        setSelectedYearForThread(latestThreadAfterRefresh);
      }

      renderThreadSwitcher();
    }

    if (shouldPromoteLatestThread) {
      await loadThread(latestThreadAfterRefresh.objectID);
      return {
        updated,
        promotedThreadId: latestThreadAfterRefresh.objectID,
      };
    }

    return { updated, promotedThreadId: null };
  })().finally(() => {
    activeCategoryRefreshPromise = null;
  });

  return activeCategoryRefreshPromise;
}

export async function fetchAndStoreThreads() {
  if (activeInitialLoadPromise) {
    return activeInitialLoadPromise;
  }

  activeInitialLoadPromise = (async () => {
    const cachedData = normalizeCategoryCache(getCache(CATEGORY_CACHE_KEY));

    if (cachedData) {
      setAllThreads(buildThreadsState(cachedData));
      renderCategorySwitcher();

      const latestThread = getLatestThreadForCategory(currentCategory);
      if (latestThread) {
        setSelectedYearForThread(latestThread);
        renderThreadSwitcher();
        await loadThread(latestThread.objectID);
      } else {
        showNoThreadsMessage(
          `No threads found in cache for "${CATEGORY_API_MAP[currentCategory].label}". Checking for new ones...`
        );
      }

      setInitialThreadsLoadingCompleted(true);
      fetchLatestCategoryThreadsInBackground({ allowThreadPromotion: true });
      return;
    }

    showBlockingThreadLoader();
    await fetchAllCategoryThreads();
    renderCategorySwitcher();

    const latestThread = getLatestThreadForCategory(currentCategory);
    if (latestThread) {
      setSelectedYearForThread(latestThread);
      renderThreadSwitcher();
      await loadThread(latestThread.objectID);
    } else {
      showNoThreadsMessage(
        `No threads found for "${CATEGORY_API_MAP[currentCategory].label}".`
      );
    }

    setInitialThreadsLoadingCompleted(true);
  })().finally(() => {
    activeInitialLoadPromise = null;
  });

  return activeInitialLoadPromise;
}

export async function refreshActiveView() {
  if (!hasKnownThreads()) {
    await fetchAndStoreThreads();
    return;
  }

  const { promotedThreadId } = await fetchLatestCategoryThreadsInBackground({
    allowThreadPromotion: true,
  });

  if (promotedThreadId) {
    return;
  }

  const fallbackThreadId =
    currentThreadId || getLatestThreadForCategory(currentCategory)?.objectID;

  if (!fallbackThreadId) {
    showNoThreadsMessage(
      `No threads found for "${CATEGORY_API_MAP[currentCategory].label}".`
    );
    return;
  }

  await loadThread(fallbackThreadId, { preserveVisibleContent: true });
}

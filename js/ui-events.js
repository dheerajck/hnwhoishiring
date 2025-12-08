import {
  appliedKey,
  notesKey,
  favoriteKey,
  themekey,
  hiddenKey,
  searchDebounceTimeout,
  CATEGORY_CACHE_KEY,
  CATEGORY_API_MAP,
} from "./config.js";

import {
  applied,
  notes,
  allComments,
  currentThreadId,
  favorites,
  hidden,
  activeToastHideTimerId,
  currentCategory,
  setApplied,
  setNotes,
  setFavorites,
  setHidden,
  setActiveToastHideTimerId,
} from "./state.js";

import { removeLocalStorageKeysWithPrefix } from "./cache.js";
import { debounce } from "./utils.js";

import {
  renderJobs,
  updateJobCardInPlace,
  showToast,
  updateThemeIcon,
  renderParsedQuery,
  removeJobCardInPlace,
} from "./ui-render.js";

import { parseQuery } from "./search-logic.js";

// DOM Elements Cache
let domElements = {};

function cacheDOMElements() {
  domElements = {
    searchInput: document.getElementById("search"),
    clearSearchBtn: document.getElementById("clearSearchBtn"),
    controlButtonsContainer: document.querySelector(".control-buttons"),
    jobsContainer: document.getElementById("jobs"),
    themeToggle: document.getElementById("themeToggle"),
    goToTopButton: document.getElementById("goToTop"),
    helpModal: document.getElementById("helpModal"),
    openHelpModalBtn: document.getElementById("openHelpModal"),
    closeHelpModalBtn: document.getElementById("closeHelpModal"),
    toastElement: document.getElementById("toast"),
  };
}

// Search functionality
const debouncedRenderJobs = debounce(() => {
  if (typeof allComments !== "undefined") {
    renderJobs(allComments);
    // Update the URL/search param only when the debounced search actually runs
    updateSearchURLParams();
  }
}, searchDebounceTimeout);

function setupClearSearchButton() {
  const { searchInput, clearSearchBtn } = domElements;
  if (!searchInput || !clearSearchBtn) return;

  const toggleVisibility = () => {
    clearSearchBtn.classList.toggle("hidden", searchInput.value.length === 0);
  };

  searchInput.addEventListener("input", toggleVisibility);
  clearSearchBtn.addEventListener("click", () => {
    searchInput.value = "";
    searchInput.dispatchEvent(
      new Event("input", { bubbles: true, cancelable: true })
    );
  });

  toggleVisibility();
}

function updateSearchURLParams() {
  const { searchInput } = domElements;
  const params = new URLSearchParams(window.location.search);

  if (searchInput.value) {
    params.set("search", searchInput.value);
  } else {
    params.delete("search");
  }

  window.history.replaceState(
    {},
    "",
    `${window.location.pathname}?${params.toString()}`
  );
}

function setupSearchInput() {
  const { searchInput } = domElements;
  if (!searchInput) return;

  searchInput.addEventListener("input", () => {
    debouncedRenderJobs();
  });
}

function setupOperatorButtons() {
  const { searchInput } = domElements;

  document.querySelectorAll(".op-btn").forEach((button) => {
    button.addEventListener("click", (e) => {
      e.preventDefault();
      if (!searchInput) return;

      const operator = button.dataset.op;
      const currentPos = searchInput.selectionStart;
      const currentValue = searchInput.value;

      searchInput.value =
        currentValue.substring(0, currentPos) +
        operator +
        currentValue.substring(currentPos);

      searchInput.focus();
      searchInput.setSelectionRange(
        currentPos + operator.length,
        currentPos + operator.length
      );
      debouncedRenderJobs();
    });
  });
}

function setupExampleSearch() {
  const { searchInput, clearSearchBtn } = domElements;
  const tryExampleLink = document.getElementById("try-example-search");

  if (!tryExampleLink || !searchInput) return;

  tryExampleLink.addEventListener("click", (event) => {
    event.preventDefault();
    const exampleQuery = CATEGORY_API_MAP[currentCategory]?.example_query || "";
    searchInput.value = exampleQuery;

    if (clearSearchBtn) {
      clearSearchBtn.classList.toggle("hidden", exampleQuery.length === 0);
    }

    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

// Keyboard navigation
const keyboardShortcuts = {
  j: () => navigateJobs("next"),
  k: () => navigateJobs("prev"),
  "/": () => domElements.searchInput?.focus(),
  Escape: () => document.activeElement?.blur(),
  a: () => toggleFavoriteJob(),
  e: () => toggleExcludeJob(),
  g: () => window.scrollTo({ top: 0, behavior: "smooth" }),
};

function navigateJobs(direction) {
  const jobCards = document.querySelectorAll(".job-card");
  if (!jobCards.length) return;

  const focused = document.activeElement;
  let currentIndex = Array.from(jobCards).findIndex(
    (card) => card === focused || card.contains(focused)
  );

  const nextIndex =
    direction === "next"
      ? (currentIndex + 1) % jobCards.length
      : (currentIndex - 1 + jobCards.length) % jobCards.length;

  const nextCard = jobCards[nextIndex];
  if (nextCard) {
    nextCard.focus();
    nextCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function toggleFavoriteJob() {
  const focused = document.activeElement;
  const jobCard = focused?.closest(".job-card");
  const favoriteButton = jobCard?.querySelector(".star-btn");

  if (favoriteButton) {
    favoriteButton.click();
  } else {
    console.warn("No favorite button found on the focused job card.");
  }
}

function toggleExcludeJob() {
  const focused = document.activeElement;
  const jobCard = focused?.closest(".job-card");
  const removeUnHideButton = jobCard?.querySelector(".btn-remove, .btn-unhide");

  if (removeUnHideButton) {
    removeUnHideButton.click();
  } else {
    console.warn("No remove/unhide button found on the focused job card.");
  }
}

function setupGlobalKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") {
      if (e.key === "Escape") e.target.blur();
      return;
    }

    const shortcut = keyboardShortcuts[e.key];
    if (shortcut) {
      e.preventDefault();
      shortcut();
    }
  });
}

// Filter management
const HIGHLIGHT_CLASS = "active";
const FILTER_MAP = {
  showFavorites: "favorites",
  showNotes: "notes",
  showApplied: "applied",
  hideApplied: "hide-applied",
  showHidden: "hidden",
};

let filterButtons = [];

function createFilterButton(id, iconClass, text, className = "filter-btn") {
  const button = document.createElement("button");
  button.id = id;
  button.className = className;
  button.innerHTML = `<i class="${iconClass}"></i> ${text}`;
  return button;
}

function updateFilterURL(buttonId) {
  const filterKey = FILTER_MAP[buttonId];
  const params = new URLSearchParams(window.location.search);

  if (filterKey) {
    params.set("filter", filterKey);
  } else {
    params.delete("filter");
  }

  window.history.replaceState(
    {},
    "",
    `${window.location.pathname}?${params.toString()}`
  );
}

function clearFilterURL() {
  const params = new URLSearchParams(window.location.search);
  params.delete("filter");
  window.history.replaceState(
    {},
    "",
    `${window.location.pathname}?${params.toString()}`
  );
}

function setActiveFilter(btnToActivate) {
  const isActive = btnToActivate.classList.contains(HIGHLIGHT_CLASS);

  filterButtons.forEach((btn) => btn.classList.remove(HIGHLIGHT_CLASS));

  if (!isActive) {
    btnToActivate.classList.add(HIGHLIGHT_CLASS);
    updateFilterURL(btnToActivate.id);
  } else {
    clearFilterURL();
  }

  renderJobs(allComments);
}

function resetAllData() {
  const confirmed = window.confirm(
    "Are you sure you want to clear all applied statuses, notes, favorites, hidden jobs, AND caches? This cannot be undone."
  );

  if (!confirmed) return;

  // Clear state
  setApplied({});
  setFavorites({});
  setNotes({});
  setHidden({});

  // Clear localStorage
  const keysToRemove = [appliedKey, favoriteKey, notesKey, hiddenKey, themekey];
  keysToRemove.forEach((key) => localStorage.removeItem(key));

  try {
    removeLocalStorageKeysWithPrefix([
      "hn_thread_comments_",
      CATEGORY_CACHE_KEY,
    ]);
  } catch (e) {
    console.error("Error clearing caches from localStorage", e);
  }

  filterButtons.forEach((btn) => btn.classList.remove(HIGHLIGHT_CLASS));
  showToast("All data cleared. Reloading...");
  window.location.reload();
}

function setupFilterButtons() {
  const { controlButtonsContainer } = domElements;
  if (!controlButtonsContainer) return;

  controlButtonsContainer.classList.add("filter-row");

  // Create filter buttons
  const favBtn = createFilterButton(
    "showFavorites",
    "fas fa-star",
    "Favorites"
  );
  const notesBtn = createFilterButton(
    "showNotes",
    "fas fa-sticky-note",
    "Show Notes"
  );
  const appliedBtn = createFilterButton(
    "showApplied",
    "fas fa-check",
    "Show Applied"
  );
  const hideAppliedBtn = createFilterButton(
    "hideApplied",
    "fas fa-eye-slash",
    "Hide Applied"
  );
  const showHiddenBtn = createFilterButton(
    "showHidden",
    "fas fa-xmark",
    "Show Excluded"
  );
  const resetBtn = createFilterButton(
    "resetDefaultsBtn",
    "fas fa-trash-alt",
    "Reset Everything",
    "filter-btn reset-btn"
  );

  resetBtn.title = "Clear all applied statuses, notes, and favorites";

  filterButtons = [favBtn, notesBtn, appliedBtn, hideAppliedBtn, showHiddenBtn];

  // Add event listeners
  filterButtons.forEach((btn) => {
    btn.onclick = () => setActiveFilter(btn);
  });
  resetBtn.onclick = resetAllData;

  // Append to container
  [
    favBtn,
    notesBtn,
    appliedBtn,
    hideAppliedBtn,
    showHiddenBtn,
    resetBtn,
  ].forEach((btn) => controlButtonsContainer.appendChild(btn));
}

// Job card interactions
function getStateForThread(stateObj) {
  if (!stateObj[currentThreadId]) {
    stateObj[currentThreadId] = {};
  }
  return stateObj[currentThreadId];
}

function shouldRerenderJobs() {
  const activeFilters = [
    "showFavorites",
    "showNotes",
    "showApplied",
    "hideApplied",
    "showHidden",
  ];
  return activeFilters.some((id) =>
    document.getElementById(id)?.classList.contains(HIGHLIGHT_CLASS)
  );
}

const jobCardActions = {
  star: handleStarAction,
  "copy-link": handleCopyLinkAction,
  "save-note": handleSaveNoteAction,
  apply: handleApplyAction,
  unapply: handleUnapplyAction,
  remove: handleRemoveAction,
  unhide: handleUnhideAction,
};

function handleStarAction(jobId, actionTarget) {
  const currentFavoritesState = { ...favorites };
  const threadFavorites = getStateForThread(currentFavoritesState);

  const wasFavorite = !!threadFavorites[jobId];
  if (wasFavorite) {
    delete threadFavorites[jobId];
    actionTarget.classList.add("inactive");
  } else {
    threadFavorites[jobId] = true;
    actionTarget.classList.remove("inactive");
  }

  setFavorites(currentFavoritesState);
  localStorage.setItem(favoriteKey, JSON.stringify(favorites));

  // If "Favorites" filter is active and we removed favorite, remove card from DOM
  const showFavoritesActive = document
    .getElementById("showFavorites")
    ?.classList.contains(HIGHLIGHT_CLASS);
  if (showFavoritesActive && wasFavorite) {
    removeJobCardInPlace(jobId);
  }

  if (!wasFavorite) {
    showToast("Added to favorites!");
  } else {
    showToast("Removed from favorites!");
  }
}

function handleCopyLinkAction(jobId) {
  const url = `https://news.ycombinator.com/item?id=${jobId}`;
  navigator.clipboard
    .writeText(url)
    .then(() => showToast("Link copied!"))
    .catch(() => showToast("Failed to copy link."));
}

function handleSaveNoteAction(jobId, actionTarget, jobCard) {
  const noteEl = jobCard.querySelector(".note");
  const noteText = noteEl?.value.trim() || "";

  const currentNotesState = { ...notes };
  const threadNotes = getStateForThread(currentNotesState);
  const hadNote = !!threadNotes[jobId];

  if (noteText) {
    threadNotes[jobId] = noteText;
  } else {
    delete threadNotes[jobId];
  }

  setNotes(currentNotesState);
  localStorage.setItem(notesKey, JSON.stringify(notes));

  const showNotesActive = document
    .getElementById("showNotes")
    ?.classList.contains(HIGHLIGHT_CLASS);
  if (showNotesActive && !noteText && hadNote) {
    removeJobCardInPlace(jobId);
    showToast("Note removed!");
  } else if (!noteText && hadNote) {
    showToast("Note removed!");
  } else if (!noteText && !hadNote) {
    showToast("What are you doing!");
  } else if (noteText) {
    showToast("Note saved!");
  }
}

function handleApplyAction(jobId) {
  const currentAppliedState = { ...applied };
  const threadApplied = getStateForThread(currentAppliedState);

  threadApplied[jobId] = new Date().toISOString();
  setApplied(currentAppliedState);
  localStorage.setItem(appliedKey, JSON.stringify(applied));
  showToast("Marked as applied!");

  // If "Hide Applied" filter is active, remove card from DOM, else update in place
  const hideAppliedActive = document
    .getElementById("hideApplied")
    ?.classList.contains(HIGHLIGHT_CLASS);
  if (hideAppliedActive) {
    removeJobCardInPlace(jobId);
  } else {
    updateJobCardInPlace(jobId, applied[currentThreadId][jobId]);
  }
}

function handleUnapplyAction(jobId) {
  const currentAppliedState = { ...applied };
  const threadApplied = getStateForThread(currentAppliedState);

  if (threadApplied[jobId]) {
    delete threadApplied[jobId];
    setApplied(currentAppliedState);
    localStorage.setItem(appliedKey, JSON.stringify(applied));
    showToast("Removed applied status!");
    // If "Show Applied" filter is active, remove card from DOM, else update in place
    const showAppliedActive = document
      .getElementById("showApplied")
      ?.classList.contains(HIGHLIGHT_CLASS);
    if (showAppliedActive) {
      removeJobCardInPlace(jobId);
    } else {
      updateJobCardInPlace(jobId, false);
    }
  }
}

function handleRemoveAction(jobId) {
  const currentHiddenState = { ...hidden };
  const threadHidden = getStateForThread(currentHiddenState);

  threadHidden[jobId] = true;
  setHidden(currentHiddenState);
  localStorage.setItem(hiddenKey, JSON.stringify(hidden));
  showToast("Excluded!");

  // Never re-render, always remove in place
  removeJobCardInPlace(jobId);
}

function handleUnhideAction(jobId) {
  const currentHiddenState = { ...hidden };
  const threadHidden = getStateForThread(currentHiddenState);

  if (threadHidden[jobId]) {
    delete threadHidden[jobId];
    setHidden(currentHiddenState);
    localStorage.setItem(hiddenKey, JSON.stringify(hidden));
    showToast("Restored!");
    removeJobCardInPlace(jobId); // Remove from excluded list in place
  }
}

function handleJobCardClick(event) {
  const target = event.target;
  const jobCard = target.closest(".job-card");
  const actionTarget = target.closest("[data-action]");

  if (!jobCard || !actionTarget) return;

  const jobId = jobCard.dataset.jobId;
  const action = actionTarget.dataset.action;

  if (!jobId || !jobCardActions[action]) return;

  jobCardActions[action](jobId, actionTarget, jobCard);
}

function setupJobCardClickListener() {
  const { jobsContainer } = domElements;
  if (jobsContainer) {
    jobsContainer.addEventListener("click", handleJobCardClick);
  }
}

// Theme management
function toggleTheme() {
  document.body.classList.toggle("dark");
  updateThemeIcon();

  if (document.body.classList.contains("dark")) {
    localStorage.removeItem(themekey);
    showToast("Dark mode enabled!");
  } else {
    localStorage.setItem(themekey, "disabled");
    showToast("Light mode enabled!");
  }
}

function setupTheme() {
  // Apply initial theme
  if (localStorage.getItem(themekey) === "disabled") {
    document.body.classList.remove("dark");
  } else {
    document.body.classList.add("dark");
  }

  updateThemeIcon();

  const { themeToggle } = domElements;
  if (themeToggle) {
    themeToggle.addEventListener("click", toggleTheme);
  }
}

// Toast and scroll utilities
function setupToastScrollListener() {
  const { toastElement } = domElements;

  window.addEventListener("scroll", () => {
    if (toastElement?.classList.contains("show")) {
      toastElement.classList.remove("show");
      if (activeToastHideTimerId) {
        clearTimeout(activeToastHideTimerId);
        setActiveToastHideTimerId(null);
      }
    }
  });
}

function setupGoToTopButton() {
  const { goToTopButton, toastElement } = domElements;
  if (!goToTopButton) return;

  window.addEventListener("scroll", () => {
    const shouldShow =
      window.pageYOffset > 300 &&
      (!toastElement || !toastElement.classList.contains("show"));

    goToTopButton.classList.toggle("visible", shouldShow);
  });

  goToTopButton.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

// Help modal
function setupHelpModal() {
  const { helpModal, openHelpModalBtn, closeHelpModalBtn } = domElements;
  if (!helpModal || !openHelpModalBtn || !closeHelpModalBtn) return;

  openHelpModalBtn.onclick = () => helpModal.classList.add("visible");
  closeHelpModalBtn.onclick = () => helpModal.classList.remove("visible");

  window.addEventListener("click", (e) => {
    if (e.target === helpModal) helpModal.classList.remove("visible");
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && helpModal.classList.contains("visible")) {
      helpModal.classList.remove("visible");
    }
  });
}

// URL parameter handling
function applyInitialSearchParam() {
  const { searchInput, clearSearchBtn } = domElements;

  if (typeof window.__initialSearchParam === "string" && searchInput) {
    searchInput.value = window.__initialSearchParam;
    clearSearchBtn?.classList.toggle("hidden", searchInput.value.length === 0);
  }
}

function applyInitialFilterParam() {
  if (
    typeof window.__initialFilterParam !== "string" ||
    !window.__initialFilterParam
  ) {
    return;
  }

  const filterParamMap = {
    favorites: "showFavorites",
    notes: "showNotes",
    applied: "showApplied",
    "hide-applied": "hideApplied",
    hidden: "showHidden",
  };

  const btnId = filterParamMap[window.__initialFilterParam.toLowerCase()];
  if (!btnId) return;

  const btn = document.getElementById(btnId);
  if (btn) {
    btn.click();
  } else {
    setTimeout(() => {
      const delayedBtn = document.getElementById(btnId);
      delayedBtn?.click();
    }, 100);
  }
}

function updateParsedQuery() {
  const { searchInput } = domElements;
  const queryTokens = searchInput?.value ? parseQuery(searchInput.value) : [];
  renderParsedQuery(queryTokens);
}

function applyInitialURLParams() {
  applyInitialSearchParam();
  applyInitialFilterParam();
  updateParsedQuery();
}

// Main initialization
export function initUIEventListeners() {
  cacheDOMElements();
  setupClearSearchButton();
  setupSearchInput();
  setupOperatorButtons();
  setupExampleSearch();
  setupGlobalKeyboardShortcuts();
  setupFilterButtons();
  setupJobCardClickListener();
  setupTheme();
  setupToastScrollListener();
  setupGoToTopButton();
  setupHelpModal();
  applyInitialURLParams();
}

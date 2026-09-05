import { CATEGORY_API_MAP, MONTH_NAMES, toastTimeout } from "./config.js";

import {
  allComments,
  allThreads,
  currentCategory,
  currentThreadId,
  favorites,
  notes,
  applied,
  hidden,
  activeToastHideTimerId,
  selectedYear,
  setSelectedYear,
  setCurrentCategory,
  setActiveToastHideTimerId,
} from "./state.js";

import {
  parseQuery,
  compileQuery,
  buildWordMatchPattern,
  escapeRegex,
} from "./search-logic.js";
import { getYearAndMonthFromTitle } from "./utils.js";
import { loadThread } from "./thread-manager.js";
import DOMPurify from "./vendor/purify.js";
import { icon } from "./icons.js";

export const highlightClass = "active";

// One DOMParser pass per job post, done once per thread load:
// - sanitizes with DOMPurify
// - adds target="_blank" rel="noopener noreferrer" to every link
// - derives the lowercase plain text used for searching (block boundaries become
//   newlines so a whole-word match cannot bleed across paragraphs)
function prepareCommentHtml(rawHtml) {
  const clean = DOMPurify.sanitize(rawHtml || "[No comment text]");
  const doc = new DOMParser().parseFromString(`<div>${clean}</div>`, "text/html");
  const root = doc.body.firstChild;

  root.querySelectorAll("a").forEach((link) => {
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  });
  const html = root.innerHTML;

  root.querySelectorAll("p, br, li, pre, div, blockquote").forEach((el) => {
    el.parentNode.insertBefore(doc.createTextNode("\n"), el);
  });
  const searchText = root.textContent.toLowerCase();

  return { html, searchText };
}

// Highlights search terms in visible text only, preserving HTML structure
// - Uses DOMParser to parse the HTML string into a DOM tree
// - Walks the tree, applying regex-based highlighting only to text nodes
// - Leaves HTML tags and attributes untouched, so links and markup are never broken
function highlightSearchTerms(text, queryTokens) {
  if (!queryTokens || queryTokens.length === 0) {
    return text;
  }

  // Extract actual search terms, ignoring operators and modifiers for highlighting
  // Build an array of objects: { term, isExactMatch }
  const termsToHighlight = queryTokens
    .filter((token) => {
      // Ignore operators and tokens starting with ~
      return !["|", "&"].includes(token) && !token.startsWith("~");
    })
    .map((token) => {
      let isExactMatch = false;
      let term = token;
      if (term.startsWith('"') && term.endsWith('"')) {
        isExactMatch = true;
        term = term.substring(1, term.length - 1);
      }
      return { term: term.toLowerCase(), isExactMatch };
    })
    .filter((obj) => obj.term.length > 0);

  if (termsToHighlight.length === 0) {
    return text;
  }

  // Parse the HTML string into a DOM tree
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${text}</div>`, "text/html");
  const root = doc.body.firstChild;

  // Recursively walk the DOM tree, highlighting matches in text nodes only
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      let replaced = node.nodeValue;
      if (replaced.trim() !== "") {
        // Build regex for each term: exact match = substring, else = whole word
        const regexParts = termsToHighlight.map(({ term, isExactMatch }) => {
          return isExactMatch ? escapeRegex(term) : buildWordMatchPattern(term);
        });
        if (regexParts.length === 0) return;
        const regex = new RegExp(`(${regexParts.join("|")})`, "gi");

        // Replace matches with <span class=\"search-match\">
        replaced = replaced.replace(
          regex,
          (match) => `<span class=\"search-match\">${match}</span>`
        );
        // If any replacements, update the DOM
        if (replaced !== node.nodeValue) {
          const frag = doc.createElement("span");
          frag.innerHTML = replaced;
          while (frag.firstChild) {
            node.parentNode.insertBefore(frag.firstChild, node);
          }
          node.parentNode.removeChild(node);
        }
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      // Don't highlight inside script/style tags
      if (["SCRIPT", "STYLE"].includes(node.tagName)) return;
      for (let i = node.childNodes.length - 1; i >= 0; i--) {
        walk(node.childNodes[i]);
      }
    }
  }
  walk(root);
  // Return the updated HTML string
  return root.innerHTML;
}

export function showToast(message, duration = toastTimeout) {
  const toast = document.getElementById("toast");
  const goToTopButton = document.getElementById("goToTop");
  if (!toast) {
    console.error("Toast element not found!");
    return;
  }
  toast.textContent = message;
  void toast.offsetHeight; // Force Reflow
  toast.classList.add("show");

  if (goToTopButton) goToTopButton.classList.remove("visible");
  if (activeToastHideTimerId) clearTimeout(activeToastHideTimerId);

  const newTimerId = setTimeout(() => {
    toast.classList.remove("show");
    if (goToTopButton && window.pageYOffset > 300) {
      goToTopButton.classList.add("visible");
    }
  }, duration);
  setActiveToastHideTimerId(newTimerId);
}

function formatRelativeRefreshTime(timestampMs) {
  const diffMs = Date.now() - timestampMs;

  if (diffMs < 60 * 1000) {
    return "just now";
  }

  const diffMinutes = Math.floor(diffMs / (60 * 1000));
  if (diffMinutes < 60) {
    return `${diffMinutes} min ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} hr${diffHours === 1 ? "" : "s"} ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
}

export function setLoadTimeInfo(message = "") {
  const el = document.getElementById("load-time-info");
  if (!el) return;
  el.textContent = message;
}

export function setLastRefreshedInfo(timestampMs) {
  const el = document.getElementById("last-refreshed-info");
  if (!el) return;

  if (!timestampMs) {
    el.textContent = "";
    return;
  }

  const formattedTime = new Date(timestampMs).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  el.textContent = `Last refreshed: ${formattedTime} (${formatRelativeRefreshTime(
    timestampMs
  )})`;
}

export function clearLastRefreshedInfo() {
  setLastRefreshedInfo(null);
}

export function updateJobCardInPlace(jobId, appliedStatus) {
  const jobCard = document.querySelector(`.job-card[data-job-id="${jobId}"]`);
  if (!jobCard) return;

  if (appliedStatus) {
    jobCard.classList.add("applied");
  } else {
    jobCard.classList.remove("applied");
  }

  const statusDiv = jobCard.querySelector(".job-header-status");
  if (statusDiv) {
    if (appliedStatus) {
      statusDiv.innerHTML = `
                <span class="badge badge-applied">Applied</span>
                <div class="meta">
                    ${icon("calendar")} ${new Date(
                      appliedStatus
                    ).toLocaleString("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                      hour12: true,
                    })}
                </div>`;
    } else {
      statusDiv.innerHTML = "";
    }
  }

  const headerTop = jobCard.querySelector(".job-header-top");
  if (headerTop) {
    headerTop.classList.toggle("with-margin-bottom", !!appliedStatus);
  }

  const actionsDiv = jobCard.querySelector(".job-actions");
  if (actionsDiv) {
    actionsDiv
      .querySelectorAll(".btn-apply, .btn-unapply")
      .forEach((btn) => btn.remove());
    if (appliedStatus) {
      const unapplyBtn = document.createElement("button");
      unapplyBtn.className = "btn-unapply";
      unapplyBtn.setAttribute("data-action", "unapply");
      unapplyBtn.innerHTML =
        `${icon("xmark")} Remove Applied Status`;
      actionsDiv.appendChild(unapplyBtn);
    } else {
      const applyBtn = document.createElement("button");
      applyBtn.className = "job-action-button btn-apply";
      applyBtn.setAttribute("data-action", "apply");
      applyBtn.innerHTML =
        `${icon("check")} Mark as Applied`;
      actionsDiv.appendChild(applyBtn);
    }
  }
}

// A card whose state changed so that it no longer belongs in the current view (e.g. it
// was excluded, or un-favorited while the Favorites filter is on). Cards are cached, so
// instead of removing the node we re-apply the view and move focus to the next visible card.
export function removeJobCardInPlace(jobId) {
  const jobCard = document.querySelector(`.job-card[data-job-id="${jobId}"]`);
  if (!jobCard) return;

  const visible = Array.from(
    document.querySelectorAll("#jobs .job-card:not([hidden])")
  );
  const index = visible.indexOf(jobCard);

  renderJobs(allComments);

  if (jobCard.hidden) {
    const stillVisible = Array.from(
      document.querySelectorAll("#jobs .job-card:not([hidden])")
    );
    // Prefer the card that followed the removed one, otherwise the one before it.
    const next = stillVisible[Math.min(index, stillVisible.length - 1)];
    if (next) {
      next.scrollIntoView({ behavior: "smooth", block: "start" });
      next.focus();
    }
  }
}

export function renderCategorySwitcher() {
  const container = document.querySelector(".category-switcher");
  container.innerHTML = "";

  for (const category in CATEGORY_API_MAP) {
    const button = document.createElement("button");
    button.id = `category${
      category.charAt(0).toUpperCase() + category.slice(1)
    }`;
    button.className = "category-btn";
    button.textContent = CATEGORY_API_MAP[category].label;
    button.dataset.category = category;

    if (category === currentCategory) {
      button.classList.add("active");
    }

    button.addEventListener("click", async () => {
      if (currentCategory !== category) {
        setCurrentCategory(category);
        // Update the URL to reflect the new category
        const params = new URLSearchParams(window.location.search);
        params.set("category", category);
        const newUrl = `${window.location.pathname}?${params.toString()}`;
        window.history.replaceState({}, "", newUrl);

        document
          .querySelectorAll(".category-btn")
          .forEach((btn) => btn.classList.remove("active"));
        button.classList.add("active");

        // Update search input placeholder
        const searchInput = document.getElementById("search");
        if (searchInput && CATEGORY_API_MAP[category].placeholder) {
          searchInput.placeholder = CATEGORY_API_MAP[category].placeholder;
        }

        const latestThreadForNewCategory = allThreads[currentCategory][0];
        if (latestThreadForNewCategory) {
          const match = latestThreadForNewCategory.title.match(/\b(\d{4})\b/);
          setSelectedYear(match ? parseInt(match[1]) : null);
        } else {
          setSelectedYear(null);
        }

        renderThreadSwitcher();
        if (latestThreadForNewCategory) {
          await loadThread(latestThreadForNewCategory.objectID);
        } else {
          document.getElementById(
            "jobs"
          ).innerHTML = `<div class="loading">${icon("info-circle")} No threads found for this category.</div>`;
          // setCurrentThreadId(null); // Handled by loadThread or its absence
          setLoadTimeInfo("");
          clearLastRefreshedInfo();
        }
      }
    });
    container.appendChild(button);
  }
}

export function renderThreadSwitcher() {
  const yearSelector = document.querySelector(".switcher .year-selector");
  const monthSelector = document.querySelector(".switcher .month-selector");
  yearSelector.innerHTML = "";
  monthSelector.innerHTML = "";

  const currentCategoryThreads = allThreads[currentCategory];
  if (!currentCategoryThreads || currentCategoryThreads.length === 0) return;

  const threadsByYearMonth = new Map();
  currentCategoryThreads.forEach((t) => {
    const { year, month } = getYearAndMonthFromTitle(t.title);
    if (year && month) {
      if (!threadsByYearMonth.has(year)) {
        threadsByYearMonth.set(year, new Map());
      }
      threadsByYearMonth.get(year).set(month, t);
    }
  });

  // Show only the latest two years present in the data
  const allYears = Array.from(threadsByYearMonth.keys()).sort((a, b) => b - a);
  const years = allYears.slice(0, 2);
  if (selectedYear === null && years.length > 0) {
    setSelectedYear(years[0]);
  }

  years.forEach((year) => {
    const yearBtn = document.createElement("button");
    yearBtn.textContent = year;
    yearBtn.dataset.year = year;
    yearBtn.classList.add("year-btn");
    if (year === selectedYear) {
      yearBtn.classList.add("active");
    }
    yearBtn.addEventListener("click", () => {
      if (selectedYear !== year) {
        setSelectedYear(year);
        renderThreadSwitcher();
        const monthsForYear = Array.from(
          threadsByYearMonth.get(selectedYear).keys()
        ).sort(
          (a, b) =>
            MONTH_NAMES.indexOf(
              MONTH_NAMES.find((m) => m.toLowerCase() === b.toLowerCase())
            ) -
            MONTH_NAMES.indexOf(
              MONTH_NAMES.find((m) => m.toLowerCase() === a.toLowerCase())
            )
        );
        if (monthsForYear.length > 0) {
          const latestMonthThread = threadsByYearMonth
            .get(selectedYear)
            .get(monthsForYear[0]);
          if (latestMonthThread) {
            loadThread(latestMonthThread.objectID);
          }
        }
      }
    });
    yearSelector.appendChild(yearBtn);
  });

  if (selectedYear && threadsByYearMonth.has(selectedYear)) {
    const monthsMap = threadsByYearMonth.get(selectedYear);
    const months = Array.from(monthsMap.keys()).sort(
      (a, b) =>
        MONTH_NAMES.indexOf(
          MONTH_NAMES.find((m) => m.toLowerCase() === b.toLowerCase())
        ) -
        MONTH_NAMES.indexOf(
          MONTH_NAMES.find((m) => m.toLowerCase() === a.toLowerCase())
        )
    );

    months.forEach((month) => {
      const thread = monthsMap.get(month);
      if (thread) {
        const monthBtn = document.createElement("button");
        monthBtn.textContent = month;
        monthBtn.dataset.month = month;
        monthBtn.dataset.year = selectedYear;
        monthBtn.dataset.threadId = thread.objectID;
        monthBtn.classList.add("month-btn");
        if (String(thread.objectID) === String(currentThreadId)) {
          monthBtn.classList.add("active");
        }
        monthBtn.addEventListener("click", () => loadThread(thread.objectID));
        monthSelector.appendChild(monthBtn);
      }
    });
  }
}

export function renderParsedQuery(tokens) {
  const displayContainer = document.getElementById("parsed-query-display");
  displayContainer.innerHTML = "";

  tokens.forEach((token) => {
    const span = document.createElement("span");
    span.classList.add("query-token");
    let textContent = token;
    let isNegated = false;
    let isPhrase = false;

    if (token === "|" || token === "&") {
      span.classList.add("token-operator");
    } else {
      if (token.startsWith("~")) {
        isNegated = true;
        span.classList.add("token-negated");
        textContent = token.substring(1);
      }
      if (textContent.startsWith('"') && textContent.endsWith('"')) {
        isPhrase = true;
        span.classList.add("token-phrase");
        textContent = textContent.substring(1, textContent.length - 1);
      } else if (isNegated) {
        span.classList.add("token-word");
      } else {
        span.classList.add("token-word");
      }
    }
    if (isPhrase && !textContent) {
      textContent = '""';
    }
    span.textContent = textContent;
    displayContainer.appendChild(span);
  });
}

// Preserve original load-time-info text but append search results when query present
function appendSearchResultsCount(query, filteredCount) {
  const el = document.getElementById("load-time-info");
  if (!el) return;
  // Remove any previous ' | Search results: ...' suffix to keep idempotent
  const baseText = el.textContent.replace(/\s*\|\s*Search results:\s*\d+$/i, "");
  if (query && query.trim().length > 0) {
    el.textContent = baseText.trim()
      ? `${baseText} | Search results: ${filteredCount}`
      : `Search results: ${filteredCount}`;
  } else {
    el.textContent = baseText;
  }
}

function formatDateTime(value) {
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatPostedTime(createdAt) {
  if (!createdAt) return "";
  const d = new Date(createdAt);
  const diffMins = Math.floor((Date.now() - d) / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  let timeAgo = "just now";
  if (diffDays > 0) timeAgo = `${diffDays} ${diffDays === 1 ? "day" : "days"} ago`;
  else if (diffHours > 0) timeAgo = `${diffHours} ${diffHours === 1 ? "hour" : "hours"} ago`;
  else if (diffMins > 0) timeAgo = `${diffMins} ${diffMins === 1 ? "minute" : "minutes"} ago`;
  return `${formatDateTime(d)} <span title="${d.toLocaleString()}">(${timeAgo})</span>`;
}

function deriveJobTitle(html) {
  const plainText = html.replace(/<[^>]+>/g, "");
  if (currentCategory === "hiring") {
    const titleLineMatch = plainText.match(/^.*?(?=\n|$)/);
    const rawTitleLine = titleLineMatch ? titleLineMatch[0].trim() : "";
    const title = rawTitleLine.includes("|")
      ? rawTitleLine.split("|")[0].trim()
      : rawTitleLine;
    return title.length < 2 || title.length > 80 ? "Job Post" : title;
  }
  if (currentCategory === "hired") return "SEEKING WORK";
  if (plainText.includes("SEEKING WORK")) return "SEEKING WORK";
  if (plainText.includes("SEEKING FREELANCER")) return "SEEKING FREELANCER";
  return "Title Not Found";
}

// ---------------------------------------------------------------------------
// Card cache. Cards are built once per thread and kept; searching and filtering only
// toggle `hidden` on the existing elements and re-highlight the visible ones, so the
// cost of a keystroke scales with the number of matches, not the size of the thread.
// A newly loaded thread mounts its first screen synchronously and the rest in chunks
// so the first cards paint without waiting for all of them to be built.
// ---------------------------------------------------------------------------
const FIRST_CHUNK = 24;
const CHUNK = 60;

const cardCache = {
  threadId: null,
  comments: null, // the array the current mount was built from
  cards: new Map(), // jobId -> entry
  mounted: [], // entries in DOM order
  emptyEl: null,
  buildTimer: null,
  view: null,
};

function resetCardCache() {
  clearTimeout(cardCache.buildTimer);
  cardCache.buildTimer = null;
  cardCache.cards.clear();
  cardCache.mounted = [];
  cardCache.comments = null;
  cardCache.emptyEl = null;
}

function readFilterState() {
  const on = (id) =>
    document.getElementById(id)?.classList.contains(highlightClass) || false;
  return {
    showFavs: on("showFavorites"),
    showApplied: on("showApplied"),
    showNotes: on("showNotes"),
    hideApplied: on("hideApplied"),
    showHidden: on("showHidden"),
  };
}

function passesFilters(jobId, f) {
  const th = currentThreadId;
  const isHidden = !!hidden[th]?.[jobId];
  if (f.showFavs) return !!favorites[th]?.[jobId] && !isHidden;
  if (f.showApplied) return !!applied[th]?.[jobId] && !isHidden;
  if (f.hideApplied) return !applied[th]?.[jobId] && !isHidden;
  if (f.showNotes) return !!notes[th]?.[jobId]?.trim() && !isHidden;
  if (f.showHidden) return isHidden;
  return !isHidden;
}

function buildCard(c, jobId) {
  const { html, searchText } = prepareCommentHtml(c.text);
  const appliedStatus = applied[currentThreadId]?.[jobId];
  const note = notes[currentThreadId]?.[jobId] || "";
  const isFav = favorites[currentThreadId]?.[jobId];
  const authorName = c.author || "[unknown author]";
  const postedTime = formatPostedTime(c.created_at);
  const jobTitle = deriveJobTitle(html);
  const hnLink = `https://news.ycombinator.com/item?id=${jobId}`;

  const article = document.createElement("article");
  article.className = "job-card fade-in";
  article.tabIndex = 0;
  article.setAttribute("data-job-id", jobId);
  if (appliedStatus) article.classList.add("applied");

  article.innerHTML = `
            <div class="job-header">
                <div class="job-header-top">
                    <div class="job-header-status">
                        ${
                          appliedStatus
                            ? `<span class="badge badge-applied">Applied</span>
                            <div class="meta">${icon("calendar")} ${formatDateTime(
                              appliedStatus
                            )}</div>`
                            : ""
                        }
                    </div>
                    <div class="job-posted-time">${
                      postedTime
                        ? `<a href="${hnLink}" target="_blank" rel="noopener noreferrer" style="color: inherit; text-decoration: none;">${postedTime}</a>`
                        : ""
                    }</div>
                </div>
                <div class="job-title-container">
                    <button class="action-btn star-btn${
                      isFav ? "" : " inactive"
                    }" data-action="star" title="Add to Favorite" aria-label="Star job">${icon("star")}</button>
                    <div class="job-title"><a href="${hnLink}" target="_blank" rel="noopener noreferrer" style="color: inherit; text-decoration: none;">${jobTitle}</a></div>
                </div>
                <div class="job-author-container">
                    <div class="job-author">
                        <span class="job-author-main">Posted by: ${authorName}</span>
                        <a href="${hnLink}" class="action-btn" target="_blank" rel="noopener noreferrer" title="Open on Hacker News" aria-label="Open on Hacker News">${icon("external-link")}</a>
                        <button class="action-btn" data-action="copy-link" title="Copy link" aria-label="Copy link">${icon("copy")}</button>
                    </div>
                </div>
            </div>
            <div class="job-content">
                <div class="job-description"></div>
            </div>
            <div class="job-notes">
                <textarea class="note" placeholder="Add notes about this position..."></textarea>
            </div>
            <div class="job-actions">
                <button class="job-action-button btn-remove btn-remove-margin" data-action="remove" title="Exclude">${icon("xmark")} Exclude</button>
                <button class="job-action-button btn-save-note" data-action="save-note" title="Update Note">${icon("edit")} Update Note</button>
                ${
                  appliedStatus
                    ? `<button class="btn-unapply" data-action="unapply">${icon("xmark")} Remove Applied Status</button>`
                    : `<button class="job-action-button btn-apply" data-action="apply">${icon("check")} Mark as Applied</button>`
                }
            </div>
        `;

  const desc = article.querySelector(".job-description");
  desc.innerHTML = html;
  article.querySelector(".note").value = note;

  return {
    el: article,
    desc,
    html,
    searchText,
    author: (c.author || "").toLowerCase(),
    jobId,
    hlKey: "",
    excludeMode: "remove",
  };
}

// Exclude <-> Restore button depends on whether the "Show Excluded" filter is on.
function applyExcludeMode(entry, showHidden) {
  const mode = showHidden ? "unhide" : "remove";
  if (entry.excludeMode === mode) return;
  const btn = entry.el.querySelector(".btn-remove, .btn-unhide");
  if (!btn) return;
  if (mode === "unhide") {
    btn.className = "job-action-button btn-unhide btn-remove-margin";
    btn.dataset.action = "unhide";
    btn.title = "Restore";
    btn.innerHTML = `${icon("undo")} Restore`;
  } else {
    btn.className = "job-action-button btn-remove btn-remove-margin";
    btn.dataset.action = "remove";
    btn.title = "Exclude";
    btn.innerHTML = `${icon("xmark")} Exclude`;
  }
  entry.excludeMode = mode;
}

function applyHighlight(entry, view) {
  if (entry.hlKey === view.hlKey) return;
  entry.desc.innerHTML = view.hlKey
    ? highlightSearchTerms(entry.html, view.queryTokens)
    : entry.html;
  entry.hlKey = view.hlKey;
}

function getEmptyStateEl(container) {
  if (!cardCache.emptyEl || !container.contains(cardCache.emptyEl)) {
    const el = document.createElement("div");
    el.className = "loading fade-in";
    el.innerHTML = `${icon("meh")} No matches found!`;
    el.hidden = true;
    container.prepend(el);
    cardCache.emptyEl = el;
  }
  return cardCache.emptyEl;
}

// Applies the current view (filters + query) to every mounted card.
function applyView(container) {
  const view = cardCache.view;
  let visibleCount = 0;

  for (const entry of cardCache.mounted) {
    let show = passesFilters(entry.jobId, view.filters);
    if (show && view.matches) {
      show = view.matches(
        entry.searchText,
        entry.author,
        (notes[currentThreadId]?.[entry.jobId] || "").toLowerCase()
      );
    }
    entry.el.hidden = !show;
    if (show) {
      visibleCount++;
      applyExcludeMode(entry, view.filters.showHidden);
      applyHighlight(entry, view);
    }
  }

  const building = cardCache.buildTimer !== null;
  getEmptyStateEl(container).hidden = building || visibleCount > 0;
  appendSearchResultsCount(view.query, visibleCount);
}

function mountCards(container, comments) {
  clearTimeout(cardCache.buildTimer);
  cardCache.buildTimer = null;
  cardCache.comments = comments;
  cardCache.mounted = [];
  cardCache.emptyEl = null;
  container.innerHTML = "";
  getEmptyStateEl(container);

  let i = 0;
  const appendChunk = (size) => {
    const frag = document.createDocumentFragment();
    const end = Math.min(i + size, comments.length);
    for (; i < end; i++) {
      const c = comments[i];
      const jobId = c.id;
      let entry = cardCache.cards.get(jobId);
      if (!entry) {
        entry = buildCard(c, jobId);
        cardCache.cards.set(jobId, entry);
      }
      cardCache.mounted.push(entry);
      frag.appendChild(entry.el);
    }
    container.appendChild(frag);
  };

  const buildMore = () => {
    if (i >= comments.length) {
      cardCache.buildTimer = null;
      applyView(container);
      return;
    }
    appendChunk(CHUNK);
    applyView(container);
    cardCache.buildTimer = setTimeout(buildMore, 0);
  };

  appendChunk(FIRST_CHUNK);
  if (i < comments.length) {
    cardCache.buildTimer = setTimeout(buildMore, 0);
  }
}

export function renderJobs(commentsToRender) {
  const container = document.getElementById("jobs");
  const query = document.getElementById("search").value;
  const queryTokens = parseQuery(query);
  renderParsedQuery(queryTokens);

  cardCache.view = {
    query,
    queryTokens,
    filters: readFilterState(),
    matches: compileQuery(queryTokens),
    hlKey: queryTokens.join(" "),
  };

  if (cardCache.threadId !== currentThreadId) {
    resetCardCache();
    cardCache.threadId = currentThreadId;
  }

  const needsMount =
    cardCache.comments !== commentsToRender ||
    cardCache.mounted.length === 0 ||
    !container.contains(cardCache.mounted[0].el);

  if (needsMount) {
    mountCards(container, commentsToRender);
  }
  applyView(container);
}

export function updateThemeIcon() {
  const themeToggle = document.getElementById("themeToggle");
  // Boot path: tolerate HTML from a different deploy (GitHub Pages caches files for 10 min).
  if (!themeToggle) return;
  const isDark = document.body.classList.contains("dark");
  themeToggle.innerHTML = icon(isDark ? "moon" : "sun");
  themeToggle.setAttribute(
    "aria-label",
    isDark ? "Switch to light mode" : "Switch to dark mode"
  );
}

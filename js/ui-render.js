import { CATEGORY_API_MAP, MONTH_NAMES, toastTimeout } from "./config.js";

import {
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

import { parseQuery, evaluateQuery } from "./search-logic.js";
import { getYearAndMonthFromTitle } from "./utils.js";
import { loadThread } from "./thread-manager.js";

export const highlightClass = "active";

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
          const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          return isExactMatch ? escaped : `\\b${escaped}\\b`;
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
                    <i class="far fa-calendar"></i> ${new Date(
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
        '<i class="fas fa-times" aria-hidden="true"></i> Remove Applied Status';
      actionsDiv.appendChild(unapplyBtn);
    } else {
      const applyBtn = document.createElement("button");
      applyBtn.className = "job-action-button btn-apply";
      applyBtn.setAttribute("data-action", "apply");
      applyBtn.innerHTML =
        '<i class="fas fa-check" aria-hidden="true"></i> Mark as Applied';
      actionsDiv.appendChild(applyBtn);
    }
  }
}

// Remove a job card from the DOM by jobId
export function removeJobCardInPlace(jobId) {
  const jobCard = document.querySelector(`.job-card[data-job-id="${jobId}"]`);
  if (jobCard && jobCard.parentNode) {
    // Always prefer the next card (down), only use previous if no next exists
    let nextCard = jobCard.nextElementSibling;
    jobCard.parentNode.removeChild(jobCard);
    if (nextCard && nextCard.classList.contains("job-card")) {
      // Scroll so the next card is at the top of the viewport
      nextCard.scrollIntoView({ behavior: "smooth", block: "start" });
      nextCard.focus();
    } else {
      // If no next, try previous
      let prevCard = jobCard.previousElementSibling;
      if (prevCard && prevCard.classList.contains("job-card")) {
        prevCard.scrollIntoView({ behavior: "smooth", block: "start" });
        prevCard.focus();
      }
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
          ).innerHTML = `<div class="loading"><i class="fas fa-info-circle"></i> No threads found for this category.</div>`;
          // setCurrentThreadId(null); // Handled by loadThread or its absence
          document.getElementById("load-time-info").textContent = "";
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
  try {
    const el = document.getElementById("load-time-info");
    if (!el) return;
    // Remove any previous ' | Search results: ...' suffix to keep idempotent
    const baseText = el.textContent.replace(/\s*\|\s*Search results:\s*\d+$/i, "");
    if (query && query.trim().length > 0) {
      if (baseText && baseText.trim().length > 0) {
        el.textContent = `${baseText} | Search results: ${filteredCount}`;
      } else {
        el.textContent = `Search results: ${filteredCount}`;
      }
    } else {
      // If no query, restore base message (do not append)
      el.textContent = baseText;
    }
  } catch (e) {
    console.error('Failed to update search results count', e);
  }
}

export function renderJobs(commentsToRender) {
  const container = document.getElementById("jobs");
  const query = document.getElementById("search").value;
  // Filter button states will be accessed directly via their element IDs or references
  // once ui-events.js creates them. For now, assume they might be undefined if accessed early.
  const showFavs =
    document
      .getElementById("showFavorites")
      ?.classList.contains(highlightClass) || false;
  const showApplied =
    document
      .getElementById("showApplied")
      ?.classList.contains(highlightClass) || false;
  const showNotes =
    document.getElementById("showNotes")?.classList.contains(highlightClass) ||
    false;
  const hideAppliedActive =
    document
      .getElementById("hideApplied")
      ?.classList.contains(highlightClass) || false;
  const showHiddenActive =
    document.getElementById("showHidden")?.classList.contains(highlightClass) ||
    false;

  container.innerHTML = "";
  let filteredComments = commentsToRender;
  const getJobId = (comment) => comment.id;

  if (showFavs) {
    filteredComments = filteredComments.filter(
      (c) =>
        favorites[currentThreadId]?.[getJobId(c)] &&
        !hidden[currentThreadId]?.[getJobId(c)]
    );
  } else if (showApplied) {
    filteredComments = filteredComments.filter(
      (c) =>
        applied[currentThreadId]?.[getJobId(c)] &&
        !hidden[currentThreadId]?.[getJobId(c)]
    );
  } else if (hideAppliedActive) {
    filteredComments = filteredComments.filter(
      (c) =>
        !applied[currentThreadId]?.[getJobId(c)] &&
        !hidden[currentThreadId]?.[getJobId(c)]
    );
  } else if (showNotes) {
    filteredComments = filteredComments.filter((c) => {
      const jobId = getJobId(c);
      return (
        notes[currentThreadId]?.[jobId] &&
        notes[currentThreadId][jobId].trim().length > 0 &&
        !hidden[currentThreadId]?.[jobId]
      );
    });
  } else if (showHiddenActive) {
    filteredComments = filteredComments.filter(
      (c) => hidden[currentThreadId]?.[getJobId(c)]
    );
  } else {
    filteredComments = filteredComments.filter(
      (c) => !hidden[currentThreadId]?.[getJobId(c)]
    );
  }

  const queryTokens = parseQuery(query);
  renderParsedQuery(queryTokens);

  if (queryTokens.length > 0) {
    filteredComments = filteredComments.filter((c) => {
      const jobId = getJobId(c);
      return evaluateQuery(
        (c.text || "").toLowerCase(),
        (c.author || "").toLowerCase(),
        (notes[currentThreadId]?.[jobId] || "").toLowerCase(),
        queryTokens
      );
    });
  }

  // Update load-time-info with filtered count when a query is active
  appendSearchResultsCount(query, filteredComments.length);

  if (filteredComments.length === 0) {
    let message = "No matches found!";
    // ... (message updates based on filters)
    container.innerHTML = `<div class="loading fade-in"><i class="far fa-meh"></i> ${message}</div>`;
    return;
  }

  filteredComments.forEach((c) => {
    const jobId = getJobId(c);
    const appliedStatus = applied[currentThreadId]?.[jobId];
    const note = notes[currentThreadId]?.[jobId] || "";
    const isFav = favorites[currentThreadId]?.[jobId];
    // const isHidden = hidden[currentThreadId]?.[jobId]; // Already used for filtering

    let postedTime = "";
    if (c.created_at) {
      const d = new Date(c.created_at);
      const formattedDate = d.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
      const now = new Date();
      const diffMs = now - d;
      const diffSecs = Math.floor(diffMs / 1000);
      const diffMins = Math.floor(diffSecs / 60);
      const diffHours = Math.floor(diffMins / 60);
      const diffDays = Math.floor(diffHours / 24);
      let timeAgo = "";
      if (diffDays > 0)
        timeAgo = `${diffDays} ${diffDays === 1 ? "day" : "days"} ago`;
      else if (diffHours > 0)
        timeAgo = `${diffHours} ${diffHours === 1 ? "hour" : "hours"} ago`;
      else if (diffMins > 0)
        timeAgo = `${diffMins} ${diffMins === 1 ? "minute" : "minutes"} ago`;
      else timeAgo = "just now";
      postedTime = `${formattedDate} <span title="${d.toLocaleString()}">(${timeAgo})</span>`;
    }

    let commentTextHTML = c.text || "[No comment text]";
    if (queryTokens.length > 0) {
      commentTextHTML = highlightSearchTerms(commentTextHTML, queryTokens);
    }
    const authorName = c.author || "[unknown author]";
    const plainTextComment = commentTextHTML.replace(/<[^>]+>/g, "");

    let jobTitle = "";

    if (currentCategory === "hiring") {
      const titleLineMatch = plainTextComment.match(/^.*?(?=\n|$)/);
      const rawTitleLine = titleLineMatch ? titleLineMatch[0].trim() : "";

      jobTitle = rawTitleLine.includes("|")
        ? rawTitleLine.split("|")[0].trim()
        : rawTitleLine;
      if (jobTitle.length < 2 || jobTitle.length > 80) {
        jobTitle = "Job Post";
      }
    } else if (currentCategory === "hired") {
      jobTitle = "SEEKING WORK";
    } else if (currentCategory === "freelance") {
      if (plainTextComment.includes("SEEKING WORK")) {
        jobTitle = "SEEKING WORK";
      } else if (plainTextComment.includes("SEEKING FREELANCER")) {
        jobTitle = "SEEKING FREELANCER";
      } else {
        jobTitle = "Title Not Found";
      }
    }

    const article = document.createElement("article");
    article.className = "job-card fade-in";
    article.tabIndex = 0;
    article.setAttribute("data-job-id", jobId);
    if (appliedStatus) article.classList.add("applied");

    let hideOrUnhideBtn = "";
    if (showHiddenActive) {
      hideOrUnhideBtn = `<button class="job-action-button btn-unhide btn-remove-margin" data-action="unhide" title="Restore"><i class="fas fa-undo"></i> Restore</button>`;
    } else {
      hideOrUnhideBtn = `<button class="job-action-button btn-remove btn-remove-margin" data-action="remove" title="Exclude"><i class="fas fa-xmark"></i> Exclude</button>`;
    }

    article.innerHTML = `
            <div class="job-header">
                <div class="job-header-top">
                    <div class="job-header-status">
                        ${
                          appliedStatus
                            ? `<span class="badge badge-applied">Applied</span>
                            <div class="meta"><i class="far fa-calendar"></i> ${new Date(
                              appliedStatus
                            ).toLocaleString("en-US", {
                              month: "short",
                              day: "numeric",
                              hour: "numeric",
                              minute: "2-digit",
                              hour12: true,
                            })}</div>`
                            : ""
                        }
                    </div>
                    <div class="job-posted-time">${
                      postedTime
                        ? `<a href="https://news.ycombinator.com/item?id=${jobId}" target="_blank" rel="noopener noreferrer" style="color: inherit; text-decoration: none;">${postedTime}</a>`
                        : ""
                    }</div>
                </div>
                <div class="job-title-container">
                    <button class="action-btn star-btn${
                      isFav ? "" : " inactive"
                    }" data-action="star" title="Add to Favorite" aria-label="Star job"><i class="fas fa-star"></i></button>
                    <div class="job-title"><a href="https://news.ycombinator.com/item?id=${jobId}" target="_blank" rel="noopener noreferrer" style="color: inherit; text-decoration: none;">${jobTitle}</a></div>
                </div>
                <div class="job-author-container">
                    <div class="job-author">
                        <span class="job-author-main">Posted by: ${authorName}</span>
                        <a href="https://news.ycombinator.com/item?id=${jobId}" class="action-btn" target="_blank" rel="noopener noreferrer" title="Open on Hacker News" aria-label="Open on Hacker News"><i class="fas fa-external-link-alt"></i></a>
                        <button class="action-btn" data-action="copy-link" title="Copy link" aria-label="Copy link"><i class="fas fa-copy"></i></button>
                    </div>
                </div>
            </div>
            <div class="job-content">
                <div class="job-description">${commentTextHTML}</div>
            </div>
            <div class="job-notes">
                <textarea class="note" placeholder="Add notes about this position...">${note}</textarea>
            </div>
            <div class="job-actions">
                ${hideOrUnhideBtn}
                <button class="job-action-button btn-save-note" data-action="save-note" title="Update Note"><i class="fas fa-edit"></i> Update Note</button>
                ${
                  appliedStatus
                    ? `<button class="btn-unapply" data-action="unapply"><i class="fas fa-times"></i> Remove Applied Status</button>`
                    : `<button class="job-action-button btn-apply" data-action="apply"><i class="fas fa-check"></i> Mark as Applied</button>`
                }
            </div>
        `;
    container.appendChild(article);
  });
}

export function updateThemeIcon() {
  const themeToggle = document.getElementById("themeToggle");
  const icon = themeToggle.querySelector("i");
  if (document.body.classList.contains("dark")) {
    icon.className = "fas fa-moon";
    themeToggle.setAttribute("aria-label", "Switch to light mode");
  } else {
    icon.className = "fas fa-sun";
    themeToggle.setAttribute("aria-label", "Switch to dark mode");
  }
}

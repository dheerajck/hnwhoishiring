import {
  USE_MOCK_DATA,
  MOCK_THREAD_DATA,
  MOCK_COMMENT_DATA,
} from "./config.js";

import { initialThreadsLoadingCompleted } from "./state.js";

// Constants for better maintainability
const DELAYS = {
  INITIAL_LOAD: 500,
  UPDATE_LOAD: 500,
  COMMENT_FETCH: 500,
  COMMENT_UPDATE: 500,
};

const API_ENDPOINTS = {
  SEARCH_BY_DATE: "https://hn.algolia.com/api/v1/search_by_date",
  ITEMS: "https://hn.algolia.com/api/v1/items",
};

// Utility functions
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findMockDataKey(query, mockData) {
  return Object.keys(mockData).find((key) => query.includes(key)) || "";
}

function createApiError(operation, statusText) {
  return new Error(`Failed to ${operation}: ${statusText}`);
}

// Mock data handlers
async function _fetchMockThreadsForCategory(categoryConfig) {
  const { query } = categoryConfig;
  const selectedMockKey = findMockDataKey(query, MOCK_THREAD_DATA);

  if (!selectedMockKey) {
    return [];
  }

  const mockData = MOCK_THREAD_DATA[selectedMockKey];
  const dataToFetch = initialThreadsLoadingCompleted
    ? mockData?.update
    : mockData?.initial;

  const delayTime = initialThreadsLoadingCompleted
    ? DELAYS.UPDATE_LOAD
    : DELAYS.INITIAL_LOAD;

  await delay(delayTime);
  return [...(dataToFetch || [])];
}

async function _fetchMockThreadComments(threadId) {
  await delay(DELAYS.COMMENT_FETCH);
  const comments = MOCK_COMMENT_DATA[threadId]?.initial || [];
  return [...comments].reverse();
}

async function _fetchMockNewerComments(threadId) {
  await delay(DELAYS.COMMENT_UPDATE);
  return MOCK_COMMENT_DATA[threadId]?.update || [];
}

// API handlers
async function _fetchApiThreadsForCategory(categoryConfig) {
  const { query, tags } = categoryConfig;
  const encodedQuery = encodeURIComponent(query);
  // Only objectID and title are used. Without these two params Algolia returns the full
  // thread body (plus a highlighted copy of it) for every hit: ~300 KB across the three
  // categories instead of a few KB.
  const url = `${API_ENDPOINTS.SEARCH_BY_DATE}?query=${encodedQuery}&tags=${tags}&attributesToRetrieve=objectID,title&attributesToHighlight=none`;

  const response = await fetch(url);
  if (!response.ok) {
    throw createApiError(
      `fetch thread list for category "${query}"`,
      response.statusText
    );
  }

  const data = await response.json();
  return data.hits || [];
}

async function _fetchApiThreadComments(threadId) {
  const response = await fetch(`${API_ENDPOINTS.ITEMS}/${threadId}`);
  if (!response.ok) {
    throw createApiError("fetch thread details", response.statusText);
  }

  const data = await response.json();
  // Filter top-level comments and reverse order
  return (data.children || [])
    .filter((comment) => comment.parent_id === data.id)
    .reverse();
}

async function _fetchApiNewerComments(threadId, lastCachedTimestampMs) {
  const lastCachedTimestampSeconds = Math.floor(lastCachedTimestampMs / 1000);
  const url = `${API_ENDPOINTS.SEARCH_BY_DATE}?tags=comment,story_${threadId}&numericFilters=created_at_i>${lastCachedTimestampSeconds}&hitsPerPage=1000`;

  const response = await fetch(url);
  if (!response.ok) {
    throw createApiError("fetch updates", response.statusText);
  }

  const data = await response.json();
  return data.hits || [];
}

// Public API functions
export async function fetchLatestThreadListFromApi(categoryConfig) {
  return USE_MOCK_DATA
    ? _fetchMockThreadsForCategory(categoryConfig)
    : _fetchApiThreadsForCategory(categoryConfig);
}

export async function fetchThreadComments(threadId) {
  return USE_MOCK_DATA
    ? _fetchMockThreadComments(threadId)
    : _fetchApiThreadComments(threadId);
}

export async function fetchNewerComments(threadId, lastCachedTimestampMs) {
  return USE_MOCK_DATA
    ? _fetchMockNewerComments(threadId)
    : _fetchApiNewerComments(threadId, lastCachedTimestampMs);
}

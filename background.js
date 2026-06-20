// ============================================================
// Background Service Worker
// Handles: shortcuts, icon clicks, querying tabs, switching tabs,
// Google Suggestions, and single-instance management.
// ============================================================

// Track which tab has spotlight open (only 1 instance allowed browser-wide)
let spotlightActiveTabId = null;

// Cache for storing search suggestions (maximum of 100 recent queries)
const suggestionCache = new Map();
const MAX_CACHE_SIZE = 100;

// AbortController to cancel stale fetch requests when a new request is made
let activeAbortController = null;

// Triggered when user presses the Ctrl+Q shortcut (declared in manifest commands)
chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-spotlight") {
    sendToggleMessage();
  }
});

// Triggered when user clicks the extension icon on the toolbar
chrome.action.onClicked.addListener(() => {
  sendToggleMessage();
});

// Send toggle message to the content script of the active tab
function sendToggleMessage() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]?.id) return;
    const currentTabId = tabs[0].id;

    // If spotlight is open in a DIFFERENT tab → close the old one first
    if (
      spotlightActiveTabId !== null &&
      spotlightActiveTabId !== currentTabId
    ) {
      chrome.tabs
        .sendMessage(spotlightActiveTabId, { action: "close-spotlight" })
        .catch(() => {});
      spotlightActiveTabId = null;
    }

    chrome.tabs.sendMessage(currentTabId, { action: "toggle-spotlight" });
  });
}

// When the active tab changes → close spotlight on the previously active tab
chrome.tabs.onActivated.addListener((activeInfo) => {
  if (
    spotlightActiveTabId !== null &&
    spotlightActiveTabId !== activeInfo.tabId
  ) {
    chrome.tabs
      .sendMessage(spotlightActiveTabId, { action: "close-spotlight" })
      .catch(() => {});
    spotlightActiveTabId = null;
  }
});

// When a tab is closed → cleanup
chrome.tabs.onRemoved.addListener((tabId) => {
  if (spotlightActiveTabId === tabId) {
    spotlightActiveTabId = null;
  }
});

// ----------------------------------------------------------
// Listen for messages from content scripts
// ----------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    // Content script notifies that spotlight has opened
    case "spotlight-opened":
      spotlightActiveTabId = sender.tab?.id ?? null;
      break;

    // Content script notifies that spotlight has closed
    case "spotlight-closed":
      if (spotlightActiveTabId === sender.tab?.id) {
        spotlightActiveTabId = null;
      }
      break;

    // Retrieve a list of all currently open tabs
    case "get-tabs":
      chrome.tabs.query({}, (tabs) => {
        const tabList = tabs.map((t) => ({
          id: t.id,
          windowId: t.windowId,
          title: t.title || "",
          url: t.url || "",
          favIconUrl: t.favIconUrl || "",
          active: t.active,
        }));
        sendResponse({ tabs: tabList });
      });
      return true; // keep the message channel open for asynchronous response

    // Switch to the selected tab
    case "switch-tab":
      if (message.tabId && message.windowId) {
        // Close spotlight before switching
        if (spotlightActiveTabId !== null) {
          chrome.tabs
            .sendMessage(spotlightActiveTabId, { action: "close-spotlight" })
            .catch(() => {});
          spotlightActiveTabId = null;
        }
        chrome.windows.update(message.windowId, { focused: true }, () => {
          chrome.tabs.update(message.tabId, { active: true });
        });
      }
      break;

    // Fetch search suggestions from Google Suggest API (optimized with caching & request aborting)
    case "get-suggestions":
      if (message.query) {
        const query = message.query.trim().toLowerCase();

        // 1. Check cache first for immediate response
        if (suggestionCache.has(query)) {
          const cachedSuggestions = suggestionCache.get(query);
          sendResponse({ suggestions: cachedSuggestions });
          return false; // Synchronous response, no need to keep channel open
        }

        // 2. Abort any previous running request to avoid congestion/rate limit
        if (activeAbortController) {
          activeAbortController.abort();
        }
        activeAbortController = new AbortController();
        const signal = activeAbortController.signal;

        const url1 = `https://suggestqueries.google.com/complete/search?client=chrome&q=${encodeURIComponent(query)}`;
        const url2 = `https://www.google.com/complete/search?client=chrome&q=${encodeURIComponent(query)}`;

        // Helper function to perform fetch with AbortSignal
        const fetchSuggestions = (url) => {
          return fetch(url, { signal }).then((res) => {
            if (!res.ok) throw new Error(`Status ${res.status}`);
            return res.json();
          });
        };

        fetchSuggestions(url1)
          .then((data) => {
            const suggestions = Array.isArray(data[1])
              ? data[1].slice(0, 5)
              : [];
            // Save to cache (evicting oldest if max size exceeded)
            if (suggestionCache.size >= MAX_CACHE_SIZE) {
              const firstKey = suggestionCache.keys().next().value;
              suggestionCache.delete(firstKey);
            }
            suggestionCache.set(query, suggestions);

            sendResponse({ suggestions });
          })
          .catch((err) => {
            if (err.name === "AbortError") {
              sendResponse({ suggestions: [], aborted: true });
              return;
            }

            console.warn(
              "[Background] suggestqueries fetch failed, trying www.google.com...",
              err.message,
            );

            fetchSuggestions(url2)
              .then((data) => {
                const suggestions = Array.isArray(data[1])
                  ? data[1].slice(0, 5)
                  : [];

                // Save to cache
                if (suggestionCache.size >= MAX_CACHE_SIZE) {
                  const firstKey = suggestionCache.keys().next().value;
                  suggestionCache.delete(firstKey);
                }
                suggestionCache.set(query, suggestions);

                sendResponse({ suggestions });
              })
              .catch((err2) => {
                if (err2.name === "AbortError") {
                  sendResponse({ suggestions: [], aborted: true });
                  return;
                }
                console.error(
                  "[Background] Both suggestions fetches failed:",
                  err2.message,
                );
                sendResponse({ suggestions: [], error: err2.message });
              });
          });
      } else {
        sendResponse({ suggestions: [] });
      }
      return true;
  }
});

// ============================================================
// Background Service Worker
// Xử lý: phím tắt, click icon, query tabs, switch tab,
// Google Suggestions, và single-instance management.
// ============================================================

// Track tab nào đang mở spotlight (chỉ cho phép 1 instance)
let spotlightActiveTabId = null;

// Cache lưu trữ gợi ý tìm kiếm (tối đa 100 queries gần nhất)
const suggestionCache = new Map();
const MAX_CACHE_SIZE = 100;

// Bộ điều khiển hủy request fetch cũ khi có request mới
let activeAbortController = null;

// Khi người dùng nhấn phím tắt Ctrl+Q (manifest commands)
chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-spotlight") {
    sendToggleMessage();
  }
});

// Khi người dùng click icon extension trên toolbar
chrome.action.onClicked.addListener(() => {
  sendToggleMessage();
});

// Gửi toggle message tới content script của tab đang active
function sendToggleMessage() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]?.id) return;
    const currentTabId = tabs[0].id;

    // Nếu spotlight đang mở ở tab KHÁC → đóng tab cũ trước
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

// Khi người dùng chuyển tab → đóng spotlight ở tab cũ
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

// Khi tab bị đóng → cleanup
chrome.tabs.onRemoved.addListener((tabId) => {
  if (spotlightActiveTabId === tabId) {
    spotlightActiveTabId = null;
  }
});

// ----------------------------------------------------------
// Lắng nghe message từ content script
// ----------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    // Content script thông báo spotlight đã mở
    case "spotlight-opened":
      spotlightActiveTabId = sender.tab?.id ?? null;
      break;

    // Content script thông báo spotlight đã đóng
    case "spotlight-closed":
      if (spotlightActiveTabId === sender.tab?.id) {
        spotlightActiveTabId = null;
      }
      break;

    // Lấy danh sách toàn bộ tab đang mở
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
      return true; // giữ kênh mở cho async response

    // Chuyển đến tab được chọn
    case "switch-tab":
      if (message.tabId && message.windowId) {
        // Đóng spotlight trước khi chuyển
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

    // Lấy gợi ý tìm kiếm từ Google Suggest API (có tối ưu cache & abort request cũ)
    case "get-suggestions":
      if (message.query) {
        const query = message.query.trim().toLowerCase();

        // 1. Kiểm tra Cache trước để phản hồi ngay lập tức
        if (suggestionCache.has(query)) {
          const cachedSuggestions = suggestionCache.get(query);
          sendResponse({ suggestions: cachedSuggestions });
          return false; // Phản hồi đồng bộ, không cần giữ cổng kết nối
        }

        // 2. Hủy request đang chạy trước đó (nếu có) để tránh nghẽn/rate limit
        if (activeAbortController) {
          activeAbortController.abort();
        }
        activeAbortController = new AbortController();
        const signal = activeAbortController.signal;

        const url1 = `https://suggestqueries.google.com/complete/search?client=chrome&q=${encodeURIComponent(query)}`;
        const url2 = `https://www.google.com/complete/search?client=chrome&q=${encodeURIComponent(query)}`;

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
            // Lưu vào cache (giới hạn kích thước)
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

                // Lưu vào cache
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

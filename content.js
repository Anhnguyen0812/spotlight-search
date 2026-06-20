// ============================================================
// Content Script — Spotlight Search - Quick Tab Finder
// Inject UI overlay, tab search, Google suggestions,
// keyboard navigation, mouse gesture.
// ============================================================

(function () {
  "use strict";

  // Avoid duplicate injection
  if (document.getElementById("edge-spotlight-search-root")) return;

  // ----------------------------------------------------------
  // 1. Create DOM structure
  // ----------------------------------------------------------
  const root = document.createElement("div");
  root.id = "edge-spotlight-search-root";

  root.innerHTML = `
    <div class="spotlight-backdrop"></div>
    <div class="spotlight-container">
      <div class="spotlight-input-row">
        <svg class="spotlight-icon" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="7"></circle>
          <line x1="16.65" y1="16.65" x2="21" y2="21"></line>
        </svg>
        <input class="spotlight-input" type="text"
               placeholder="Search tabs or the web..."
               autocomplete="off" spellcheck="false" />
        <span class="spotlight-shortcut">
          <kbd>Ctrl</kbd>
          <span class="spotlight-shortcut-plus">+</span>
          <kbd>Q</kbd>
        </span>
      </div>
      <div class="spotlight-results"></div>
    </div>
  `;

  document.documentElement.appendChild(root);

  // ----------------------------------------------------------
  // 2. Reference elements
  // ----------------------------------------------------------
  const backdrop = root.querySelector(".spotlight-backdrop");
  const input = root.querySelector(".spotlight-input");
  const resultsContainer = root.querySelector(".spotlight-results");

  // ----------------------------------------------------------
  // 3. State
  // ----------------------------------------------------------
  let allTabs = [];
  let currentResults = []; // Current active results array: { type, data, element }
  let selectedIndex = -1;
  let suggestDebounceTimer = null;

  // Track mouse position to prevent focus jumping when scrolling via arrow keys
  let lastMouseX = 0;
  let lastMouseY = 0;
  let isKeyboardNavigating = false;

  // ----------------------------------------------------------
  // 3.5 Tab Classification System
  // ----------------------------------------------------------
  const CATEGORIES = {
    document: {
      label: "Documents & Files",
      icon: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`,
      badge: "Document",
      badgeClass: "spotlight-badge-doc",
      patterns: [
        /\.pdf(\?|#|$)/i,
        /\.docx?(\?|#|$)/i,
        /\.xlsx?(\?|#|$)/i,
        /\.pptx?(\?|#|$)/i,
        /\.csv(\?|#|$)/i,
        /\.txt(\?|#|$)/i,
        /\.rtf(\?|#|$)/i,
        /\.odt(\?|#|$)/i,
        /docs\.google\.com/i,
        /sheets\.google\.com/i,
        /slides\.google\.com/i,
        /drive\.google\.com/i,
        /onedrive\.live\.com/i,
        /office\.com/i,
        /notion\.so/i,
        /dropbox\.com/i,
        /overleaf\.com/i,
        /^file:/i,
      ],
    },
    media: {
      label: "Media & Entertainment",
      icon: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`,
      badge: "Media",
      badgeClass: "spotlight-badge-media",
      patterns: [
        /youtube\.com/i,
        /youtu\.be/i,
        /netflix\.com/i,
        /spotify\.com/i,
        /soundcloud\.com/i,
        /twitch\.tv/i,
        /vimeo\.com/i,
        /dailymotion\.com/i,
        /music\.apple\.com/i,
        /podcasts?\.google/i,
        /disneyplus\.com/i,
        /hulu\.com/i,
        /nhaccuatui\.com/i,
        /zingmp3\.vn/i,
        /phimmoi/i,
      ],
    },
    social: {
      label: "Social Media",
      icon: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2H7a5 5 0 00-5 5v10a5 5 0 005 5h10a5 5 0 005-5V7a5 5 0 00-5-5z"></path><path d="M16 11.37a4 4 0 11-4.73-4.73 4 4 0 014.73 4.73z"></path></svg>`,
      badge: "Social",
      badgeClass: "spotlight-badge-social",
      patterns: [
        /facebook\.com/i,
        /fb\.com/i,
        /twitter\.com/i,
        /x\.com/i,
        /instagram\.com/i,
        /linkedin\.com/i,
        /reddit\.com/i,
        /tiktok\.com/i,
        /pinterest\.com/i,
        /threads\.net/i,
        /mastodon/i,
        /bsky\.app/i,
      ],
    },
    dev: {
      label: "Development & Tools",
      icon: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>`,
      badge: "Dev",
      badgeClass: "spotlight-badge-dev",
      patterns: [
        /github\.com/i,
        /gitlab\.com/i,
        /bitbucket\.org/i,
        /stackoverflow\.com/i,
        /stackexchange\.com/i,
        /codepen\.io/i,
        /codesandbox\.io/i,
        /jsfiddle\.net/i,
        /replit\.com/i,
        /vercel\.com/i,
        /netlify\.com/i,
        /heroku\.com/i,
        /aws\.amazon\.com/i,
        /console\.cloud\.google/i,
        /portal\.azure\.com/i,
        /localhost/i,
        /127\.0\.0\.1/i,
        /0\.0\.0\.0/i,
        /npmjs\.com/i,
        /pypi\.org/i,
      ],
    },
    mail: {
      label: "Email & Chat",
      icon: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22 6 12 13 2 6"></polyline></svg>`,
      badge: "Mail",
      badgeClass: "spotlight-badge-mail",
      patterns: [
        /mail\.google\.com/i,
        /outlook\.(live|office)\.com/i,
        /mail\.yahoo\.com/i,
        /protonmail\.com/i,
        /proton\.me\/mail/i,
        /slack\.com/i,
        /discord\.com/i,
        /teams\.microsoft\.com/i,
        /web\.telegram\.org/i,
        /web\.whatsapp\.com/i,
        /messenger\.com/i,
        /chat\.zalo\.me/i,
      ],
    },
    shopping: {
      label: "Shopping",
      icon: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"></circle><circle cx="20" cy="21" r="1"></circle><path d="M1 1h4l2.68 13.39a2 2 0 002 1.61h9.72a2 2 0 002-1.61L23 6H6"></path></svg>`,
      badge: "Shop",
      badgeClass: "spotlight-badge-shop",
      patterns: [
        /amazon\./i,
        /ebay\./i,
        /shopee\./i,
        /lazada\./i,
        /tiki\.vn/i,
        /sendo\.vn/i,
        /aliexpress\.com/i,
        /etsy\.com/i,
        /walmart\.com/i,
        /tokopedia\.com/i,
      ],
    },
    web: {
      label: "Web",
      icon: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"></path></svg>`,
      badge: "Web",
      badgeClass: "",
      patterns: [], // fallback
    },
  };

  // Order of category display priority
  const CATEGORY_ORDER = [
    "document",
    "media",
    "social",
    "mail",
    "dev",
    "shopping",
    "web",
  ];

  function classifyTab(tab) {
    const url = tab.url || "";
    for (const [key, cat] of Object.entries(CATEGORIES)) {
      if (key === "web") continue; // Skip generic fallback
      if (cat.patterns.some((p) => p.test(url))) return key;
    }
    return "web";
  }

  function groupTabsByCategory(tabs) {
    const groups = {};
    tabs.forEach((tab) => {
      const cat = classifyTab(tab);
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(tab);
    });
    return groups;
  }

  // ----------------------------------------------------------
  // 4. Automatic Dark/Light theme detection
  // ----------------------------------------------------------
  function detectTheme() {
    const prefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches;
    root.classList.toggle("dark", prefersDark);
  }
  detectTheme();
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", detectTheme);

  // ----------------------------------------------------------
  // 5. Open / Close Spotlight popup
  // ----------------------------------------------------------
  function openSpotlight() {
    root.classList.add("active");
    selectedIndex = -1;
    isKeyboardNavigating = false;
    setTimeout(() => input.focus(), 60);
    // Notify background: spotlight opened (for single-instance management)
    chrome.runtime.sendMessage({ action: "spotlight-opened" });
    // Retrieve tabs list on open
    fetchTabs();
  }

  function closeSpotlight() {
    if (!root.classList.contains("active")) return; // Avoid redundant messages
    root.classList.remove("active");
    input.value = "";
    input.blur();
    resultsContainer.innerHTML = "";
    currentResults = [];
    selectedIndex = -1;
    // Notify background: spotlight closed
    chrome.runtime.sendMessage({ action: "spotlight-closed" });
  }

  function toggleSpotlight() {
    if (root.classList.contains("active")) {
      closeSpotlight();
    } else {
      openSpotlight();
    }
  }

  // ----------------------------------------------------------
  // 6. Retrieve tab list from background
  // ----------------------------------------------------------
  function fetchTabs() {
    chrome.runtime.sendMessage({ action: "get-tabs" }, (response) => {
      if (response?.tabs) {
        allTabs = response.tabs;
        renderResults(input.value.trim());
      }
    });
  }

  // ----------------------------------------------------------
  // 7. Fetch suggestions from Google Suggest API
  // ----------------------------------------------------------
  function fetchSuggestions(query) {
    chrome.runtime.sendMessage(
      { action: "get-suggestions", query },
      (response) => {
        if (chrome.runtime.lastError) {
          console.error(
            "[Content] sendMessage (get-suggestions) failed:",
            chrome.runtime.lastError.message,
          );
          return;
        }
        if (
          response &&
          !response.aborted &&
          response.suggestions &&
          input.value.trim() === query
        ) {
          renderGoogleSuggestions(query, response.suggestions);
        }
      },
    );
  }

  // ----------------------------------------------------------
  // 8. Render results
  // ----------------------------------------------------------
  function renderResults(query) {
    clearTimeout(suggestDebounceTimer);
    resultsContainer.innerHTML = "";
    currentResults = [];
    selectedIndex = -1;

    const tabsToRender = query
      ? allTabs.filter(
          (t) =>
            t.title.toLowerCase().includes(query.toLowerCase()) ||
            t.url.toLowerCase().includes(query.toLowerCase()),
        )
      : allTabs;

    // Group tabs by category and render each group
    if (tabsToRender.length > 0) {
      const groups = groupTabsByCategory(tabsToRender);
      CATEGORY_ORDER.forEach((catKey) => {
        if (groups[catKey] && groups[catKey].length > 0) {
          renderCategorySection(catKey, groups[catKey]);
        }
      });
    }

    // If query is present → show Search Google option and trigger suggestions
    if (query) {
      // Show empty state if no tabs match the query
      if (tabsToRender.length === 0) {
        renderEmptyState(query);
      }
      renderSearchGoogleItem(query);
      suggestDebounceTimer = setTimeout(() => {
        fetchSuggestions(query);
      }, 200);
    }

    // Auto-select the first result item
    if (currentResults.length > 0) {
      setSelected(0);
    }
  }

  function renderEmptyState(query) {
    const section = document.createElement("div");
    section.className = "spotlight-section spotlight-empty";

    const msg = document.createElement("div");
    msg.className = "spotlight-empty-msg";
    msg.innerHTML = `
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><line x1="16.65" y1="16.65" x2="21" y2="21"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg>
      <span>No open tabs match "<strong>${query}</strong>"</span>
    `;
    section.appendChild(msg);
    resultsContainer.appendChild(section);
  }

  function renderCategorySection(catKey, tabs) {
    const cat = CATEGORIES[catKey];
    const section = document.createElement("div");
    section.className = "spotlight-section";

    const header = document.createElement("div");
    header.className = "spotlight-section-header";

    // Category icon + label
    const headerIcon = document.createElement("span");
    headerIcon.className = "spotlight-section-icon";
    headerIcon.innerHTML = cat.icon;
    header.appendChild(headerIcon);

    const headerText = document.createElement("span");
    headerText.textContent = cat.label;
    header.appendChild(headerText);

    // Tab count badge
    const countBadge = document.createElement("span");
    countBadge.className = "spotlight-section-count";
    countBadge.textContent = tabs.length;
    header.appendChild(countBadge);

    section.appendChild(header);

    tabs.forEach((tab) => {
      const idx = currentResults.length;
      const item = createTabItem(tab, idx, catKey);
      section.appendChild(item);
      currentResults.push({ type: "tab", data: tab, element: item });
    });

    resultsContainer.appendChild(section);
  }

  function createTabItem(tab, index, catKey) {
    const cat = CATEGORIES[catKey] || CATEGORIES.web;
    const item = document.createElement("div");
    item.className = "spotlight-item";
    item.dataset.index = index;

    // Favicon
    const favicon = document.createElement("img");
    favicon.className = "spotlight-item-icon spotlight-favicon";
    favicon.src =
      tab.favIconUrl ||
      'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="%23888" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="3"/></svg>';
    favicon.width = 20;
    favicon.height = 20;
    favicon.onerror = function () {
      this.src =
        'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="%23888" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>';
    };
    item.appendChild(favicon);

    // Text wrapper
    const textWrap = document.createElement("div");
    textWrap.className = "spotlight-item-text";

    const titleEl = document.createElement("div");
    titleEl.className = "spotlight-item-title";
    titleEl.textContent = tab.title || "Untitled";
    textWrap.appendChild(titleEl);

    const urlEl = document.createElement("div");
    urlEl.className = "spotlight-item-url";
    try {
      const u = new URL(tab.url);
      urlEl.textContent = u.hostname + (u.pathname !== "/" ? u.pathname : "");
    } catch {
      urlEl.textContent = tab.url;
    }
    textWrap.appendChild(urlEl);

    item.appendChild(textWrap);

    // Category badge on the right
    const badge = document.createElement("span");
    badge.className = `spotlight-item-badge ${cat.badgeClass}`;
    badge.textContent = cat.badge;
    item.appendChild(badge);

    // Event listeners
    item.addEventListener("click", () => switchToTab(tab));
    item.addEventListener("mouseenter", () => {
      if (isKeyboardNavigating) return;
      setSelected(index);
    });

    return item;
  }

  function renderSearchGoogleItem(query) {
    const section = document.createElement("div");
    section.className = "spotlight-section";

    const header = document.createElement("div");
    header.className = "spotlight-section-header";
    header.textContent = "Search Google";
    section.appendChild(header);

    const idx = currentResults.length;
    const item = document.createElement("div");
    item.className = "spotlight-item";
    item.dataset.index = idx;

    // Google icon
    const icon = document.createElement("div");
    icon.className = "spotlight-item-icon spotlight-google-icon";
    icon.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><line x1="16.65" y1="16.65" x2="21" y2="21"></line></svg>`;
    item.appendChild(icon);

    const textWrap = document.createElement("div");
    textWrap.className = "spotlight-item-text";
    const titleEl = document.createElement("div");
    titleEl.className = "spotlight-item-title";
    titleEl.textContent = `Search "${query}"`;
    textWrap.appendChild(titleEl);
    const urlEl = document.createElement("div");
    urlEl.className = "spotlight-item-url";
    urlEl.textContent = "google.com";
    textWrap.appendChild(urlEl);
    item.appendChild(textWrap);

    const badge = document.createElement("span");
    badge.className = "spotlight-item-badge spotlight-badge-search";
    badge.textContent = "Search";
    item.appendChild(badge);

    item.addEventListener("click", () => searchGoogle(query));
    item.addEventListener("mouseenter", () => {
      if (isKeyboardNavigating) return;
      setSelected(idx);
    });

    section.appendChild(item);
    resultsContainer.appendChild(section);
    currentResults.push({ type: "search", data: query, element: item });
  }

  function renderGoogleSuggestions(originalQuery, suggestions) {
    // Remove old suggestions section if present
    const old = resultsContainer.querySelector(
      ".spotlight-section-suggestions",
    );
    if (old) old.remove();

    // Filter out old suggestion items from currentResults
    currentResults = currentResults.filter((r) => r.type !== "suggestion");

    if (suggestions.length === 0) return;

    const section = document.createElement("div");
    section.className = "spotlight-section spotlight-section-suggestions";

    const header = document.createElement("div");
    header.className = "spotlight-section-header";
    header.textContent = "Suggestions";
    section.appendChild(header);

    suggestions.forEach((s) => {
      if (s.toLowerCase() === originalQuery.toLowerCase()) return;
      const idx = currentResults.length;
      const item = document.createElement("div");
      item.className = "spotlight-item";
      item.dataset.index = idx;

      const icon = document.createElement("div");
      icon.className = "spotlight-item-icon spotlight-suggest-icon";
      icon.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 10 20 15 15 20"></polyline><path d="M4 4v7a4 4 0 004 4h12"></path></svg>`;
      item.appendChild(icon);

      const textWrap = document.createElement("div");
      textWrap.className = "spotlight-item-text";
      const titleEl = document.createElement("div");
      titleEl.className = "spotlight-item-title";
      titleEl.textContent = s;
      textWrap.appendChild(titleEl);
      item.appendChild(textWrap);

      const badge = document.createElement("span");
      badge.className = "spotlight-item-badge spotlight-badge-search";
      badge.textContent = "Search";
      item.appendChild(badge);

      item.addEventListener("click", () => searchGoogle(s));
      item.addEventListener("mouseenter", () => {
        if (isKeyboardNavigating) return;
        setSelected(idx);
      });

      section.appendChild(item);
      currentResults.push({ type: "suggestion", data: s, element: item });
    });

    resultsContainer.appendChild(section);
    // Re-index all results
    reindexResults();
  }

  function reindexResults() {
    currentResults.forEach((r, i) => {
      r.element.dataset.index = i;
    });
  }

  // ----------------------------------------------------------
  // 9. Selection & Navigation
  // ----------------------------------------------------------
  function setSelected(index) {
    // Clear previously selected item class
    const prev = resultsContainer.querySelector(".spotlight-item.selected");
    if (prev) prev.classList.remove("selected");

    selectedIndex = index;
    if (index >= 0 && index < currentResults.length) {
      const el = currentResults[index].element;
      el.classList.add("selected");
      // Scroll item into view if necessary
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  function navigateUp() {
    if (currentResults.length === 0) return;
    let newIndex = selectedIndex - 1;
    if (newIndex < 0) newIndex = currentResults.length - 1;
    setSelected(newIndex);
  }

  function navigateDown() {
    if (currentResults.length === 0) return;
    let newIndex = selectedIndex + 1;
    if (newIndex >= currentResults.length) newIndex = 0;
    setSelected(newIndex);
  }

  function executeSelected() {
    if (selectedIndex < 0 || selectedIndex >= currentResults.length) {
      // No item selected → perform Google search with current query
      const query = input.value.trim();
      if (query) searchGoogle(query);
      return;
    }

    const item = currentResults[selectedIndex];
    switch (item.type) {
      case "tab":
        switchToTab(item.data);
        break;
      case "search":
      case "suggestion":
        searchGoogle(item.data);
        break;
    }
  }

  // ----------------------------------------------------------
  // 10. Actions
  // ----------------------------------------------------------
  function switchToTab(tab) {
    chrome.runtime.sendMessage({
      action: "switch-tab",
      tabId: tab.id,
      windowId: tab.windowId,
    });
    closeSpotlight();
  }

  function searchGoogle(query) {
    window.open(
      `https://www.google.com/search?q=${encodeURIComponent(query)}`,
      "_blank",
    );
    closeSpotlight();
  }

  // ----------------------------------------------------------
  // 11. Keyboard navigation event listener
  // ----------------------------------------------------------
  document.addEventListener(
    "keydown",
    (e) => {
      // Ctrl+Q — Toggle
      if (
        e.ctrlKey &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "q"
      ) {
        e.preventDefault();
        e.stopPropagation();
        toggleSpotlight();
        return;
      }

      // Key handlers active only when spotlight is opened
      if (!root.classList.contains("active")) return;

      // Escape — Close
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeSpotlight();
        return;
      }

      // Arrow keys — Navigation
      if (e.key === "ArrowDown") {
        isKeyboardNavigating = true;
        e.preventDefault();
        e.stopPropagation();
        navigateDown();
        return;
      }
      if (e.key === "ArrowUp") {
        isKeyboardNavigating = true;
        e.preventDefault();
        e.stopPropagation();
        navigateUp();
        return;
      }

      // Enter — Execute selection
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        executeSelected();
        return;
      }
    },
    true,
  );

  // ----------------------------------------------------------
  // 12. Input event handler — filter results
  // ----------------------------------------------------------
  input.addEventListener("input", () => {
    const query = input.value.trim();
    renderResults(query);
  });

  // ----------------------------------------------------------
  // 13. Mouse Drag Activation Gesture (drag down)
  // ----------------------------------------------------------
  const DRAG_THRESHOLD = 80;
  let isDragging = false;
  let dragStartY = 0;
  let gestureTriggered = false;

  document.addEventListener(
    "mousedown",
    (e) => {
      if (root.classList.contains("active")) return;
      // Right-click only (button === 2) to avoid conflict with text selection or left-click dragging
      if (e.button !== 2) return;
      isDragging = true;
      gestureTriggered = false;
      dragStartY = e.clientY;
    },
    true,
  );

  document.addEventListener(
    "mousemove",
    (e) => {
      // Reset keyboard navigation status only when mouse physically moves (coordinates change)
      if (e.clientX !== lastMouseX || e.clientY !== lastMouseY) {
        isKeyboardNavigating = false;
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
      }

      if (!isDragging || gestureTriggered) return;
      if (e.clientY - dragStartY > DRAG_THRESHOLD) {
        gestureTriggered = true;
        isDragging = false;
        openSpotlight();
      }
    },
    true,
  );

  document.addEventListener(
    "mouseup",
    () => {
      isDragging = false;
    },
    true,
  );

  document.addEventListener(
    "contextmenu",
    (e) => {
      if (gestureTriggered) {
        e.preventDefault();
        e.stopPropagation();
        gestureTriggered = false;
      }
    },
    true,
  );

  // ----------------------------------------------------------
  // 14. Click backdrop to close
  // ----------------------------------------------------------
  backdrop.addEventListener("click", () => closeSpotlight());

  root.querySelector(".spotlight-container").addEventListener("click", (e) => {
    e.stopPropagation();
  });

  // ----------------------------------------------------------
  // 15. Listen for messages from background service worker
  // ----------------------------------------------------------
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.action === "toggle-spotlight") {
      toggleSpotlight();
    }
    // Background requests closing (single-instance management: tab switched)
    if (message?.action === "close-spotlight") {
      closeSpotlight();
    }
  });
})();

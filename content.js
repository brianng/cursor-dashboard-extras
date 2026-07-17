(() => {
  // ---------------------------------------------------------------------------
  // Config

  const WIDGET_ID = "cursor-usage-pace";
  const USAGE_EVENT_CARD_CLASS = "cursor-usage-event-card";
  const USAGE_EVENT_INSPECTED_ROW_CLASS = "cursor-usage-event-row--inspected";
  const USAGE_SUMMARY_URL = "/api/usage-summary";
  const USAGE_EVENTS_URL = "/api/dashboard/get-filtered-usage-events";

  const DAY_MS = 24 * 60 * 60 * 1000;

  const ENDPOINT_CACHE_MS = 60 * 1000;
  const UPDATE_DELAY_MS = 250;

  const USAGE_EVENT_TIMESTAMP_MATCH_MS = 2500;
  /** First data cell per row; committed to ARIA `cell` on current `/dashboard/usage` (change if Cursor drops roles). */
  const USAGE_ROW_CELL_SEL = '[role="cell"]';

  /**
   * Nearest interactive ancestor that should swallow row clicks (`findUsageEventRow` returns null).
   * Order matters when one element matches multiple selectors (e.g. put `button` before `[role="button"]`).
   *
   * Evidence (interactive-descendants-scan): usage rows currently have no such descendants - leave empty.
   * If Cursor adds in-row links or controls, add entries and verify row clicks still open the panel.
   */
  const USAGE_ROW_INTERACTIVE_GUARD_BRANCHES = [];

  /**
   * `span[title]` on usage rows, e.g. `Jul 16, 2026, 11:46:55 PM UTC` (current) or
   * `July 16, 2026, 3:45:30 PM PDT` (legacy local). Long month names are listed before
   * abbreviations so `June` does not partially match `Jun`.
   */
  const DASHBOARD_TITLE_DATETIME_RE =
    /^(January|February|March|April|June|July|August|September|October|November|December|May|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),\s*(\d{4}),\s*(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)(?:\s+(\S+))?/i;

  const DASHBOARD_TITLE_MONTH_INDEX = {
    january: 0,
    jan: 0,
    february: 1,
    feb: 1,
    march: 2,
    mar: 2,
    april: 3,
    apr: 3,
    may: 4,
    june: 5,
    jun: 5,
    july: 6,
    jul: 6,
    august: 7,
    aug: 7,
    september: 8,
    sep: 8,
    october: 9,
    oct: 9,
    november: 10,
    nov: 10,
    december: 11,
    dec: 11,
  };

  // ---------------------------------------------------------------------------
  // Module state

  let updateTimer = null;
  let spendingObserver = null;
  let endpointRequest = null;
  let endpointInfo = null;
  let endpointInfoFetchedAt = 0;

  let usageEventsRequest = null;
  let usageEventsCache = null;
  let activeUsageEventRow = null;
  let activeUsageEventCardHost = null;

  // ---------------------------------------------------------------------------
  // Shared utilities

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  // ---------------------------------------------------------------------------
  // Usage pace: API

  function createEmptyUsagePaceInfo() {
    return {
      auto: { current: null, budget: null },
      api: { current: null, budget: null },
    };
  }

  function getElapsedDays(billingCycleStart) {
    const startTime = new Date(billingCycleStart).getTime();

    if (!Number.isFinite(startTime)) {
      return null;
    }

    return Math.max(1, (Date.now() - startTime) / DAY_MS);
  }

  function getDaysRemaining(billingCycleEnd) {
    const endTime = new Date(billingCycleEnd).getTime();

    if (!Number.isFinite(endTime)) {
      return null;
    }

    return Math.max(0, Math.ceil((endTime - Date.now()) / DAY_MS));
  }

  function computeCurrentPace(percentUsed, elapsedDays) {
    if (!Number.isFinite(percentUsed) || !Number.isFinite(elapsedDays)) {
      return null;
    }

    return percentUsed / elapsedDays;
  }

  function computeBudgetPace(percentUsed, daysRemaining) {
    if (!Number.isFinite(percentUsed) || !Number.isFinite(daysRemaining) || daysRemaining <= 0) {
      return null;
    }

    return Math.max(0, 100 - percentUsed) / daysRemaining;
  }

  function parseUsageSummary(summary) {
    const info = createEmptyUsagePaceInfo();

    if (summary == null || typeof summary !== "object") {
      return info;
    }

    if (!summary.individualUsage || !summary.individualUsage.plan) {
      return info;
    }

    const plan = summary.individualUsage.plan;
    const elapsedDays = getElapsedDays(summary.billingCycleStart);
    const daysRemaining = getDaysRemaining(summary.billingCycleEnd);
    const autoUsedPercent = Number(plan.autoPercentUsed);
    const apiUsedPercent = Number(plan.apiPercentUsed);

    info.auto.current = computeCurrentPace(autoUsedPercent, elapsedDays);
    info.auto.budget = computeBudgetPace(autoUsedPercent, daysRemaining);
    info.api.current = computeCurrentPace(apiUsedPercent, elapsedDays);
    info.api.budget = computeBudgetPace(apiUsedPercent, daysRemaining);

    return info;
  }

  async function fetchUsageSummaryInfo() {
    if (endpointInfo && Date.now() - endpointInfoFetchedAt < ENDPOINT_CACHE_MS) {
      return endpointInfo;
    }

    if (!endpointRequest) {
      endpointRequest = fetch(USAGE_SUMMARY_URL, {
        credentials: "same-origin",
        cache: "no-store",
      })
        .then((response) => {
          if (!response.ok) {
            throw new Error(`Usage summary request failed: ${response.status}`);
          }

          return response.json();
        })
        .then((summary) => {
          endpointInfo = parseUsageSummary(summary);
          endpointInfoFetchedAt = Date.now();

          return endpointInfo;
        })
        .catch(() => {
          if (endpointInfo && Date.now() - endpointInfoFetchedAt < ENDPOINT_CACHE_MS) {
            return endpointInfo;
          }

          return createEmptyUsagePaceInfo();
        })
        .finally(() => {
          endpointRequest = null;
        });
    }

    return endpointRequest;
  }

  // ---------------------------------------------------------------------------
  // Usage pace: widget UI + update loop

  function formatPercent(value, options) {
    return new Intl.NumberFormat(undefined, {
      maximumFractionDigits: options.maximumFractionDigits,
      minimumFractionDigits: options.minimumFractionDigits,
    }).format(value);
  }

  function formatPaceCellHtml(value) {
    const unit = '<span class="cursor-usage-pace__unit">%</span>';

    if (value === null || !Number.isFinite(value)) {
      return `?.?${unit}`;
    }

    const figure = formatPercent(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

    return `${figure}${unit}`;
  }

  function renderWidget(info) {
    let widget = document.getElementById(WIDGET_ID);

    if (!widget) {
      widget = document.createElement("aside");
      widget.id = WIDGET_ID;
      widget.setAttribute("aria-live", "polite");
      document.body.appendChild(widget);
    }

    widget.innerHTML = `
      <div class="cursor-usage-pace__eyebrow">Daily Usage Pace</div>
      <div class="cursor-usage-pace__grid">
        <div class="cursor-usage-pace__colhead" aria-hidden="true"></div>
        <div class="cursor-usage-pace__colhead">1P</div>
        <div class="cursor-usage-pace__colhead">API</div>
        <div class="cursor-usage-pace__rowlabel">Current</div>
        <strong class="cursor-usage-pace__value">${formatPaceCellHtml(info.auto.current)}</strong>
        <strong class="cursor-usage-pace__value">${formatPaceCellHtml(info.api.current)}</strong>
        <div class="cursor-usage-pace__rowlabel">Budget</div>
        <strong class="cursor-usage-pace__value">${formatPaceCellHtml(info.auto.budget)}</strong>
        <strong class="cursor-usage-pace__value">${formatPaceCellHtml(info.api.budget)}</strong>
      </div>
    `;
  }

  function removeWidget() {
    const widget = document.getElementById(WIDGET_ID);

    if (widget) {
      widget.remove();
    }
  }

  async function updateWidget() {
    updateTimer = null;

    if (!isSpendingDashboardPath()) {
      removeWidget();
      return;
    }

    let info = createEmptyUsagePaceInfo();

    try {
      info = await fetchUsageSummaryInfo();
    } catch {
    }

    if (!isSpendingDashboardPath()) {
      removeWidget();
      return;
    }

    renderWidget(info);
  }

  function scheduleUpdate() {
    if (updateTimer) {
      clearTimeout(updateTimer);
    }

    updateTimer = setTimeout(updateWidget, UPDATE_DELAY_MS);
  }

  function shouldIgnoreMutations(mutations) {
    return mutations.every((mutation) => {
      const target = mutation.target;

      return target instanceof Element && target.closest(`#${WIDGET_ID}`);
    });
  }

  // ---------------------------------------------------------------------------
  // Usage pace: route + observer (SPA)

  function isSpendingDashboardPath() {
    return document.location.pathname.startsWith("/dashboard/spending");
  }

  function isUsageDashboardPath() {
    return document.location.pathname.startsWith("/dashboard/usage");
  }

  function onDashboardNavCapture(event) {
    if (!(event.target instanceof Element)) {
      return;
    }

    const anchor = event.target.closest("a[href]");

    if (!anchor) {
      return;
    }

    const href = anchor.getAttribute("href");

    if (href === null || href === "") {
      return;
    }

    let url;

    try {
      url = new URL(href, location.href);
    } catch {
      return;
    }

    if (isSpendingDashboardPath()) {
      if (url.origin !== location.origin || !url.pathname.startsWith("/dashboard/spending")) {
        teardownSpendingPace();
      }
    }

    if (
      url.origin === location.origin &&
      (url.pathname.startsWith("/dashboard/usage") || url.pathname.startsWith("/dashboard/spending"))
    ) {
      setTimeout(syncDashboardRoute, 0);
    }
  }

  function teardownSpendingPace() {
    if (updateTimer) {
      clearTimeout(updateTimer);
      updateTimer = null;
    }

    removeWidget();

    if (spendingObserver) {
      spendingObserver.disconnect();
    }

    spendingObserver = null;
  }

  function setupSpendingPace() {
    scheduleUpdate();

    if (spendingObserver) {
      spendingObserver.disconnect();
    }
    spendingObserver = new MutationObserver((mutations) => {
      if (!shouldIgnoreMutations(mutations)) {
        scheduleUpdate();
      }
    });
    spendingObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function syncDashboardRoute() {
    if (isSpendingDashboardPath()) {
      setupSpendingPace();
    } else {
      teardownSpendingPace();
    }
  }

  // ---------------------------------------------------------------------------
  // Usage page: fetch events

  async function fetchUsageEvents() {
    if (usageEventsCache) {
      return usageEventsCache;
    }

    if (usageEventsRequest) {
      return usageEventsRequest;
    }

    const endDate = Date.now();
    const startDate = endDate - 30 * DAY_MS;
    usageEventsRequest = fetch(USAGE_EVENTS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({
        teamId: 0,
        startDate: String(startDate),
        endDate: String(endDate),
        page: 1,
        pageSize: 100,
      }),
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Usage events request failed: ${response.status}`);
        }

        return response.json();
      })
      .then((usageEventsResponse) => {
        const { usageEventsDisplay } = usageEventsResponse;

        if (!Array.isArray(usageEventsDisplay)) {
          throw new Error("usage events response missing usageEventsDisplay array");
        }

        usageEventsCache = usageEventsDisplay;

        return usageEventsCache;
      })
      .finally(() => {
        usageEventsRequest = null;
      });

    return usageEventsRequest;
  }

  // ---------------------------------------------------------------------------
  // Usage page: row discovery + timestamp match

  function getUsageDomRoot() {
    const main = document.querySelector("main");

    return { root: main, key: main ? "main" : "missing-main" };
  }

  function getUsageHeaderRowSignals(row) {
    const hasColumnHeader = Boolean(row.querySelector('[role="columnheader"]'));

    return { hasColumnHeader };
  }

  function isLikelyUsageHeaderRow(row) {
    return getUsageHeaderRowSignals(row).hasColumnHeader;
  }

  function getUsageEventRows() {
    const { root } = getUsageDomRoot();

    if (!root) {
      return [];
    }

    return Array.from(root.querySelectorAll('[role="row"]')).filter((row) => !isLikelyUsageHeaderRow(row));
  }

  /**
   * If `USAGE_ROW_INTERACTIVE_GUARD_BRANCHES` is non-empty, returns which branch matched `target.closest(...)`.
   * Uses one combined selector for correct `closest` semantics; resolves branch with `matches` in array order.
   */
  function findUsageInteractiveGuardHit(target) {
    if (!(target instanceof Element)) {
      return null;
    }

    const branches = USAGE_ROW_INTERACTIVE_GUARD_BRANCHES;

    if (!branches.length) {
      return null;
    }

    const combinedSelector = branches.map((b) => b.selector).join(", ");
    const el = target.closest(combinedSelector);

    if (!el) {
      return null;
    }

    const branch = branches.find((b) => el.matches(b.selector));

    return {
      branchId: branch ? branch.id : "unknown",
      element: el,
    };
  }

  function findUsageEventRow(target) {
    if (!(target instanceof Element)) {
      return null;
    }

    const guardHit = findUsageInteractiveGuardHit(target);

    if (guardHit) {
      return null;
    }

    const row = target.closest('[role="row"]');

    if (!row) {
      return null;
    }

    if (!getUsageEventRows().includes(row)) {
      return null;
    }

    return row;
  }

  function parseDashboardTitleWallTimeToMs(trimmed) {
    const m = DASHBOARD_TITLE_DATETIME_RE.exec(trimmed);

    if (!m) {
      return null;
    }

    const monthIndex = DASHBOARD_TITLE_MONTH_INDEX[m[1].toLowerCase()];

    if (monthIndex === undefined) {
      return null;
    }

    const day = Number(m[2]);
    const year = Number(m[3]);
    let hour = Number(m[4]);
    const minute = Number(m[5]);
    const second = Number(m[6]);
    const meridiem = m[7].toUpperCase();
    const useUtc = m[8]?.toUpperCase() === "UTC";

    if (
      !Number.isFinite(day) ||
      !Number.isFinite(year) ||
      !Number.isFinite(hour) ||
      !Number.isFinite(minute) ||
      !Number.isFinite(second)
    ) {
      return null;
    }

    if (meridiem === "PM" && hour !== 12) {
      hour += 12;
    } else if (meridiem === "AM" && hour === 12) {
      hour = 0;
    }

    if (useUtc) {
      const t = Date.UTC(year, monthIndex, day, hour, minute, second);

      if (!Number.isFinite(t)) {
        return null;
      }

      const d = new Date(t);

      if (
        d.getUTCFullYear() !== year ||
        d.getUTCMonth() !== monthIndex ||
        d.getUTCDate() !== day
      ) {
        return null;
      }

      return t;
    }

    const d = new Date(year, monthIndex, day, hour, minute, second);

    if (
      d.getFullYear() !== year ||
      d.getMonth() !== monthIndex ||
      d.getDate() !== day
    ) {
      return null;
    }

    const t = d.getTime();

    return Number.isFinite(t) ? t : null;
  }

  function parseDashboardDatetimeTitleToMs(title) {
    if (title == null) {
      return null;
    }

    const trimmed = String(title).trim();

    if (!trimmed) {
      return null;
    }

    return parseDashboardTitleWallTimeToMs(trimmed);
  }

  function getFirstDataCellTitleTrimmed(row) {
    const firstCell = row.querySelector(USAGE_ROW_CELL_SEL);

    if (!firstCell) {
      return null;
    }

    const titleSpan = firstCell.querySelector("span[title]");

    if (!titleSpan) {
      return null;
    }

    const titleAttr = titleSpan.getAttribute("title");

    if (titleAttr === null || !titleAttr.trim()) {
      return null;
    }

    return titleAttr.trim();
  }

  function parseRowUsageTimestampMs(row) {
    const trimmed = getFirstDataCellTitleTrimmed(row);

    if (trimmed === null) {
      return null;
    }

    return parseDashboardDatetimeTitleToMs(trimmed);
  }

  function getRowModelHint(row) {
    for (const span of row.querySelectorAll("span[title]")) {
      const raw = span.getAttribute("title");

      if (raw === null) {
        continue;
      }

      const t = raw.trim();

      if (!t || /included/i.test(t) || parseDashboardDatetimeTitleToMs(t) !== null) {
        continue;
      }

      if (/^[\w.-]+$/.test(t)) {
        return t;
      }
    }

    return "";
  }

  function pickUsageEventForRow(row, usageEvents, rowMs) {
    if (!usageEvents.length) {
      return null;
    }

    let bestDelta = Infinity;
    const tied = [];

    for (const event of usageEvents) {
      const evMs = Number(event.timestamp);

      if (!Number.isFinite(evMs)) {
        continue;
      }

      const delta = Math.abs(evMs - rowMs);

      if (delta > USAGE_EVENT_TIMESTAMP_MATCH_MS) {
        continue;
      }

      if (delta < bestDelta) {
        bestDelta = delta;
        tied.length = 0;
        tied.push(event);
      } else if (delta === bestDelta) {
        tied.push(event);
      }
    }

    if (!tied.length) {
      return null;
    }

    if (tied.length === 1) {
      return tied[0];
    }

    const modelHint = getRowModelHint(row);

    if (modelHint) {
      const byModel = tied.find((e) => e.model === modelHint);

      if (byModel) {
        return byModel;
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Usage page: detail card UI + click handler

  function formatTokenCount(value) {
    const n = Number(value);

    if (!Number.isFinite(n)) {
      return "—";
    }

    return new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 0,
    }).format(n);
  }

  function formatCostFromCents(cents) {
    const n = Number(cents);

    if (!Number.isFinite(n)) {
      return "—";
    }

    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n / 100);
  }

  function getUsageEventCostCents(usageEvent) {
    const total = Number(usageEvent.tokenUsage.totalCents);

    return Number.isFinite(total) ? total : null;
  }

  function buildUsageEventSummaryHtml(usageEvent) {
    const tu = usageEvent.tokenUsage;
    const cost = formatCostFromCents(getUsageEventCostCents(usageEvent));
    const cacheWriteRaw = Number(tu.cacheWriteTokens);
    const cacheWrite = Number.isFinite(cacheWriteRaw) ? cacheWriteRaw : 0;

    const fields = [
      ["Cache Read", formatTokenCount(tu.cacheReadTokens)],
      ["Cache write", formatTokenCount(cacheWrite)],
      ["Input", formatTokenCount(tu.inputTokens)],
      ["Output", formatTokenCount(tu.outputTokens)],
      ["Cost", cost],
    ];
    const body = fields
      .map(
        ([label, value]) => `
          <div class="cursor-usage-event-card__field">
            <dt>${label}</dt>
            <dd>${escapeHtml(value)}</dd>
          </div>`,
      )
      .join("");

    return `<dl class="cursor-usage-event-card__fields">${body}</dl>`;
  }

  function clearUsageEventCard() {
    if (activeUsageEventRow) {
      activeUsageEventRow.classList.remove(USAGE_EVENT_INSPECTED_ROW_CLASS);
    }

    removeUsageEventCardHost();
    activeUsageEventRow = null;
  }

  function removeUsageEventCardHost() {
    if (activeUsageEventCardHost) {
      activeUsageEventCardHost.remove();
    }

    activeUsageEventCardHost = null;
  }

  function renderUsageEventCard(row, content) {
    if (activeUsageEventRow === row) {
      removeUsageEventCardHost();
    } else {
      clearUsageEventCard();
    }

    const card = document.createElement("aside");
    card.className = USAGE_EVENT_CARD_CLASS;
    card.setAttribute("aria-live", "polite");
    card.innerHTML = content;

    const parent = row.parentElement;

    if (!parent) {
      throw new Error("usage row has no parentElement");
    }

    parent.insertBefore(card, row.nextSibling);
    activeUsageEventCardHost = card;

    row.classList.add(USAGE_EVENT_INSPECTED_ROW_CLASS);
    activeUsageEventRow = row;
  }

  function renderUsageEventStatusCard(row, message) {
    renderUsageEventCard(
      row,
      `
        <div class="cursor-usage-event-card__status">${escapeHtml(message)}</div>
      `,
    );
  }

  function renderUsageEventDataCard(row, usageEvent) {
    renderUsageEventCard(
      row,
      `
        ${buildUsageEventSummaryHtml(usageEvent)}
        <div class="cursor-usage-event-card__json-scroll">
          <pre>${escapeHtml(JSON.stringify(usageEvent, null, 2))}</pre>
        </div>
      `,
    );
  }

  async function handleUsageEventRowClick(event) {
    const row = findUsageEventRow(event.target);

    if (!row) {
      return;
    }

    if (activeUsageEventRow === row) {
      clearUsageEventCard();
      return;
    }

    clearUsageEventCard();
    row.classList.add(USAGE_EVENT_INSPECTED_ROW_CLASS);
    activeUsageEventRow = row;

    const rowMs = parseRowUsageTimestampMs(row);

    if (rowMs === null) {
      renderUsageEventStatusCard(row, "Could not read a timestamp from this row.");
      return;
    }

    let usageEvents;

    try {
      usageEvents = await fetchUsageEvents();
    } catch (err) {
      if (activeUsageEventRow !== row) {
        return;
      }

      const message = String(err);
      renderUsageEventStatusCard(row, message);
      return;
    }

    if (activeUsageEventRow !== row) {
      return;
    }

    const usageEvent = pickUsageEventForRow(row, usageEvents, rowMs);

    if (!usageEvent) {
      renderUsageEventStatusCard(
        row,
        "No single usage event matches this row (ambiguous time window or no API row).",
      );
      return;
    }

    renderUsageEventDataCard(row, usageEvent);
  }

  // ---------------------------------------------------------------------------
  // Bootstrap

  document.addEventListener("click", handleUsageEventRowClick);
  document.addEventListener("click", onDashboardNavCapture, true);

  syncDashboardRoute();
  window.addEventListener("popstate", syncDashboardRoute);
})();

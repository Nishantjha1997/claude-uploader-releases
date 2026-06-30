# Claude Usage Analytics & ROI Dashboard — Implementation Plan

> **Goal:** Build a separate, standalone Google Apps Script web application that reads the `*_claude_daily.json` and `*_claude_session.json` files uploaded to Google Drive, aggregates the data, and presents a premium, management-grade executive dashboard for tracking Claude Code usage, API cost ROI, developer adoption, and license reclamation recommendations.

---

## 🔍 Verified Infrastructure & Data Schema

Through live testing of the active Google Drive shared folder (`0AMXBcPT9R10cUk9PVA`) and service account, we have mapped out the exact data schemas and infrastructure.

### Data Sources
*   **Google Drive Folder ID:** `0AMXBcPT9R10cUk9PVA`
*   **Developers Active:** 24+ registered developers currently uploading usage.
*   **File Naming Rules:** `FirstName_LastName_claude_daily.json` and `FirstName_LastName_claude_session.json`

### 1. Daily JSON Schema (`*_claude_daily.json`)
The daily files contain chronological, daily aggregated usage metrics:
```json
{
  "daily": [
    {
      "date": "2026-04-17",
      "inputTokens": 2410,
      "outputTokens": 43832,
      "cacheCreationTokens": 151388,
      "cacheReadTokens": 1551035,
      "totalTokens": 1748665,
      "totalCost": 1.3154,
      "modelsUsed": ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
      "modelBreakdowns": [
        {
          "modelName": "claude-sonnet-4-6",
          "inputTokens": 331,
          "outputTokens": 35221,
          "cacheCreationTokens": 100000,
          "cacheReadTokens": 1200000,
          "cost": 1.15
        }
        // ... per model breakdown
      ]
    }
  ],
  "totals": {
    "inputTokens": 85029,
    "outputTokens": 2134122,
    "cacheCreationTokens": 8900661,
    "cacheReadTokens": 303993834,
    "totalTokens": 315113646,
    "totalCost": 148.15
  }
}
```

### 2. Session JSON Schema (`*_claude_session.json`)
The session files contain per-project/instance aggregates, where the `sessionId` represents the project path or context:
```json
{
  "sessions": [
    {
      "sessionId": "F--SigmaSolve-NextDental-digital-case-service",
      "inputTokens": 14812,
      "outputTokens": 2055406,
      "cacheCreationTokens": 7108491,
      "cacheReadTokens": 287588996,
      "totalTokens": 296767705,
      "totalCost": 143.80,
      "lastActivity": "2026-05-26",
      "modelsUsed": ["claude-sonnet-4-6"],
      "modelBreakdowns": [
        {
          "modelName": "claude-sonnet-4-6",
          "inputTokens": 14812,
          "outputTokens": 2055406,
          "cacheCreationTokens": 7108491,
          "cacheReadTokens": 287588996,
          "cost": 143.80
        }
      ],
      "projectPath": "Unknown Project"
    }
  ],
  "totals": {
    "inputTokens": 150000,
    "outputTokens": 2500000,
    "cacheCreationTokens": 8000000,
    "cacheReadTokens": 300000000,
    "totalTokens": 310650000,
    "totalCost": 150.25
  }
}
```

---

## 🧠 Business Logic & Metric Calculations

To align perfectly with the executive report previously generated, the dashboard will implement the exact mathematical and logical models defined by management:

### 1. Value Scoring Engine
The **Overall Value Score (0–100)** determines the return-on-investment of a developer's Claude license:
*   **Chat Score (0-100):** Focuses on user-interactive CLI session depth.
*   **Code Score (0-100):** Measures raw token volume, active coding days, project diversity, and prompt efficiency relative to the team's top performer:
    *   **Token Usage (40% weight):** User's total tokens as a percentage of the highest user's tokens.
    *   **Days Active (30% weight):** User's active coding days as a percentage of the highest user's active days.
    *   **Project Diversity (20% weight):** Distinct project count as a percentage of the highest user's project count.
    *   **Prompt Efficiency (10% weight):** `outputTokens / (inputTokens + cacheCreationTokens)` (higher represents better reuse of prompt cache).
*   **Combined Value Score Formula:**
    $$\text{Overall Value} = \frac{\text{Chat Score} + \text{Code Score}}{2} + 10 \text{ bonus points (capped at 100)}$$
    *(For users active in both CLI Chat and Code).*

### 2. User Classifications
Based on usage intensity, users are partitioned into 5 mutually-exclusive management cohorts:
1.  ** Power User:** Active recently ($\le$ 30 days) AND meaningful Code activity ($\ge$ $10 cost OR $\ge$ 3 active days). Recommendation: **Keep (Full Value)**.
2.  ** Chat-Only Active:** Active chat sessions ($\ge$ 5 convos in last 30 days) AND no meaningful Code activity. Recommendation: **Keep + Encourage Code adoption**.
3.  **⚡ Code-Only Active:** Meaningful Code activity ($\ge$ $10 cost OR $\ge$ 3 active days) AND minimal chat. Recommendation: **Keep (Active developer)**.
4.  **⚠️ Low Engagement:** Some minor activity, but below thresholds in both channels. Recommendation: **Review (Training / Re-evaluate)**.
5.  **❌ Truly Inactive:** Zero chat and zero Code activity ever. Recommendation: **Remove (Reclaim license)**.

### 3. CRITICAL: Removal Protection Guard
> [!CAUTION]
> **Safety Rule:** A developer is **NEVER** recommended for removal if they have $\ge$ $10 in API-equivalent Code cost OR $\ge$ 3 Code active days, regardless of chat metrics. This prevents wrongly flagging developers who work silently via Claude Code but have minimal interactive chat engagement.

### 4. ROI Analytics (Subscription vs Value)
*   **Estimated Spend:** $20/month flat fee per license.
*   **API-Equivalent Value:** Calculated by converting raw token usage to commercial API rates (Sonnet, Opus, Haiku).
*   **ROI Index:**
    $$\text{ROI} = \frac{\text{API-Equivalent Value}}{\text{Subscription Cost}} \times 100\%$$
    *(An ROI > 100% means the developer is utilizing the license beyond its flat subscription cost, proving heavy adoption).*

### 5. Smart Project Name Formatter
Converts system-generated directory basenames to beautiful, human-readable titles:
*   `subagents` $\rightarrow$ `⚙ Background Helpers (subagents)`
*   `F--SigmaSolve-NextDental-digital-case-service` $\rightarrow$ `NextDental – Digital Case Service`
*   `f--SigmaSolve-NextDental-next-dental-lab-backend` $\rightarrow$ `NextDental – Lab Backend`
*   `F--SigmaSolve-Projects-dds-web` $\rightarrow$ `Projects – DDS Web`

---

## 🎨 Premium UI/UX Design System

The application will be styled as a premium, state-of-the-art **Glassmorphic Dark Theme** designed to wow management stakeholders:

*   **Color Palette (HSL Tailored):**
    *   *Background:* Deep Obsidian Space (`hsl(220, 24%, 6%)` to `hsl(222, 20%, 10%)` gradient).
    *   *Cards:* Semi-transparent glass (`rgba(30, 41, 59, 0.45)`) with HSL border-highlight (`rgba(255, 255, 255, 0.08)`) and intensive backdrop-blur (`30px`).
    *   *Accent Primaries:* Vibrant Cobalt Blue (`hsl(217, 91%, 60%)`), Neon Mint (`hsl(142, 70%, 45%)`), Amber (`hsl(38, 92%, 50%)`), and Coral Rose (`hsl(346, 84%, 61%)`).
*   **Typography:** Elegant sans-serif layout using Google Fonts **Inter** and **Outfit** for crisp numbers and premium headers.
*   **Layout:** Responsive flex-grid with an interactive floating sidebar navigation.
*   **SVG-Native Chart Engine:** High-performance, animated, pure-SVG charts drawn client-side (no external JS dependencies like Chart.js or Google Charts, making it completely immune to Apps Script Content Security Policy (CSP) blocking).

---

## 📁 Proposed Architecture & File Directory

The dashboard will be organized into 5 clean code modules inside a new, independent Google Apps Script project:

```text
├── Code.gs             # GAS backend: handles Drive scans, data caching, ROI aggregation, score math
├── Index.html          # WebApp shell: sidebar layout, page sections, modals, skeleton loaders
├── JavaScript.html     # Client logic: tab controller, search/sort, CSV export, pure SVG chart engine
├── Stylesheet.html     # Styling system: HSL variables, glassmorphism, flex grid, responsive media queries
└── appsscript.json     # Project manifest setting WebApp execution permissions
```

### Server-Side Data Aggregator Output
`Code.gs` will return a single, optimized JSON payload to the client on load:
```javascript
{
  orgSummary: {
    totalLicenses: 44,
    activeUsersCount: 24,
    licenseUtilization: 54.5, // %
    totalCodeCost: 4543.49,
    totalCodeTokens: 9553292643,
    overallCacheHitRate: 94.6, // %
    avgCostPerUser: 189.31,
    potentialSavings: 400.00 // USD/month
  },
  users: [
    {
      name: "Jaydeep Bodar",
      email: "jbodar@sigmasolve.com",
      category: " Power User",
      valueScore: 74.7,
      chatScore: 55.6,
      codeScore: 73.7,
      inputTokens: 85029,
      outputTokens: 2134122,
      cacheCreationTokens: 8900661,
      cacheReadTokens: 303993834,
      totalTokens: 315113646,
      codeCost: 148.15,
      activeDays: 18,
      distinctProjects: 5,
      lastActivity: "2026-05-26",
      primaryModel: "claude-sonnet-4-6",
      activityLevel: "Heavy",
      roiIndex: 740, // % (148.15 / 20 * 100)
      projects: [
        { name: "C – newproject-value-collaborator", cost: 143.80, lastActivity: "2026-05-26" }
      ]
    }
    // ... per developer
  ],
  projects: [
    { name: "NextDental – Digital Case Service", activeDevs: 4, sessions: 42, totalCost: 638.10 },
    { name: "⚙ Background Helpers (subagents)", activeDevs: 18, sessions: 412, totalCost: 1205.45 }
    // ... aggregated project roster
  ]
}
```

---

## 📊 Interactive WebApp Pages

### 📈 Page 1: Executive Dashboard (ROI & Licensing)
Designed specifically for leadership, showing organizational value metrics:
*   **KPI Card Strip:**
    *   *Total Commercial Spend vs API Value Created* (e.g. Spent: $880/mo vs Value: $4,543.49).
    *   *License Utilization & Wasted Licenses* (Alerting if seats are paid but unused).
    *   *Organization Cache Efficiency* (Highlights money saved through Anthropic prompt caching).
*   **Key Recommendations Block:**
    *   🔴 *"Remove 8 inactive licenses immediately to save $160/month ($1,920/year)."*
    *   🟡 *"Upgrade 4 light users with training to improve team adoption."*
*   **Interactive Org Charts:**
    *   *Daily Org Cost Trend* (SVG area line chart with gradient fill).
    *   *Model Cost Distribution* (Interactive donut chart showing Sonnet vs Opus vs Haiku).
    *   *Top 5 Spenders* (Horizontal bar chart showing heavy users).

### 👥 Page 2: Developer Leaderboard
A comprehensive, interactive developer roster:
*   **Interactive Table:**
    *   Columns: Developer Name, Category, Value Score, Code Cost ($), Active Days, Projects Worked, Cache Hit Rate, Last Active.
    *   Live search, category filters (e.g. show only "Truly Inactive" or "Power Users"), and descending/ascending sorting on every column.
    *   Inline Sparklines for individual cost trends.
*   **Detailed Developer Drilldown Modal:**
    *   Fires when clicking any row. Opens a beautiful overlay showing:
        1.  *Token Breakdown:* Stacked vertical bar chart showing Input vs Output vs Cache Read.
        2.  *Model Mix:* Cost split per model (showing if they utilize Haiku for cheap tasks and Opus for deep work).
        3.  *Project Roster:* Scrollable table of projects worked on.

### ⚙️ Page 3: Project Analytics
Analyzes engineering resource investments by project:
*   **Sortable Project Table:**
    *   Columns: Cleaned Project Title, Active Developer Count, Total Sessions, Total Tokens, Accumulated Cost ($), Last Active.
    *   Helps management identify which repos/products are receiving the most AI-assisted development.

### 📋 Page 4: License Optimization (Action Items)
The core cost-saving command center:
*   **Cleanup Candidates List:**
    *   Sorts all developers flagged as "Truly Inactive" or "Low Engagement".
    *   Shows a clear confidence rating (e.g. *99% Confidence — 0 active days, 0 tokens in 90 days*).
    *   Shows estimated monthly savings for removing them.
*   **Exclusion Guard Details:**
    *   Displays protected developers, indicating they are safe from cleanup due to high Claude Code usage.

### 💾 Page 5: Data Export
*   **CSV User Summary Download:** Click to instantly download a formatted spreadsheet summary.
*   **CSV Project Summary Download:** Click to download a summary of AI activity per repository.

---

## 🚀 Implementation & Deployment Steps

### Phase 1: Standalone Project Creation (Developer Local Machine)
1.  Initialize a new workspace folder `claude-usage-dashboard`.
2.  Create files: `Code.gs`, `Index.html`, `JavaScript.html`, `Stylesheet.html`, `appsscript.json`.
3.  Add the `service-account-key.json` key to the directory (configured for read-only Drive API).
4.  Configure `appsscript.json` with the required Apps Script Drive scopes (`drive.readonly`).

### Phase 2: Server-Side Logic (Code.gs)
1.  Implement OAuth token generator using the service account JWT.
2.  Implement Drive scanner scanning the shared folder (`0AMXBcPT9R10cUk9PVA`) for all daily/session files.
3.  Create parsing & aggregation routines (converting string paths to project names, calculating scores).
4.  Implement local script caching (`CacheService`) to speed up subsequent load times.

### Phase 3: Premium UI & Layouts (Index / Stylesheet)
1.  Write HTML layout skeleton with floating side-nav.
2.  Write glassmorphic dark-theme vanilla CSS with hover micro-animations.
3.  Write state-of-the-art inline SVG plotting functions for Area, Donut, and Bar charts.

### Phase 4: Client Logic & Integrations (JavaScript)
1.  Integrate client-side routing between dashboard tabs.
2.  Implement leaderboard searching, filtering, and column sorting.
3.  Write client-side CSV generator converting JSON arrays into immediate spreadsheet downloads.

### Phase 5: Verification & Production Push
1.  Deploy WebApp as a standalone production URL.
2.  Cross-verify calculations against the sample `Rajdeep_Chodvadiya` and `Jaydeep_Bodar` datasets.
3.  Test on desktop, tablet, and mobile displays to ensure responsive layout.

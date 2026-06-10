/**
 * standalone Claude Usage Analytics & ROI Dashboard — Code.gs
 * standalone Web App served via Google Apps Script.
 */

var SHARED_DRIVE_FOLDER_ID = '0AMXBcPT9R10cUk9PVA';
var LICENSE_COST_MONTHLY = 20.00; // Flat monthly fee in USD per user license
var CACHE_EXPIRATION_SECONDS = 1800; // Cache payload for 30 minutes to ensure fast loads

/**
 * Serves the HTML Web Application
 */
function doGet(e) {
  var template = HtmlService.createTemplateFromFile('Index');
  return template.evaluate()
    .setTitle('Claude Usage Analytics & ROI Dashboard')
    .setSandboxMode(HtmlService.SandboxMode.IFRAME)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
}

/**
 * Include helper to embed files in Index.html
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * Main dashboard API: returns aggregated, parsed data from Google Drive JSON files
 * @param {boolean} forceRefresh - If true, bypasses and clears CacheService
 */
function getDashboardData(forceRefresh) {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'claude_dashboard_data_v7';

  if (!forceRefresh) {
    var cached = getLargeCache(cache, cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (e) {
        // Fall through to live scan if cache parse fails
      }
    }
  }

  try {
    var data = performDriveScan();
    putLargeCache(cache, cacheKey, JSON.stringify(data), CACHE_EXPIRATION_SECONDS);
    return data;
  } catch (err) {
    return {
      error: true,
      message: err.toString(),
      stack: err.stack
    };
  }
}

/**
 * Clears dashboard cache including chunks
 */
function clearDashboardCache() {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'claude_dashboard_data_v7';
  
  try {
    var meta = cache.get(cacheKey + '_meta');
    if (meta) {
      var metaObj = JSON.parse(meta);
      for (var i = 0; i < metaObj.count; i++) {
        cache.remove(cacheKey + '_chunk_' + i);
      }
    }
    cache.remove(cacheKey + '_meta');
  } catch (e) {}
  
  cache.remove(cacheKey);
  return { success: true };
}

/**
 * Helper to cache large strings by splitting into chunks (GAS 100KB limit workaround)
 */
function putLargeCache(cache, key, value, expiration) {
  var limit = 80 * 1024; // 80 KB chunks
  var chunksCount = Math.ceil(value.length / limit);
  
  try {
    // Clear old chunks if any
    var oldMeta = cache.get(key + '_meta');
    if (oldMeta) {
      var oldMetaObj = JSON.parse(oldMeta);
      for (var i = 0; i < oldMetaObj.count; i++) {
        cache.remove(key + '_chunk_' + i);
      }
    }
    
    // Save new chunks
    for (var i = 0; i < chunksCount; i++) {
      var chunk = value.substring(i * limit, (i + 1) * limit);
      cache.put(key + '_chunk_' + i, chunk, expiration);
    }
    
    // Save metadata
    var meta = { count: chunksCount, totalLength: value.length };
    cache.put(key + '_meta', JSON.stringify(meta), expiration);
  } catch (e) {
    // Graceful fallback: silently ignore cache put errors and clear meta to prevent partial reads
    try {
      cache.remove(key + '_meta');
    } catch (clearErr) {}
  }
}

/**
 * Helper to reconstruct large strings from chunks
 */
function getLargeCache(cache, key) {
  try {
    var meta = cache.get(key + '_meta');
    if (!meta) return null;
    
    var metaObj = JSON.parse(meta);
    var value = '';
    for (var i = 0; i < metaObj.count; i++) {
      var chunk = cache.get(key + '_chunk_' + i);
      if (!chunk) return null; // If any chunk is missing, cache is invalid
      value += chunk;
    }
    return value;
  } catch (e) {
    return null;
  }
}

/**
 * Performs raw file scanning from Google Drive shared folder
 */
function performDriveScan() {
  var folder;
  try {
    folder = DriveApp.getFolderById(SHARED_DRIVE_FOLDER_ID);
  } catch (e) {
    throw new Error('Could not access Google Drive Shared Folder. Please make sure the folder ID is correct and you have access. Details: ' + e.message);
  }

  // Merge admin-managed REAL_PROJECTS extras (Script Properties) into the
  // in-code defaults so admins can promote a project name without redeploying.
  var extras = getProjectAllowlistExtras();
  for (var ei = 0; ei < extras.length; ei++) {
    if (REAL_PROJECTS.indexOf(extras[ei]) === -1) REAL_PROJECTS.push(extras[ei]);
  }

  // Restore getFiles() to guarantee Shared Drive root listing support, which is not supported by folder.searchFiles()
  var files = folder.getFiles();
  var developerFiles = {};

  // Step 1: Scan, grab content, and group files by developer name in a single loop
  while (files.hasNext()) {
    var file = files.next();
    var name = file.getName();
    
    // Safety check for trashed items in Shared Drive
    if (file.isTrashed()) continue;
    
    if (name.endsWith('_claude_daily.json') || name.endsWith('_claude_session.json')) {
      var isDaily = name.endsWith('_claude_daily.json');
      var namePart = name.replace(isDaily ? '_claude_daily.json' : '_claude_session.json', '');
      var formattedName = cleanDeveloperName(namePart);
      
      if (!developerFiles[formattedName]) {
        developerFiles[formattedName] = {
          name: formattedName,
          email: getEmailFromName(formattedName),
          dailyContent: null,
          sessionContent: null,
          dailyModified: null,
          sessionModified: null
        };
      }
      
      try {
        var content = file.getBlob().getDataAsString();
        var lastUpdated = file.getLastUpdated();
        
        if (isDaily) {
          developerFiles[formattedName].dailyContent = content;
          developerFiles[formattedName].dailyModified = lastUpdated;
        } else {
          developerFiles[formattedName].sessionContent = content;
          developerFiles[formattedName].sessionModified = lastUpdated;
        }
      } catch (err) {
        // Skip problematic files silently
      }
    }
  }

  var users = [];
  var projectAggregates = {};
  var modelBreakdownOrg = {};
  var dailyTimeSeriesMap = {};

  var maxCodeTokens = 0;
  var maxActiveDays = 0;
  var maxProjects = 0;

  // Step 2: Parse pre-fetched JSON files directly from memory (0 redundant Drive API calls)
  for (var devName in developerFiles) {
    var devInfo = developerFiles[devName];
    var dailyData = null;
    var sessionData = null;
    
    // 2a. Parse Daily JSON
    if (devInfo.dailyContent) {
      try {
        dailyData = JSON.parse(devInfo.dailyContent);
      } catch (e) {
        // Log parse error but keep going
      }
    }

    // 2b. Parse Session JSON
    if (devInfo.sessionContent) {
      try {
        sessionData = JSON.parse(devInfo.sessionContent);
      } catch (e) {
        // Log parse error
      }
    }

    // Skip users with no readable daily or session files
    if (!dailyData && !sessionData) continue;

    // 2c. Aggregate user metrics
    var totalCost = 0;
    var totalTokens = 0;
    var inputTokens = 0;
    var outputTokens = 0;
    var cacheCreationTokens = 0;
    var cacheReadTokens = 0;
    var activeDays = 0;
    var dailyList = [];
    var modelsUsedMap = {};
    var modelCostsMap = {};
    var lastActivity = '';
    var firstSeen = '';
    var userProjects = [];
    var userProjectsMap = {};
    var totalSessions = 0;
    var userSessionsList = [];
    // Per-day cost map for this user — drives period-aware ROI math
    // and the per-user mini-trends on the Trends page.
    var userDailyCostMap = {};

    // Process Daily Data
    if (dailyData) {
      var rawDaily = dailyData.daily || dailyData.day || [];
      dailyList = rawDaily;

      // Calculate totals if totals object is missing
      var totals = dailyData.totals || {};
      inputTokens = totals.inputTokens || 0;
      outputTokens = totals.outputTokens || 0;
      cacheCreationTokens = totals.cacheCreationTokens || 0;
      cacheReadTokens = totals.cacheReadTokens || 0;
      totalTokens = totals.totalTokens || (inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens);
      totalCost = totals.totalCost || totals.cost || 0;

      rawDaily.forEach(function(day) {
        var dateStr = normalizeDate(day.date || day.period || '');
        var dayCost = day.totalCost || day.cost || 0;
        var dayTokens = day.totalTokens || 0;
        // Only count a day as "active" when there's real activity (not a zero-row).
        var hasActivity = dayCost > 0 || dayTokens > 0;
        if (dateStr && hasActivity) {
          activeDays++;
          if (dateStr > lastActivity) lastActivity = dateStr;
          if (!firstSeen || dateStr < firstSeen) firstSeen = dateStr;

          userDailyCostMap[dateStr] = (userDailyCostMap[dateStr] || 0) + dayCost;

          // Timeseries mapping
          if (!dailyTimeSeriesMap[dateStr]) {
            dailyTimeSeriesMap[dateStr] = { date: dateStr, totalCost: 0, totalTokens: 0, devCount: 0, devs: {} };
          }
          dailyTimeSeriesMap[dateStr].totalCost += dayCost;
          dailyTimeSeriesMap[dateStr].totalTokens += dayTokens;
          if (!dailyTimeSeriesMap[dateStr].devs[devName]) {
            dailyTimeSeriesMap[dateStr].devs[devName] = true;
            dailyTimeSeriesMap[dateStr].devCount++;
          }
        }

        // Model usage mapping
        var models = day.modelsUsed || [];
        models.forEach(function(m) {
          modelsUsedMap[m] = (modelsUsedMap[m] || 0) + 1;
        });

        var modelBreakdowns = day.modelBreakdowns || [];
        modelBreakdowns.forEach(function(mb) {
          var modelName = mb.modelName || mb.name || '';
          if (modelName) {
            modelCostsMap[modelName] = (modelCostsMap[modelName] || 0) + (mb.cost || 0);

            if (!modelBreakdownOrg[modelName]) {
              modelBreakdownOrg[modelName] = { cost: 0, tokens: 0, sessions: 0, byDate: {} };
            }
            modelBreakdownOrg[modelName].cost += (mb.cost || 0);
            modelBreakdownOrg[modelName].tokens += (mb.inputTokens || 0) + (mb.outputTokens || 0) + (mb.cacheCreationTokens || 0) + (mb.cacheReadTokens || 0);
            // Time series for Models page stacked-area chart
            if (dateStr) {
              modelBreakdownOrg[modelName].byDate[dateStr] = (modelBreakdownOrg[modelName].byDate[dateStr] || 0) + (mb.cost || 0);
            }
          }
        });
      });
    }

    // Process Session Data
    var adhocSessionCount = 0;
    var realProjectSessionCount = 0;
    if (sessionData) {
      var rawSessions = sessionData.sessions || sessionData.session || [];
      totalSessions = rawSessions.length;

      rawSessions.forEach(function(session) {
        var rawProjName = session.sessionId || session.period || 'Unknown Project';
        var classified = classifyProject(rawProjName);
        var cleanProjName = classified.displayName;
        var projKind = classified.kind;
        if (projKind === 'adhoc') adhocSessionCount++;
        else if (projKind === 'project') realProjectSessionCount++;
        var sCost = session.totalCost || session.cost || 0;
        var sTokens = session.totalTokens || 0;
        var sLastActivity = normalizeDate((session.metadata && session.metadata.lastActivity) || session.lastActivity || '');

        if (sLastActivity && sLastActivity > lastActivity) {
          lastActivity = sLastActivity;
        }

        // Bug 7 fix: attribute session cost to model when only one model used
        if (session.modelsUsed && session.modelsUsed.length === 1 && sCost > 0) {
          var mName = session.modelsUsed[0];
          if (!modelBreakdownOrg[mName]) {
            modelBreakdownOrg[mName] = { cost: 0, tokens: 0, sessions: 0, byDate: {} };
          }
          modelBreakdownOrg[mName].cost += sCost;
          modelBreakdownOrg[mName].tokens += sTokens;
          modelBreakdownOrg[mName].sessions++;
          modelCostsMap[mName] = (modelCostsMap[mName] || 0) + sCost;
        }

        // Collect session detail for user profile
        userSessionsList.push({
          project: cleanProjName,
          date: sLastActivity,
          models: (session.modelsUsed || []).join(', '),
          cost: sCost,
          tokens: sTokens
        });

        // Add to user projects
        if (!userProjectsMap[cleanProjName]) {
          userProjectsMap[cleanProjName] = {
            name: cleanProjName,
            kind: projKind,
            cost: 0,
            tokens: 0,
            sessions: 0,
            lastActivity: sLastActivity
          };
        }
        userProjectsMap[cleanProjName].cost += sCost;
        userProjectsMap[cleanProjName].tokens += sTokens;
        userProjectsMap[cleanProjName].sessions++;
        if (sLastActivity && sLastActivity > userProjectsMap[cleanProjName].lastActivity) {
          userProjectsMap[cleanProjName].lastActivity = sLastActivity;
        }

        // Org project aggregates
        if (!projectAggregates[cleanProjName]) {
          projectAggregates[cleanProjName] = {
            name: cleanProjName,
            kind: projKind,
            activeDevs: {},
            devCount: 0,
            sessions: 0,
            totalCost: 0,
            totalTokens: 0,
            lastActivity: sLastActivity
          };
        }
        projectAggregates[cleanProjName].sessions++;
        projectAggregates[cleanProjName].totalCost += sCost;
        projectAggregates[cleanProjName].totalTokens += sTokens;
        projectAggregates[cleanProjName].activeDevs[devName] = true;
        if (sLastActivity && sLastActivity > projectAggregates[cleanProjName].lastActivity) {
          projectAggregates[cleanProjName].lastActivity = sLastActivity;
        }
      });

      // Flatten user projects
      for (var pKey in userProjectsMap) {
        userProjects.push(userProjectsMap[pKey]);
      }
    }

    // Distinct *real* project count — buckets (ad-hoc, demo, untitled, subagents)
    // do not count toward the project-diversity score.
    var realProjectCount = userProjects.filter(function(p) {
      return p.kind === 'project';
    }).length;

    // Input-side cache hit rate — denominator excludes output tokens (which
    // can never be cache reads). This is the industry-standard metric.
    var inputSideTokens = inputTokens + cacheCreationTokens + cacheReadTokens;
    var cacheHitRate = inputSideTokens > 0 ? (cacheReadTokens / inputSideTokens) * 100 : 0;
    var primaryModel = getPrimaryModelFromMap(modelsUsedMap);
    var activityLevel = activeDays >= 20 ? 'Heavy' : (activeDays >= 10 ? 'Moderate' : (activeDays >= 3 ? 'Light' : 'Minimal'));

    // Period-aware cost sums — computed after we know the global maxDate (see
    // post-loop section); stash raw daily map here for now.
    users.push({
      name: devName,
      email: devInfo.email,
      dailyModified: devInfo.dailyModified ? devInfo.dailyModified.toISOString() : null,
      sessionModified: devInfo.sessionModified ? devInfo.sessionModified.toISOString() : null,
      totalCost: totalCost,
      totalTokens: totalTokens,
      inputTokens: inputTokens,
      outputTokens: outputTokens,
      cacheCreationTokens: cacheCreationTokens,
      cacheReadTokens: cacheReadTokens,
      cacheHitRate: cacheHitRate,
      activeDays: activeDays,
      totalSessions: totalSessions,
      adhocSessions: adhocSessionCount,
      realProjectSessions: realProjectSessionCount,
      distinctProjects: realProjectCount,
      lastActivity: lastActivity || 'N/A',
      firstSeen: firstSeen || '',
      primaryModel: primaryModel,
      activityLevel: activityLevel,
      projects: userProjects,
      modelsUsed: Object.keys(modelsUsedMap),
      modelCostBreakdown: modelCostsMap,
      _dailyCostMap: userDailyCostMap, // private — used for period sums + per-user mini-trends, slimmed later
      dailyHistory: (dailyData ? (dailyData.daily || dailyData.day || []) : []).slice(-30).map(function(d) {
        return { date: normalizeDate(d.period || d.date || ''), cost: d.totalCost || d.cost || 0 };
      }),
      recentSessions: userSessionsList.slice().sort(function(a, b) {
        return (b.date || '').localeCompare(a.date || '');
      }).slice(0, 30)
    });

    // Update max metrics for normalized scoring
    if (totalTokens > maxCodeTokens) maxCodeTokens = totalTokens;
    if (activeDays > maxActiveDays) maxActiveDays = activeDays;
    if (realProjectCount > maxProjects) maxProjects = realProjectCount;
  }

  // Step 2.5: Determine the global reporting "anchor date" (the latest date
  // present anywhere in the org's daily data). Period windows are computed
  // relative to this anchor so dashboards stay coherent even if the most
  // recent uploader run is a few days behind real-time.
  var globalDateKeys = Object.keys(dailyTimeSeriesMap).sort();
  var anchorDate = globalDateKeys.length > 0 ? globalDateKeys[globalDateKeys.length - 1] : todayISTDate();
  var window30 = buildDateWindow(anchorDate, 30);
  var windowPrior30 = buildDateWindow(addDays(anchorDate, -30), 30);
  var thisMonthPrefix = anchorDate.substring(0, 7);

  // Per-user period sums + tenure-derived rank metrics
  var maxCost30d = 0;
  var maxOutputTokens = 0;
  users.forEach(function(user) {
    var costLast30d = 0;
    var costPriorPeriod = 0;
    var costThisMonth = 0;
    var activeDays30d = 0;
    var dailyMap = user._dailyCostMap || {};
    for (var d in dailyMap) {
      var c = dailyMap[d];
      if (window30.has[d]) { costLast30d += c; activeDays30d++; }
      if (windowPrior30.has[d]) costPriorPeriod += c;
      if (d.indexOf(thisMonthPrefix) === 0) costThisMonth += c;
    }
    user.costAllTime = user.totalCost || 0;
    user.costLast30d = costLast30d;
    user.costPriorPeriod = costPriorPeriod;
    user.costThisMonth = costThisMonth;
    user.activeDays30d = activeDays30d;
    user.costDeltaPct = costPriorPeriod > 0
      ? ((costLast30d - costPriorPeriod) / costPriorPeriod) * 100
      : (costLast30d > 0 ? 100 : 0);
    user.roiIndex = (costLast30d / LICENSE_COST_MONTHLY) * 100;

    user.tenureDays = user.firstSeen ? Math.max(0, daysBetween(user.firstSeen, anchorDate)) : 0;
    user.isNewHire = user.firstSeen && user.tenureDays < 14;

    if (costLast30d > maxCost30d) maxCost30d = costLast30d;
    if ((user.outputTokens || 0) > maxOutputTokens) maxOutputTokens = (user.outputTokens || 0);
  });

  // Minimum-denominator floors prevent a single-user team from auto-pinning
  // every component to 100. Floors roughly correspond to the "Light" tier.
  var floorCost30d = Math.max(maxCost30d, 20);
  var floorOutputTokens = Math.max(maxOutputTokens, 100000);
  var floorActiveDays = Math.max(maxActiveDays, 5);
  var floorProjects = Math.max(maxProjects, 2);

  // Step 3: Compute Scores, Categorization & Recommendations
  var activeUsersCount = 0;
  var totalCodeCost = 0;
  var totalCodeCost30d = 0;
  var totalCodeCostPrior = 0;
  var totalCodeTokens = 0;
  var wastedSavings = 0;

  users.forEach(function(user) {
    // 3a. Code Score (v2) — rewards outcome, not raw token volume.
    //   30 pts  cost-rank in last 30 days  (business value)
    //   30 pts  active-days                (consistency)
    //   20 pts  output-tokens rank          (artifact volume)
    //   10 pts  project-diversity
    //   10 pts  input-side cache hit rate
    var costRankScore = (user.costLast30d / floorCost30d) * 30;
    var activeDaysScore = (user.activeDays / floorActiveDays) * 30;
    var outputScore = ((user.outputTokens || 0) / floorOutputTokens) * 20;
    var projectDiversityScore = (user.distinctProjects / floorProjects) * 10;
    var cacheScore = ((user.cacheHitRate || 0) / 100) * 10;
    var codeScore = Math.min(100, Math.max(0,
      costRankScore + activeDaysScore + outputScore + projectDiversityScore + cacheScore
    ));
    user.codeScore = Math.round(codeScore * 10) / 10;

    // 3b. Ad-hoc Adoption Score (formerly Chat Score) — counts sessions
    // classified as the 'adhoc' bucket. Replaces v1's broken
    // totalSessions - distinctProjects formula. Field name kept as
    // chatScore for backward compatibility with existing UI.
    var adhocScore = user.adhocSessions > 0
      ? Math.min(100, (user.adhocSessions / 10) * 100)
      : 0;
    user.chatScore = Math.round(adhocScore * 10) / 10;

    // 3c. Value Score — asymmetric blend that rewards a strong primary
    // channel and adds a modest bonus for hybrid (code + ad-hoc) usage.
    // Replaces v1's (a+b)/2+10 formula where balance was penalized.
    var primary = Math.max(user.codeScore, user.chatScore);
    var secondary = Math.min(user.codeScore, user.chatScore);
    var overallValue = primary + secondary * 0.2;
    user.valueScore = Math.min(100, Math.round(overallValue * 10) / 10);

    // 3d. User Categorization (period-aware, tenure-aware)
    var isRecent = isRecentActivity(user.lastActivity, anchorDate);
    var hasCodeActivity = user.costLast30d >= 5.00 || user.activeDays30d >= 3;

    if (user.isNewHire) {
      user.category = '🌱 Onboarding';
      user.recommendation = 'New hire — give it 14 days before evaluating';
      activeUsersCount++;
    } else if (isRecent && hasCodeActivity) {
      user.category = '⭐ Power User';
      user.recommendation = 'Keep - Power user (Code + Ad-hoc)';
      activeUsersCount++;
    } else if (isRecent && user.totalSessions >= 5 && !hasCodeActivity) {
      user.category = '💬 Chat-Only Active';
      user.recommendation = 'Keep + Encourage Code adoption';
      activeUsersCount++;
    } else if (hasCodeActivity && !isRecent) {
      user.category = '⚡ Code-Only Active';
      user.recommendation = 'Keep - Active developer';
      activeUsersCount++;
    } else if (user.totalTokens > 0) {
      user.category = '⚠️ Low Engagement';
      user.recommendation = 'Review - Training or Re-evaluate';
      activeUsersCount++;
    } else {
      user.category = '❌ Truly Inactive';
      user.recommendation = 'Remove - Reclaim license';
      wastedSavings += LICENSE_COST_MONTHLY;
    }

    // Reclamation confidence — replaces v1's hard-coded "99% High / 80% Medium"
    user.reclamationConfidence = computeReclamationConfidence(user, anchorDate);

    // Slim the payload — the per-day map is only needed server-side.
    delete user._dailyCostMap;

    totalCodeCost += user.totalCost;
    totalCodeCost30d += user.costLast30d;
    totalCodeCostPrior += user.costPriorPeriod;
    totalCodeTokens += user.totalTokens;
  });

  // Step 4: Finalize Org and Project rosters
  var projectsList = [];
  for (var pName in projectAggregates) {
    var pData = projectAggregates[pName];
    projectsList.push({
      name: pData.name,
      kind: pData.kind || 'project',
      devCount: Object.keys(pData.activeDevs).length,
      devNames: Object.keys(pData.activeDevs),
      sessions: pData.sessions,
      totalCost: pData.totalCost,
      totalTokens: pData.totalTokens,
      lastActivity: pData.lastActivity
    });
  }

  // Build chronological timelines:
  // - dailyTimeSeries: last 90 days (Trends page needs the wider window)
  // - last30Series: the most recent 30 days (Executive Summary chart)
  // Padded with zero-rows where no activity. devs map is stripped before
  // returning to keep the payload slim.
  function buildSeriesEndingAt(endDateStr, lengthDays) {
    var out = [];
    for (var i = lengthDays - 1; i >= 0; i--) {
      var dateString = addDays(endDateStr, -i);
      if (dailyTimeSeriesMap[dateString]) {
        var d = dailyTimeSeriesMap[dateString];
        out.push({
          date: d.date,
          totalCost: d.totalCost,
          totalTokens: d.totalTokens,
          devCount: d.devCount
        });
      } else {
        out.push({ date: dateString, totalCost: 0, totalTokens: 0, devCount: 0 });
      }
    }
    return out;
  }
  var dailyTimeSeriesList = buildSeriesEndingAt(anchorDate, 90);
  var last30Series = dailyTimeSeriesList.slice(-30);

  // Convert modelBreakdown byDate maps to ordered arrays matching the 90-day window
  for (var mName in modelBreakdownOrg) {
    var mData = modelBreakdownOrg[mName];
    var byDateArr = [];
    for (var di = 0; di < dailyTimeSeriesList.length; di++) {
      var dStr = dailyTimeSeriesList[di].date;
      byDateArr.push({ date: dStr, cost: (mData.byDate && mData.byDate[dStr]) || 0 });
    }
    mData.byDateSeries = byDateArr;
    delete mData.byDate;
  }

  // Maximum uploader-file mtime across all developers — used by the client
  // to show a "newer data available" pill when the cached payload is stale.
  var maxFileMtimeMs = 0;
  for (var dName in developerFiles) {
    var di = developerFiles[dName];
    if (di.dailyModified && di.dailyModified.getTime() > maxFileMtimeMs) maxFileMtimeMs = di.dailyModified.getTime();
    if (di.sessionModified && di.sessionModified.getTime() > maxFileMtimeMs) maxFileMtimeMs = di.sessionModified.getTime();
  }

  var totalLicenses = users.length;
  var licenseUtilization = totalLicenses > 0 ? (activeUsersCount / totalLicenses) * 100 : 0;

  // Input-side cache hit rate (org-wide): denominator excludes output tokens.
  var orgInputSide = 0;
  var orgCacheRead = 0;
  users.forEach(function(u) {
    orgInputSide += (u.inputTokens || 0) + (u.cacheCreationTokens || 0) + (u.cacheReadTokens || 0);
    orgCacheRead += (u.cacheReadTokens || 0);
  });
  var overallCacheHitRate = orgInputSide > 0 ? (orgCacheRead / orgInputSide) * 100 : 0;

  // Period-aware ROI: lifetime ROI is misleading (grows with fleet history),
  // so the canonical KPI uses last 30 days. costAllTime is kept for reference.
  var roiIndex30d = (totalCodeCost30d / Math.max(totalLicenses * LICENSE_COST_MONTHLY, 1)) * 100;
  var costDeltaPct = totalCodeCostPrior > 0
    ? ((totalCodeCost30d - totalCodeCostPrior) / totalCodeCostPrior) * 100
    : (totalCodeCost30d > 0 ? 100 : 0);

  var orgSummary = {
    totalLicenses: totalLicenses,
    licenseMonthlyFee: LICENSE_COST_MONTHLY,
    flatSubscriptionSpend: totalLicenses * LICENSE_COST_MONTHLY,
    activeUsersCount: activeUsersCount,
    licenseUtilization: Math.round(licenseUtilization * 10) / 10,
    // costs
    totalCodeCost: totalCodeCost,          // lifetime
    totalCodeCost30d: totalCodeCost30d,    // current period (canonical KPI)
    totalCodeCostPrior: totalCodeCostPrior, // prior 30 days (for delta)
    costDeltaPct: costDeltaPct,
    roiIndex30d: roiIndex30d,
    totalCodeTokens: totalCodeTokens,
    overallCacheHitRate: overallCacheHitRate,
    avgCostPerUser30d: totalLicenses > 0 ? totalCodeCost30d / totalLicenses : 0,
    avgCostPerUser: totalLicenses > 0 ? totalCodeCost / totalLicenses : 0, // back-compat
    potentialSavings: wastedSavings,
    anchorDate: anchorDate,
    reportPeriod: {
      from: last30Series.length > 0 ? last30Series[0].date : 'N/A',
      to: last30Series.length > 0 ? last30Series[last30Series.length - 1].date : 'N/A',
      windowDays: 30
    },
    maxFileMtimeMs: maxFileMtimeMs,
    generatedTime: new Date().toISOString()
  };

  return {
    methodologyVersion: 'v2.0',
    orgSummary: orgSummary,
    users: users,
    projects: projectsList,
    modelBreakdowns: modelBreakdownOrg,
    dailyTimeSeries: dailyTimeSeriesList // 90 days
  };
}

/**
 * Bucket display names for non-project session activity
 */
var BUCKET_NAMES = {
  adhoc:     '💬 Ad-hoc CLI Sessions',
  demo:      '🧪 Demo / Sandbox Sessions',
  subagents: '⚙ Background Helpers (subagents)',
  untitled:  '📂 Untitled / Home Directory'
};

/**
 * Segments matching any of these classify the session as demo/sandbox usage,
 * not a real project. Compared case-insensitively against each path segment.
 */
var DEMO_KEYWORDS = [
  'demo', 'demos', 'sandbox', 'practice', 'practical', 'scratch',
  'test', 'tests', 'testing', 'tmp', 'temp', 'example', 'examples',
  'tutorial', 'playground', 'poc', 'experiment'
];

/**
 * Allowlist of repo / project name fragments that should ALWAYS classify
 * as real projects, even when the path looks short or ambiguous.
 * Match is case-insensitive substring against any path segment.
 * Extend this list as new real projects come online.
 */
var REAL_PROJECTS = [
  'nextdental',
  'sigmasolve',
  'claude-usage',
  'claude-code',
  'roi-dashboard',
  'usage-uploader',
  'gitcodecommit'
];

/**
 * Classify a raw ccusage session id into either a real project or a usage
 * bucket. Returns { kind, displayName }. Buckets collapse many sessions into
 * one aggregated row instead of polluting Project Analytics.
 */
function classifyProject(id) {
  if (!id) return { kind: 'untitled', displayName: BUCKET_NAMES.untitled };
  if (id === 'subagents') return { kind: 'subagents', displayName: BUCKET_NAMES.subagents };

  // Whole-string hex/UUID → ad-hoc CLI session
  var rawCleaned = id.replace(/[^a-zA-Z0-9]/g, '');
  if (rawCleaned.length >= 8 && /^[0-9a-fA-F]+$/.test(rawCleaned)) {
    return { kind: 'adhoc', displayName: BUCKET_NAMES.adhoc };
  }

  // Normalize path separators and drop drive-letter / empty segments
  var cleaned = id.replace(/\\/g, '-').replace(/\//g, '-').replace(/--/g, '-');
  var parts = cleaned.split('-').filter(function(p) {
    if (!p) return false;
    if (p.length === 1 && /[A-Za-z]/.test(p)) return false; // C, D, E, F drive letters
    return true;
  });

  if (parts.length === 0) {
    return { kind: 'untitled', displayName: BUCKET_NAMES.untitled };
  }

  var lowerParts = parts.map(function(p) { return p.toLowerCase(); });

  // Allowlist beats everything else — known real projects always win
  for (var i = 0; i < lowerParts.length; i++) {
    for (var j = 0; j < REAL_PROJECTS.length; j++) {
      if (lowerParts[i].indexOf(REAL_PROJECTS[j].toLowerCase()) !== -1) {
        return { kind: 'project', displayName: buildProjectDisplayName(parts) };
      }
    }
  }

  // Trailing-hex detection runs BEFORE demo keywords so that paths like
  // "tmp-claude-96cf-3225dbfcf35a" classify as ad-hoc (their tail is a UUID),
  // not as demo just because they contain "tmp".

  // Last 2 segments both look hex → ad-hoc (catches prefixed UUIDs like tmp-claude-96cf-3225dbfcf35a)
  if (parts.length >= 2) {
    var lastTwoConcat = parts.slice(-2).join('');
    if (lastTwoConcat.length >= 8 && /^[0-9a-fA-F]+$/.test(lastTwoConcat)) {
      return { kind: 'adhoc', displayName: BUCKET_NAMES.adhoc };
    }
  }
  // Single trailing hex-looking segment (≥8 chars) → ad-hoc
  var lastSeg = parts[parts.length - 1];
  if (/^[0-9a-fA-F]{8,}$/.test(lastSeg)) {
    return { kind: 'adhoc', displayName: BUCKET_NAMES.adhoc };
  }

  // Any demo/sandbox/test keyword as a substring of any segment → demo bucket
  // (substring match catches concatenated names like "PracticalDemo" or "salesdemo")
  for (var k = 0; k < lowerParts.length; k++) {
    for (var kk = 0; kk < DEMO_KEYWORDS.length; kk++) {
      if (lowerParts[k].indexOf(DEMO_KEYWORDS[kk]) !== -1) {
        return { kind: 'demo', displayName: BUCKET_NAMES.demo };
      }
    }
  }

  // Ambiguous short IDs (no allowlist match, no vowel, ≤4 chars per segment) → untitled bucket
  // This catches things like "Svc – Authz" that aren't real recognizable projects.
  if (!looksLikeProjectName(parts)) {
    return { kind: 'untitled', displayName: BUCKET_NAMES.untitled };
  }

  return { kind: 'project', displayName: buildProjectDisplayName(parts) };
}

/**
 * Heuristic for "real project" classification when there's no allowlist match.
 * Real ccusage session IDs come from a working-directory path like
 * "Users-john-projects-myapp-feature", which has ≥3 meaningful segments and
 * a recognizable trailing name. We require BOTH:
 *   1. At least 3 meaningful path segments (depth)
 *   2. The trailing segment is ≥5 chars with a vowel (looks pronounceable)
 *
 * This intentionally treats short 2-segment IDs like "Svc-Authz",
 * "AI-Agent", or "Anij-PracticalDemo" as untitled rather than guessing.
 * Promote them via the REAL_PROJECTS allowlist when confirmed.
 */
function looksLikeProjectName(parts) {
  if (parts.length < 3) return false;
  var last = parts[parts.length - 1];
  if (last.length < 5) return false;
  if (!/[aeiouAEIOU]/.test(last)) return false;
  return true;
}

function buildProjectDisplayName(parts) {
  if (parts.length >= 2) {
    var category = capitalizeWords(parts[parts.length - 2]);
    var name = capitalizeWords(parts[parts.length - 1]);
    return category + ' – ' + name;
  }
  return capitalizeWords(parts[0]);
}

/**
 * Back-compat shim — some callers may still want just the display string.
 */
function formatProjectName(id) {
  return classifyProject(id).displayName;
}

function capitalizeWords(str) {
  return str.replace(/\b\w/g, function(char) {
    return char.toUpperCase();
  });
}

function cleanDeveloperName(str) {
  if (!str) return 'UNKNOWN';
  // Replace underscores or dashes with spaces
  var cleaned = str.replace(/_/g, ' ').replace(/-/g, ' ');
  return capitalizeWords(cleaned);
}

function getEmailFromName(name) {
  if (!name) return 'developer@sigmasolve.com';
  // Format Amit Kadivar -> akadivar@sigmasolve.com
  var parts = name.split(' ');
  if (parts.length >= 2) {
    var first = parts[0].toLowerCase();
    var last = parts[parts.length - 1].toLowerCase();
    return first.charAt(0) + last + '@sigmasolve.com';
  }
  return name.toLowerCase() + '@sigmasolve.com';
}

function getPrimaryModelFromMap(modelMap) {
  var maxCount = 0;
  var primary = 'claude-sonnet-4-6'; // Default fallback
  
  for (var m in modelMap) {
    if (modelMap[m] > maxCount) {
      maxCount = modelMap[m];
      primary = m;
    }
  }
  return primary;
}

/**
 * Whether the given activity date is within the last 30 days *of the anchor*.
 * Anchor defaults to the org's most recent activity date so the gate stays
 * coherent even when the script wakes a few days after the last upload.
 * Day-diff is computed against IST midnight to avoid TZ off-by-one bugs.
 */
function isRecentActivity(dateStr, anchorDate) {
  if (!dateStr || dateStr === 'N/A') return false;
  var anchor = anchorDate || todayISTDate();
  var diff = daysBetween(dateStr, anchor);
  return diff !== null && diff >= 0 && diff <= 30;
}

/**
 * Today's date as YYYY-MM-DD in IST. Single source of TZ-aware "now".
 */
function todayISTDate() {
  return Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
}

/**
 * Normalize any date-ish string to YYYY-MM-DD. Accepts ISO timestamps,
 * raw date strings, or anything Date() can parse. Returns '' on failure.
 */
function normalizeDate(s) {
  if (!s) return '';
  if (typeof s !== 'string') return '';
  // Fast path: already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // ISO timestamp prefix
  var m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  try {
    var d = new Date(s);
    if (isNaN(d.getTime())) return '';
    return Utilities.formatDate(d, 'Asia/Kolkata', 'yyyy-MM-dd');
  } catch (e) {
    return '';
  }
}

/**
 * Add N days (can be negative) to a YYYY-MM-DD string, returning YYYY-MM-DD.
 * Uses noon-UTC anchoring to dodge DST drift.
 */
function addDays(dateStr, days) {
  var parts = dateStr.split('-');
  var d = new Date(Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), 12, 0, 0));
  d.setUTCDate(d.getUTCDate() + days);
  var y = d.getUTCFullYear();
  var mo = ('0' + (d.getUTCMonth() + 1)).slice(-2);
  var dy = ('0' + d.getUTCDate()).slice(-2);
  return y + '-' + mo + '-' + dy;
}

/**
 * Integer day-diff between two YYYY-MM-DD strings (b - a). Returns null on
 * parse failure. Both dates anchored at UTC noon to avoid DST drift.
 */
function daysBetween(a, b) {
  if (!a || !b) return null;
  var pa = a.split('-'), pb = b.split('-');
  if (pa.length !== 3 || pb.length !== 3) return null;
  var da = Date.UTC(parseInt(pa[0], 10), parseInt(pa[1], 10) - 1, parseInt(pa[2], 10), 12, 0, 0);
  var db = Date.UTC(parseInt(pb[0], 10), parseInt(pb[1], 10) - 1, parseInt(pb[2], 10), 12, 0, 0);
  return Math.round((db - da) / 86400000);
}

/**
 * Build a date window ending at endDate (inclusive) of `lengthDays` days.
 * Returns { dates: [YYYY-MM-DD], has: { 'YYYY-MM-DD': true } } for O(1) lookups.
 */
function buildDateWindow(endDate, lengthDays) {
  var out = { dates: [], has: {} };
  for (var i = lengthDays - 1; i >= 0; i--) {
    var d = addDays(endDate, -i);
    out.dates.push(d);
    out.has[d] = true;
  }
  return out;
}

/**
 * Reclamation confidence (0–100) — replaces v1's hard-coded "99% / 80%" labels.
 *   - Truly Inactive with no lifetime activity: 95–99 (high)
 *   - Truly Inactive but had historical activity: scales down with recency
 *   - Low Engagement (some recent activity): 30–60 (medium)
 *   - Anyone protected by isNewHire / hasCodeActivity gate: 0 (safe)
 */
function computeReclamationConfidence(user, anchorDate) {
  if (user.isNewHire) return 0;
  if (user.costLast30d >= 5.00 || user.activeDays30d >= 3) return 0;
  if (user.totalTokens === 0) return 99;
  var daysSince = daysBetween(user.lastActivity, anchorDate);
  if (daysSince === null) return 80;
  if (daysSince >= 60) return 90;
  if (daysSince >= 45) return 80;
  if (daysSince >= 30) return 65;
  if (user.costAllTime < 5) return 55;
  return 40;
}

/**
 * Gets the saved Slack/Google Chat webhook URL from script properties
 */
function getWebhookConfig() {
  var props = PropertiesService.getScriptProperties();
  return { webhookUrl: props.getProperty('alert_webhook_url') || '' };
}

/**
 * Saves a Slack/Google Chat webhook URL to script properties
 */
function setWebhookConfig(webhookUrl) {
  PropertiesService.getScriptProperties().setProperty('alert_webhook_url', webhookUrl || '');
  return { success: true };
}

/**
 * Sends a test alert to the configured webhook
 */
function sendTestAlert(webhookUrl) {
  var url = webhookUrl || getWebhookConfig().webhookUrl;
  if (!url) return { success: false, message: 'No webhook URL provided' };
  try {
    var payload = JSON.stringify({ text: '✅ *Test Alert from Claude Usage ROI Dashboard* — your webhook is configured correctly!' });
    var resp = UrlFetchApp.fetch(url, { method: 'POST', contentType: 'application/json', payload: payload, muteHttpExceptions: true });
    return { success: resp.getResponseCode() < 300, status: resp.getResponseCode() };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

/**
 * Sends a digest summary to the configured webhook
 */
function sendDigestAlert() {
  var url = getWebhookConfig().webhookUrl;
  if (!url) return { success: false, message: 'No webhook URL configured' };
  var data = getDashboardData(false);
  if (data.error) return { success: false, message: data.message };
  var s = data.orgSummary;
  // ROI uses the last 30-day cost (matches monthly subscription spend timescale)
  var roi = s.totalCodeCost30d > 0 && s.flatSubscriptionSpend > 0
    ? ((s.totalCodeCost30d / s.flatSubscriptionSpend) * 100).toFixed(0)
    : '—';
  var deltaStr = (s.costDeltaPct >= 0 ? '+' : '') + (s.costDeltaPct || 0).toFixed(0) + '% vs prior 30d';
  var wasted = Math.round((s.potentialSavings || 0) / LICENSE_COST_MONTHLY);
  var text = '*📊 Claude AI Weekly Digest — ' + Utilities.formatDate(new Date(), 'Asia/Kolkata', 'MMM d, yyyy') + '*\n' +
    '> 💰 API-Equivalent Cost (last 30d): *' + (s.totalCodeCost30d || 0).toFixed(2) + ' USD* (' + deltaStr + ')\n' +
    '> 🪙 Subscription Spend: *' + (s.flatSubscriptionSpend || 0).toFixed(2) + ' USD/mo*\n' +
    '> 👥 Active Developers: *' + s.activeUsersCount + ' / ' + s.totalLicenses + '* (' + s.licenseUtilization + '% utilization)\n' +
    '> 📈 ROI Index (30d): *' + roi + '%*\n' +
    (wasted > 0
      ? '> ⚠️ *' + wasted + ' inactive license(s)* — $' + (s.potentialSavings || 0).toFixed(0) + '/mo reclaimable\n'
      : '> ✅ No wasted licenses detected\n');
  try {
    var resp = UrlFetchApp.fetch(url, { method: 'POST', contentType: 'application/json', payload: JSON.stringify({ text: text }), muteHttpExceptions: true });
    return { success: resp.getResponseCode() < 300, status: resp.getResponseCode() };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

/**
 * Send a per-user re-engagement nudge via the configured webhook.
 * The dashboard surfaces a "Send nudge" button next to each reclamation
 * candidate; clicking it fires this function with the user's name.
 */
function sendUserNudge(userName, customMessage) {
  var url = getWebhookConfig().webhookUrl;
  if (!url) return { success: false, message: 'No webhook URL configured' };
  if (!userName) return { success: false, message: 'No user specified' };
  var msg = customMessage && customMessage.length > 0
    ? customMessage
    : 'we noticed you haven\'t used Claude Code in a while — is there anything we can help unblock? Reply here or DM your manager.';
  var text = '*👋 Hi ' + userName + '* — ' + msg + '\n' +
    '_(automated nudge from the Claude Usage ROI Dashboard, ' + todayISTDate() + ')_';
  try {
    var resp = UrlFetchApp.fetch(url, { method: 'POST', contentType: 'application/json', payload: JSON.stringify({ text: text }), muteHttpExceptions: true });
    var ok = resp.getResponseCode() < 300;
    if (ok) {
      // Record nudge timestamp so the dashboard can show "Last nudged: X ago"
      var props = PropertiesService.getScriptProperties();
      var key = 'nudge_log';
      var log = {};
      try { log = JSON.parse(props.getProperty(key) || '{}'); } catch (e) {}
      log[userName] = new Date().toISOString();
      props.setProperty(key, JSON.stringify(log));
    }
    return { success: ok, status: resp.getResponseCode() };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

/**
 * Returns the nudge-history log (developer name -> last nudge ISO timestamp).
 * Used by the License Optimization page to render "Last nudged: 3d ago" chips.
 */
function getNudgeLog() {
  try {
    return JSON.parse(PropertiesService.getScriptProperties().getProperty('nudge_log') || '{}');
  } catch (e) {
    return {};
  }
}

/**
 * Lightweight freshness check used by the client's "newer data available" poller.
 * Returns the latest mtime across all uploader JSON files plus the dashboard
 * payload's anchorDate so the client can decide whether to nudge a refresh.
 * No caching here — must reflect Drive state on each call.
 */
function getFreshnessInfo() {
  try {
    var folder = DriveApp.getFolderById(SHARED_DRIVE_FOLDER_ID);
    var files = folder.getFiles();
    var maxMtime = 0;
    var fileCount = 0;
    while (files.hasNext()) {
      var f = files.next();
      if (f.isTrashed()) continue;
      var n = f.getName();
      if (n.endsWith('_claude_daily.json') || n.endsWith('_claude_session.json')) {
        fileCount++;
        var t = f.getLastUpdated().getTime();
        if (t > maxMtime) maxMtime = t;
      }
    }
    return { maxMtimeMs: maxMtime, fileCount: fileCount, checkedAtMs: Date.now() };
  } catch (e) {
    return { maxMtimeMs: 0, fileCount: 0, error: e.toString() };
  }
}

/**
 * Returns the current REAL_PROJECTS allowlist as a Script-Properties override
 * (if present) merged with the in-code defaults. Lets admins promote a name
 * without redeploying the script.
 */
function getProjectAllowlistExtras() {
  try {
    return JSON.parse(PropertiesService.getScriptProperties().getProperty('real_projects_extras') || '[]');
  } catch (e) {
    return [];
  }
}
function addProjectAllowlistEntry(fragment) {
  if (!fragment) return { success: false, message: 'fragment required' };
  var extras = getProjectAllowlistExtras();
  if (extras.indexOf(fragment) === -1) extras.push(fragment);
  PropertiesService.getScriptProperties().setProperty('real_projects_extras', JSON.stringify(extras));
  clearDashboardCache();
  return { success: true, extras: extras };
}
function removeProjectAllowlistEntry(fragment) {
  var extras = getProjectAllowlistExtras().filter(function(x) { return x !== fragment; });
  PropertiesService.getScriptProperties().setProperty('real_projects_extras', JSON.stringify(extras));
  clearDashboardCache();
  return { success: true, extras: extras };
}

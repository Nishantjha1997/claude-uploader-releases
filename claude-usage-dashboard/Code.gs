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
  var cacheKey = 'claude_dashboard_data_v5';

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
  var cacheKey = 'claude_dashboard_data_v5';
  
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
    var userProjects = [];
    var userProjectsMap = {};
    var totalSessions = 0;
    var userSessionsList = [];

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
        var dateStr = day.date || day.period || '';
        if (dateStr) {
          activeDays++;
          if (dateStr > lastActivity) {
            lastActivity = dateStr;
          }
          
          // Timeseries mapping
          if (!dailyTimeSeriesMap[dateStr]) {
            dailyTimeSeriesMap[dateStr] = { date: dateStr, totalCost: 0, totalTokens: 0, devCount: 0, devs: {} };
          }
          dailyTimeSeriesMap[dateStr].totalCost += (day.totalCost || day.cost || 0);
          dailyTimeSeriesMap[dateStr].totalTokens += (day.totalTokens || 0);
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
              modelBreakdownOrg[modelName] = { cost: 0, tokens: 0, sessions: 0 };
            }
            modelBreakdownOrg[modelName].cost += (mb.cost || 0);
            modelBreakdownOrg[modelName].tokens += (mb.inputTokens || 0) + (mb.outputTokens || 0) + (mb.cacheCreationTokens || 0) + (mb.cacheReadTokens || 0);
          }
        });
      });
    }

    // Process Session Data
    if (sessionData) {
      var rawSessions = sessionData.sessions || sessionData.session || [];
      totalSessions = rawSessions.length;

      rawSessions.forEach(function(session) {
        var rawProjName = session.sessionId || session.period || 'Unknown Project';
        var cleanProjName = formatProjectName(rawProjName);
        var sCost = session.totalCost || session.cost || 0;
        var sTokens = session.totalTokens || 0;
        var sLastActivity = (session.metadata && session.metadata.lastActivity) || session.lastActivity || '';

        if (sLastActivity && sLastActivity > lastActivity) {
          lastActivity = sLastActivity;
        }

        // Bug 7 fix: attribute session cost to model when only one model used
        if (session.modelsUsed && session.modelsUsed.length === 1 && sCost > 0) {
          var mName = session.modelsUsed[0];
          if (!modelBreakdownOrg[mName]) {
            modelBreakdownOrg[mName] = { cost: 0, tokens: 0, sessions: 0 };
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

    var cacheHitRate = totalTokens > 0 ? (cacheReadTokens / totalTokens) * 100 : 0;
    var primaryModel = getPrimaryModelFromMap(modelsUsedMap);
    var activityLevel = activeDays >= 20 ? 'Heavy' : (activeDays >= 10 ? 'Moderate' : (activeDays >= 3 ? 'Light' : 'Minimal'));

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
      distinctProjects: userProjects.length,
      lastActivity: lastActivity || 'N/A',
      primaryModel: primaryModel,
      activityLevel: activityLevel,
      projects: userProjects,
      modelsUsed: Object.keys(modelsUsedMap),
      modelCostBreakdown: modelCostsMap,
      roiIndex: (totalCost / LICENSE_COST_MONTHLY) * 100,
      dailyHistory: (dailyData ? (dailyData.daily || dailyData.day || []) : []).slice(-30).map(function(d) {
        return { date: d.period || d.date || '', cost: d.totalCost || d.cost || 0 };
      }),
      recentSessions: userSessionsList.slice().sort(function(a, b) {
        return b.date.localeCompare(a.date);
      }).slice(0, 30)
    });

    // Update max metrics for normalized scoring
    if (totalTokens > maxCodeTokens) maxCodeTokens = totalTokens;
    if (activeDays > maxActiveDays) maxActiveDays = activeDays;
    if (userProjects.length > maxProjects) maxProjects = userProjects.length;
  }

  // Step 3: Compute Values, Scores & Recommendations
  var activeUsersCount = 0;
  var totalCodeCost = 0;
  var totalCodeTokens = 0;
  var wastedSavings = 0;

  users.forEach(function(user) {
    // 3a. Calculate Code Score
    var tokenScore = maxCodeTokens > 0 ? (user.totalTokens / maxCodeTokens) * 40 : 0;
    var activeDaysScore = maxActiveDays > 0 ? (user.activeDays / maxActiveDays) * 30 : 0;
    var projectDiversityScore = maxProjects > 0 ? (user.distinctProjects / maxProjects) * 20 : 0;
    
    // Efficiency: Output tokens relative to total input tokens (input + cache creation)
    var inputDenominator = user.inputTokens + user.cacheCreationTokens;
    var efficiencyRatio = inputDenominator > 0 ? (user.outputTokens / inputDenominator) : 0;
    var efficiencyScore = efficiencyRatio > 0 ? Math.min(10, efficiencyRatio * 2) : 0; // Cap at 10%
    
    var codeScore = tokenScore + activeDaysScore + projectDiversityScore + efficiencyScore;
    user.codeScore = Math.min(100, Math.round(codeScore * 10) / 10);
    
    // 3b. Derive Chat Score
    // Since uploader files represent Claude Code CLI usage, the interactive cli chat sessions
    // are those containing some haiku/opus commands or CLI shell usage.
    // We compute a synthetic Chat Score (0-100) based on interactive sessions count
    var cliSessions = user.totalSessions - user.distinctProjects;
    var chatScore = cliSessions > 0 ? Math.min(100, (cliSessions / 10) * 100) : 0;
    user.chatScore = Math.round(chatScore * 10) / 10;
    
    // 3c. Calculate Overall Value Score
    var overallValue = 0;
    if (user.chatScore > 0 && user.codeScore > 0) {
      overallValue = ((user.chatScore + user.codeScore) / 2) + 10; // 10% bonus for hybrid activity
    } else {
      overallValue = Math.max(user.chatScore, user.codeScore);
    }
    user.valueScore = Math.min(100, Math.round(overallValue * 10) / 10);

    // 3d. User Categorization & Licensing Recommendations
    var isRecent = isRecentActivity(user.lastActivity);
    var hasCodeCodeActivity = user.totalCost >= 10.00 || user.activeDays >= 3;

    if (isRecent && hasCodeCodeActivity) {
      user.category = ' Power User';
      user.recommendation = 'Keep - Power user (Chat + Code)';
      activeUsersCount++;
    } else if (isRecent && user.totalSessions >= 5 && !hasCodeCodeActivity) {
      user.category = ' Chat-Only Active';
      user.recommendation = 'Keep + Encourage Code adoption';
      activeUsersCount++;
    } else if (hasCodeCodeActivity && !isRecent) {
      // Meaningful historical usage but inactive recently
      user.category = '⚡ Code-Only Active';
      user.recommendation = 'Keep - Active developer';
      activeUsersCount++;
    } else if (user.totalTokens > 0) {
      // Has some minor usage but below power thresholds
      user.category = '⚠️ Low Engagement';
      user.recommendation = 'Review - Training or Re-evaluate';
      activeUsersCount++;
    } else {
      user.category = '❌ Truly Inactive';
      user.recommendation = 'Remove - Reclaim license';
      wastedSavings += LICENSE_COST_MONTHLY;
    }

    totalCodeCost += user.totalCost;
    totalCodeTokens += user.totalTokens;
  });

  // Step 4: Finalize Org and Project rosters
  var projectsList = [];
  for (var pName in projectAggregates) {
    var pData = projectAggregates[pName];
    projectsList.push({
      name: pData.name,
      devCount: Object.keys(pData.activeDevs).length,
      devNames: Object.keys(pData.activeDevs),
      sessions: pData.sessions,
      totalCost: pData.totalCost,
      totalTokens: pData.totalTokens,
      lastActivity: pData.lastActivity
    });
  }

  // Build a rolling 30-day linear chronological timeline from the maximum date found
  var dailyTimeSeriesList = [];
  var dates = Object.keys(dailyTimeSeriesMap);
  var maxDateStr = '';
  if (dates.length > 0) {
    dates.sort();
    maxDateStr = dates[dates.length - 1];
  } else {
    var now = new Date();
    maxDateStr = Utilities.formatDate(now, 'Asia/Kolkata', 'yyyy-MM-dd');
  }

  try {
    var parts = maxDateStr.split('-');
    var maxYear = parseInt(parts[0], 10);
    var maxMonth = parseInt(parts[1], 10) - 1;
    var maxDay = parseInt(parts[2], 10);
    var maxDateObj = new Date(maxYear, maxMonth, maxDay, 12, 0, 0);

    for (var i = 29; i >= 0; i--) {
      var d = new Date(maxDateObj.getTime());
      d.setDate(maxDateObj.getDate() - i);
      
      var year = d.getFullYear();
      var month = ('0' + (d.getMonth() + 1)).slice(-2);
      var dateDay = ('0' + d.getDate()).slice(-2);
      var dateString = year + '-' + month + '-' + dateDay;

      if (dailyTimeSeriesMap[dateString]) {
        dailyTimeSeriesList.push(dailyTimeSeriesMap[dateString]);
      } else {
        dailyTimeSeriesList.push({
          date: dateString,
          totalCost: 0,
          totalTokens: 0,
          devCount: 0,
          devs: {}
        });
      }
    }
  } catch (err) {
    // Fallback to simple sorting if date parsing fails
    for (var dateStr in dailyTimeSeriesMap) {
      dailyTimeSeriesList.push(dailyTimeSeriesMap[dateStr]);
    }
    dailyTimeSeriesList.sort(function(a, b) {
      return a.date.localeCompare(b.date);
    });
  }

  var totalLicenses = users.length; // Active developers in Drive represent the roster
  var licenseUtilization = totalLicenses > 0 ? (activeUsersCount / totalLicenses) * 100 : 0;
  
  var orgSummary = {
    totalLicenses: totalLicenses,
    licenseMonthlyFee: LICENSE_COST_MONTHLY,
    flatSubscriptionSpend: totalLicenses * LICENSE_COST_MONTHLY,
    activeUsersCount: activeUsersCount,
    licenseUtilization: Math.round(licenseUtilization * 10) / 10,
    totalCodeCost: totalCodeCost,
    totalCodeTokens: totalCodeTokens,
    overallCacheHitRate: totalCodeTokens > 0 ? (users.reduce(function(acc, u) { return acc + u.cacheReadTokens; }, 0) / totalCodeTokens) * 100 : 0,
    avgCostPerUser: totalLicenses > 0 ? totalCodeCost / totalLicenses : 0,
    potentialSavings: wastedSavings,
    reportPeriod: {
      from: dailyTimeSeriesList.length > 0 ? dailyTimeSeriesList[0].date : 'N/A',
      to: dailyTimeSeriesList.length > 0 ? dailyTimeSeriesList[dailyTimeSeriesList.length - 1].date : 'N/A'
    },
    generatedTime: new Date().toISOString()
  };

  return {
    orgSummary: orgSummary,
    users: users,
    projects: projectsList,
    modelBreakdowns: modelBreakdownOrg,
    dailyTimeSeries: dailyTimeSeriesList
  };
}

/**
 * Format project paths into nice, readable titles
 */
function formatProjectName(id) {
  if (!id) return 'Unknown Project';
  if (id === 'subagents') return '⚙ Background Helpers (subagents)';
  
  // Detect if the ID is just a hex hash/UUID (typical of ad-hoc CLI sessions without a git repo or directory context)
  var rawCleaned = id.replace(/[\s\-\–\\\/]/g, '');
  if (/^[0-9a-fA-F]+$/.test(rawCleaned)) {
    return '💬 Ad-hoc CLI Sessions';
  }
  
  // Replace double dashes or slashes with standard directory labels
  var cleaned = id.replace(/\\/g, '-').replace(/\//g, '-').replace(/--/g, '-');
  
  // If drive labels are present, e.g. F-SigmaSolve-Projects-nextdental-case-services
  var parts = cleaned.split('-');
  
  // Filter out partition letters like "C" or "F" or empty labels
  var cleanParts = parts.filter(function(p) {
    return p.length > 1 || (p !== 'C' && p !== 'F' && p !== 'D' && p !== 'E');
  });
  
  if (cleanParts.length >= 2) {
    // Take the last two components representing the project category and name
    var category = cleanParts[cleanParts.length - 2];
    var name = cleanParts[cleanParts.length - 1];
    
    // Capitalize nicely
    category = capitalizeWords(category);
    name = capitalizeWords(name);
    
    return category + ' – ' + name;
  }
  
  return capitalizeWords(cleaned.replace(/-/g, ' '));
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

function isRecentActivity(dateStr) {
  if (!dateStr || dateStr === 'N/A') return false;
  try {
    var actDate = new Date(dateStr);
    var now = new Date();
    var diffTime = Math.abs(now - actDate);
    var diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays <= 30; // Active in the last 30 days
  } catch (e) {
    return false;
  }
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
  var roi = s.totalCodeCost > 0 && s.flatSubscriptionSpend > 0 ? ((s.totalCodeCost / s.flatSubscriptionSpend) * 100).toFixed(0) : '—';
  var wasted = Math.round((s.potentialSavings || 0) / LICENSE_COST_MONTHLY);
  var text = '*📊 Claude AI Weekly Digest — ' + Utilities.formatDate(new Date(), 'Asia/Kolkata', 'MMM d, yyyy') + '*\n' +
    '> 💰 Equivalent API Cost: *' + (s.totalCodeCost || 0).toFixed(2) + ' USD*\n' +
    '> 🪙 Subscription Spend: *' + (s.flatSubscriptionSpend || 0).toFixed(2) + ' USD/mo*\n' +
    '> 👥 Active Developers: *' + s.activeUsersCount + ' / ' + s.totalLicenses + '* (' + s.licenseUtilization + '% utilization)\n' +
    '> 📈 ROI Index: *' + roi + '%*\n' +
    (wasted > 0 ? '> ⚠️ *' + wasted + ' inactive license(s)* detected — $' + (s.potentialSavings || 0).toFixed(0) + '/mo wasted\n' : '> ✅ No wasted licenses detected\n');
  try {
    var resp = UrlFetchApp.fetch(url, { method: 'POST', contentType: 'application/json', payload: JSON.stringify({ text: text }), muteHttpExceptions: true });
    return { success: resp.getResponseCode() < 300, status: resp.getResponseCode() };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

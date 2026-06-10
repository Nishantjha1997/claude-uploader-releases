const fs = require('fs');

try {
  let html = fs.readFileSync('JavaScript.html', 'utf8');

  let codeToAdd = `
// ==================== VERSION MATRIX PAGE RENDERERS ====================
function renderVersionMatrix() {
  const { activeUsers=[] } = dashboardData;
  const grid = document.getElementById('versionMatrixGrid');
  if (!grid) return;
  
  if (!activeUsers || activeUsers.length === 0) {
    grid.innerHTML = '<div class="empty-state">No active users found.</div>';
    return;
  }
  
  // Sort users alphabetically
  const sorted = activeUsers.slice().sort((a,b) => a.name.localeCompare(b.name));
  
  grid.innerHTML = sorted.map(u => {
    const ver = u.version || '1.9.0';
    const isUpToDate = ver.startsWith('2.');
    const badgeClass = isUpToDate ? 'version-badge-green' : 'version-badge-orange';
    const badgeText = isUpToDate ? 'v' + ver + ' (Secure)' : 'v' + ver + ' (Outdated)';
    
    let btnHtml = isUpToDate 
      ? '<button class="btn btn-ghost btn-sm" disabled>Up to date</button>'
      : '<button class="btn btn-primary btn-sm hotpatch-btn" onclick="forceHotPatch(\\'' + esc(u.name) + '\\')">&#9881; Force Hot-Patch</button>';
      
    return \`
      <div class="vm-card">
        <div style="font-weight:600; font-size:15px; margin-bottom:8px">\${esc(u.name)}</div>
        <div style="margin-bottom:12px">
          \${getStatusDotHtml(u)}
        </div>
        <div class="version-badge \${badgeClass}" style="margin-bottom:12px">
          \${badgeText}
        </div>
        \${btnHtml}
      </div>
    \`;
  }).join('');
}

function forceHotPatch(name) {
  if (!confirm('Force an immediate hot-patch update for ' + name + '?')) return;
  const btn = event.currentTarget;
  const origText = btn.innerHTML;
  btn.innerHTML = '&#8987; Queuing...';
  btn.disabled = true;
  
  google.script.run
    .withSuccessHandler(function(res) {
      showToast('Hot-patch queued for ' + name);
      btn.innerHTML = '&#10003; Queued';
      setTimeout(function() { fetchData(); }, 1500);
    })
    .withFailureHandler(function(err) {
      showToast('Failed to queue hot-patch: ' + err.message, true);
      btn.innerHTML = origText;
      btn.disabled = false;
    })
    .forceSendUpdateTrigger_(name);
}
`;

  // Insert before window.onload = fetchData; if not already there
  if (!html.includes('function renderVersionMatrix')) {
    html = html.replace('window.onload = fetchData;', codeToAdd + '\nwindow.onload = fetchData;');
    fs.writeFileSync('JavaScript.html', html);
    console.log('JavaScript.html updated successfully');
  } else {
    console.log('Already added');
  }
} catch(e) {
  console.error("Error:", e);
}

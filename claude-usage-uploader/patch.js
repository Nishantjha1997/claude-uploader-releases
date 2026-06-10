const fs = require('fs');

try {
  let js = fs.readFileSync('claude-usage-uploader.js', 'utf8');
  let match = js.match(/const SIGMA_SVG = `(<img src="data:image\/png;base64,[^"]+" alt="SigmaSolve"[^>]*>)`/);
  if (!match) {
    console.error("Could not find SIGMA_SVG in JS");
    process.exit(1);
  }
  let imgTag = match[1];

  let html = fs.readFileSync('Index.html', 'utf8');

  // Replace logo
  html = html.replace(
    /<img src="data:image\/svg\+xml[^>]+>/,
    imgTag
  );

  // Add nav item
  let navTarget = `        <div class="nav-item" onclick="navigateTo('developers')" data-page="developers">
          <span class="nav-icon">&#128101;</span>
          <span>Developers</span>
        </div>`;
  let newNav = `        <div class="nav-item" onclick="navigateTo('versions')" data-page="versions">
          <span class="nav-icon">&#128187;</span>
          <span>Version Matrix</span>
        </div>`;
  html = html.replace(navTarget, navTarget + '\n' + newNav);

  // Add page-versions section
  let pageDevTarget = `      <!-- ==================== DEVELOPERS PAGE ==================== -->
      <div class="page-view" id="page-developers">`;
  let pageVersions = `      <!-- ==================== VERSION MATRIX PAGE ==================== -->
      <div class="page-view" id="page-versions">
        <div class="card">
          <div class="section-hd">
            <div>
              <div class="section-title">Client Version Matrix</div>
              <div class="section-sub">Monitor and enforce client versions across all developers</div>
            </div>
            <button class="btn btn-primary btn-sm" onclick="renderPageData('versions')">&#8635; Refresh</button>
          </div>
          <div class="vm-grid" id="versionMatrixGrid">
            <!-- Rendered via JS -->
          </div>
        </div>
      </div>`;
  html = html.replace(pageDevTarget, pageVersions + '\n\n' + pageDevTarget);

  fs.writeFileSync('Index.html', html);
  console.log('Index.html updated successfully');
} catch(e) {
  console.error("Error:", e);
}

const fs = require('fs');
const path = require('path');

const base64Path = 'C:\\Users\\ADMIN\\.gemini\\antigravity\\brain\\0e764fdd-6349-47a2-9250-130ec6087395\\scratch\\base64_out.txt';
const indexPath = path.join('claude-usage-dashboard', 'Index.html');
const stylePath = path.join('claude-usage-dashboard', 'Stylesheet.html');

console.log('Reading base64 logo...');
const base64Data = fs.readFileSync(base64Path, 'utf8').trim();
console.log('Base64 logo length:', base64Data.length);

// 1. Update Index.html
console.log('Updating Index.html...');
let indexContent = fs.readFileSync(indexPath, 'utf8');

const startStr = '<div class="brand-section">';
const endStr = '<ul class="nav-menu">';

const startIndex = indexContent.indexOf(startStr);
const endIndex = indexContent.indexOf(endStr);

if (startIndex !== -1 && endIndex !== -1 && startIndex < endIndex) {
  const originalBrandBlock = indexContent.substring(startIndex, endIndex);
  console.log('Found original brand block of length:', originalBrandBlock.length);
  
  const newBrandSection = `<div class="brand-section">
        <div class="logo-container">
          <img class="brand-logo" src="data:image/png;base64,${base64Data}" alt="Sigma Solve Logo">
          <div class="brand-subtitle">Claude ROI Tracker</div>
        </div>
      </div>
      \n      `;
  
  indexContent = indexContent.substring(0, startIndex) + newBrandSection + indexContent.substring(endIndex);
  fs.writeFileSync(indexPath, indexContent, 'utf8');
  console.log('Index.html updated successfully.');
} else {
  console.error('Error: Could not find exact boundaries in Index.html!');
}

// 2. Update Stylesheet.html
console.log('Updating Stylesheet.html...');
let styleContent = fs.readFileSync(stylePath, 'utf8');

// We want to add styling for .logo-container and update .brand-section & .brand-logo
// Let's find where .brand-section is in Stylesheet.html
const brandSectionStyleStart = styleContent.indexOf('.brand-section {');
if (brandSectionStyleStart !== -1) {
  console.log('Found .brand-section styling in Stylesheet.html');
  
  // We'll replace the existing style block for .brand-section and .brand-section svg
  // Let's find the closing brace of the SVG style or just replace up to .nav-menu style
  const navMenuStyleStart = styleContent.indexOf('.nav-menu {');
  if (navMenuStyleStart !== -1 && brandSectionStyleStart < navMenuStyleStart) {
    const originalStyleBlock = styleContent.substring(brandSectionStyleStart, navMenuStyleStart);
    console.log('Found original style block to replace:', originalStyleBlock);
    
    const newStyleBlock = `.brand-section {
  display: flex;
  align-items: center;
  margin-bottom: 2.5rem;
  padding-left: 0.5rem;
}

.logo-container {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.35rem;
  width: 100%;
}

.brand-logo {
  max-height: 38px;
  max-width: 100%;
  object-fit: contain;
  filter: drop-shadow(0 2px 8px rgba(255, 255, 255, 0.05));
}

.brand-subtitle {
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 2px;
  color: var(--accent-primary);
  font-weight: 700;
  margin-top: 2px;
}

`;
    styleContent = styleContent.substring(0, brandSectionStyleStart) + newStyleBlock + styleContent.substring(navMenuStyleStart);
    fs.writeFileSync(stylePath, styleContent, 'utf8');
    console.log('Stylesheet.html updated successfully.');
  } else {
    console.error('Could not locate nav-menu styling to demarcate the style block.');
  }
} else {
  console.error('Could not find .brand-section styling in Stylesheet.html');
}

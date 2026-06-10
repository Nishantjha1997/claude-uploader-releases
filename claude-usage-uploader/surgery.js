const fs = require('fs');
const file = 'claude-usage-uploader.js';
const lines = fs.readFileSync(file, 'utf8').split('\n');

// Lines 367-370 are index 366 to 369 (0-indexed)
// We want to remove the specific lines we saw in the view_file
if (lines[366].includes('} catch (e) {')) {
  lines.splice(366, 4);
  fs.writeFileSync(file, lines.join('\n'));
  console.log('SURGERY_SUCCESS');
} else {
  console.log('INDEX_MISMATCH');
}

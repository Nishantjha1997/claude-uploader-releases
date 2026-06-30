const fs = require('fs');
const fileContent = fs.readFileSync('C:\\Users\\ADMIN\\.gemini\\antigravity\\scratch\\extracted_script.js', 'utf8');
const lines = fileContent.split(/\r?\n/);
for (let i = 90; i < 120; i++) {
  if (i < lines.length) {
    console.log(`${i + 1}: ${lines[i]}`);
  }
}

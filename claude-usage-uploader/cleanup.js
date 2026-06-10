const fs = require('fs');
const file = 'claude-usage-uploader.js';
let content = fs.readFileSync(file, 'utf8');

// Use regex to remove the duplicate end-block and catch that were left behind
const regex = /resolve\(\);\s+?\}\);\s+?\}\s+?catch\s*?\(e\)\s*?\{\s+?reject\(e\);\s+?\}\s+?\}\);/g;

if (regex.test(content)) {
    content = content.replace(regex, 'resolve();\n    });');
    fs.writeFileSync(file, content);
    console.log('REGEX_CLEANUP_SUCCESS');
} else {
    console.log('REGEX_CLEANUP_NOT_FOUND');
}

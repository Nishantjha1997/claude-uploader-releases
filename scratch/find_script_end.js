const fs = require('fs');
const html = fs.readFileSync('C:\\Users\\ADMIN\\.gemini\\antigravity\\scratch\\concatenated.html', 'utf8');

const regex = /<\/script>/gi;
let match;
while (match = regex.exec(html)) {
  const index = match.index;
  console.log(`Found </script> at index ${index}:`);
  console.log(`Surrounding context:`);
  console.log(JSON.stringify(html.substring(index - 50, index + 50)));
}

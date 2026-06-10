const fs = require('fs');

try {
  let html = fs.readFileSync('Code.gs', 'utf8');

  let codeToAdd = `
function forceSendUpdateTrigger_(name) {
  if (!name) return { success: false, error: 'No name provided' };
  return adminQueueTrigger(name, 'UPDATE');
}
`;

  if (!html.includes('function forceSendUpdateTrigger_')) {
    fs.appendFileSync('Code.gs', codeToAdd);
    console.log('Code.gs updated successfully');
  } else {
    console.log('Already added');
  }
} catch(e) {
  console.error("Error:", e);
}

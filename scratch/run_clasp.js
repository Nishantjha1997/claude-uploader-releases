const cp = require('child_process');
try {
  console.log("Running clasp deploy...");
  const out = cp.execSync('C:\\Users\\ADMIN\\AppData\\Roaming\\npm\\clasp.cmd deploy -i AKfycbyD5BZCw4iWUN9XhPZDLQG3yeLuNwKXkEVLxoEQq9f6lzD48kVZnZQRJ3l1rlbl8CzV8w -d VisualUpgrade13', {encoding: 'utf8'});
  console.log("SUCCESS:", out);
} catch (e) {
  console.log("FAILED:");
  console.log("STDOUT:", e.stdout);
  console.log("STDERR:", e.stderr);
}

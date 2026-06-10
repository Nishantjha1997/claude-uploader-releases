const { execSync } = require('child_process');

const DEPLOYMENT_ID = 'AKfycby9bFBRwYLu1GF6urQn3saAuVacI95NjS2Jt2G3eiba3StKwu9i8POjXnlx224NMMXt';

try {
  console.log('1. Pushing local changes to Google Apps Script...');
  // Pipe "y" to push --force to handle "Overwrite local files?" prompt
  execSync('echo y | npx clasp push --force', { stdio: 'inherit' });
  
  console.log('\n2. Creating a new Apps Script version...');
  const versionOutput = execSync('npx clasp version').toString();
  console.log(versionOutput);
  
  const match = versionOutput.match(/Created version (\d+)/i);
  if (!match) {
    throw new Error('Could not parse version number from clasp output.');
  }
  const versionNumber = match[1];
  console.log(`Detected new Version Number: ${versionNumber}`);
  
  console.log(`\n3. Redeploying Web App (${DEPLOYMENT_ID}) to version ${versionNumber}...`);
  execSync(`npx clasp redeploy ${DEPLOYMENT_ID} -V ${versionNumber} -d "v2.0.3 - Sync Gist version"`, { stdio: 'inherit' });
  
  console.log('\n✅ Deployment successfully updated!');
} catch (error) {
  console.error('\n❌ Deployment failed:', error.message || error);
  process.exit(1);
}

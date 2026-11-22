// Personal build settings stay out of the repo. app.json holds everything public; this adds what's local.
// iOS signing team: APPLE_TEAM_ID env var, or the team id in ~/.tally/apple-team-id.
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = ({ config }) => {
  const teamFile = path.join(os.homedir(), '.tally', 'apple-team-id');
  const team = process.env.APPLE_TEAM_ID || (fs.existsSync(teamFile) ? fs.readFileSync(teamFile, 'utf8').trim() : '');
  if (team) config.ios = { ...config.ios, appleTeamId: team };
  config.plugins = [...(config.plugins || []), './plugins/withReleaseSigning'];
  return config;
};

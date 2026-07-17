const { execSync } = require("child_process")

const run = (cmd) => {
  console.log("[startup]", cmd)
  execSync(cmd, { stdio: "inherit" })
}

// No build step — dist/ is pre-compiled by GitHub Actions
run("npm install --ignore-scripts")
run("npm run db:deploy")
execSync("node dist/main", { stdio: "inherit" })

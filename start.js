const { execSync } = require("child_process")

const run = (cmd) => {
  console.log("[startup]", cmd)
  execSync(cmd, { stdio: "inherit" })
}

// --ignore-scripts pula o husky (git hook de dev, não roda em produção)
run("npm install --ignore-scripts")
run("npm run build")
run("npm run db:deploy")
execSync("node dist/main", { stdio: "inherit" })

const { execSync } = require("child_process")

const run = (cmd) => {
  console.log("[startup]", cmd)
  execSync(cmd, { stdio: "inherit" })
}

run("npm install --ignore-scripts")
run("npm run db:generate")   // gera o Prisma client para esta plataforma
run("npm run db:deploy")     // aplica migrations
execSync("node dist/main", { stdio: "inherit" })

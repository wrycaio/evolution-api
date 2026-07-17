const { execSync } = require('child_process')

const run = (cmd) => {
  console.log('[startup]', cmd)
  execSync(cmd, { stdio: 'inherit' })
}

run('npm install')
run('npm run build')
run('npm run db:deploy')
execSync('node dist/main', { stdio: 'inherit' })

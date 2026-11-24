import { RELOAD_EXIT_CODE } from "../packages/drivers/src/env/self-host-runner.ts";

let shuttingDown = false;
let currentServer: ReturnType<typeof Bun.spawn> | null = null;

function spawnDaemon() {
  currentServer = Bun.spawn(["bun", "packages/server/src/index.ts"], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
    env: {
      ...process.env,
      SUPER_WORK_SUPERVISED: "1",
    },
  });
  return currentServer;
}

const web = Bun.spawn(["bun", "run", "--cwd", "packages/web", "dev"], {
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    currentServer?.kill();
  } catch {
    // Ignore
  }
  try {
    web.kill();
  } catch {
    // Ignore
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const watchWeb = (async () => {
  await web.exited;
  shutdown();
})();

const superviseServer = (async () => {
  while (!shuttingDown) {
    const proc = spawnDaemon();
    const code = await proc.exited;
    if (shuttingDown) break;
    if (code === RELOAD_EXIT_CODE) {
      console.log("[dev] Self-host reload triggered (exit 75); respawning daemon...");
      continue;
    }
    console.log(`[dev] Server daemon exited cleanly/unexpectedly (code=${code}); stopping dev.`);
    shutdown();
    break;
  }
})();

await Promise.all([watchWeb, superviseServer]);

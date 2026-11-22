const server = Bun.spawn(["bun", "--watch", "packages/server/src/index.ts"], {
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
});

const web = Bun.spawn(["bun", "run", "--cwd", "packages/web", "dev"], {
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
});

function shutdown() {
  server.kill();
  web.kill();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await Promise.race([server.exited, web.exited]);
shutdown();

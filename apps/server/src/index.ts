import { configFromEnv, loadEnv } from "./env";
import { startServer } from "./server";

loadEnv();

const config = configFromEnv();
let closeServer: (() => Promise<void>) | undefined;
let shuttingDown = false;

startServer(config)
  .then(({ host, port, close }) => {
    closeServer = close;
    console.log(`Control API listening on http://${host}:${port}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  void (closeServer ? closeServer() : Promise.resolve())
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

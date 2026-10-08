import http from "http";

export function setupGracefulShutdown(server: http.Server, timeoutMs = 10000) {
  let isShuttingDown = false;

  const handleShutdown = (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    server.close(() => {
      process.exit(0);
    });

    setTimeout(() => {
      process.exit(1);
    }, timeoutMs);
  };

  process.on("SIGTERM", () => handleShutdown("SIGTERM"));
  process.on("SIGINT", () => handleShutdown("SIGINT"));
}

import type { Orchestron } from '../orchestron.js';
import { startDashboardServer } from '../dashboard-server.js';

export async function dashboardCommandHandler(
  orchestron: Orchestron,
  port: number,
): Promise<void> {
  await orchestron.hall.rehydrate();

  const server = await startDashboardServer(orchestron.store, port);

  console.log(`Orchestron dashboard running at ${server.url}`);
  console.log('Press Ctrl+C to stop.');

  return new Promise((resolve) => {
    const shutdown = () => {
      server.close();
      orchestron.store.close();
      resolve(undefined);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

import { Request, Response, Router } from "express";

export class MetricsCollector {
  private requestsTotal = 0;
  private activeMortgages = 0;

  recordRequest() { this.requestsTotal++; }
  setMortgages(count: number) { this.activeMortgages = count; }

  renderPrometheus(): string {
    return [
      "# HELP stellar_homes_http_requests_total Total HTTP requests",
      "# TYPE stellar_homes_http_requests_total counter",
      `stellar_homes_http_requests_total ${this.requestsTotal}`,
      "# HELP stellar_homes_active_mortgages Active mortgages in pool",
      "# TYPE stellar_homes_active_mortgages gauge",
      `stellar_homes_active_mortgages ${this.activeMortgages}`,
    ].join("\n");
  }
}

export const metrics = new MetricsCollector();

export function createMetricsRouter(): Router {
  const router = Router();
  router.get("/metrics", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/plain");
    res.send(metrics.renderPrometheus());
  });
  return router;
}

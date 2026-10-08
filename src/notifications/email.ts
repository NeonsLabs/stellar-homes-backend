export interface EmailNotification {
  to: string;
  subject: string;
  body: string;
  eventType: "MILESTONE_RELEASED" | "REPAYMENT_DUE" | "DEFAULT_WARNING";
}

export class EmailService {
  private queue: EmailNotification[] = [];

  async send(notification: EmailNotification): Promise<boolean> {
    this.queue.push(notification);
    return true;
  }

  getSentQueue(): EmailNotification[] {
    return [...this.queue];
  }
}

export const emailService = new EmailService();

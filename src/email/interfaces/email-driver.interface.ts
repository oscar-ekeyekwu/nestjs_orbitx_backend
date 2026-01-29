export interface EmailOptions {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  from?: string;
  attachments?: any[];
}

export interface IEmailDriver {
  sendEmail(options: EmailOptions): Promise<void>;
}

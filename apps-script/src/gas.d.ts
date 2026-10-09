/**
 * The small part of Apps Script's runtime this project uses (so no `@types/google-apps-script`
 * dependency). The Advanced Gmail service is the global `Gmail`; see appsscript.json.
 */
interface GmailPayload {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string | number[] };
  parts?: GmailPayload[];
}

interface GmailMessageResource {
  id: string;
  internalDate?: string;
  payload?: GmailPayload;
}

declare const Gmail: {
  Users: {
    Labels: { list(userId: string): { labels?: { id: string; name: string }[] } };
    Messages: {
      list(
        userId: string,
        options: { q: string; maxResults: number; pageToken?: string },
      ): { messages?: { id: string }[]; nextPageToken?: string };
      get(userId: string, id: string, options: { format: 'full' }): GmailMessageResource;
      modify(
        request: { addLabelIds: string[]; removeLabelIds: string[] },
        userId: string,
        id: string,
      ): unknown;
    };
  };
};

interface UrlFetchResponse {
  getResponseCode(): number;
  getContentText(): string;
}

declare const UrlFetchApp: {
  fetch(
    url: string,
    options: {
      method: 'post';
      contentType: string;
      payload: number[];
      headers: Record<string, string>;
      muteHttpExceptions: true;
    },
  ): UrlFetchResponse;
};

declare const PropertiesService: {
  getScriptProperties(): {
    getProperty(name: string): string | null;
    setProperty(name: string, value: string): unknown;
  };
};

declare const Utilities: {
  computeHmacSha256Signature(value: number[], key: number[]): number[];
  getUuid(): string;
  formatDate(date: Date, timeZone: string, format: string): string;
  base64DecodeWebSafe(data: string): number[];
  base64Decode(data: string): number[];
  newBlob(bytes: number[]): { getDataAsString(charset: string): string };
};

interface Trigger {
  getHandlerFunction(): string;
}

declare const ScriptApp: {
  getProjectTriggers(): Trigger[];
  newTrigger(name: string): {
    timeBased(): {
      everyMinutes(minutes: number): { create(): unknown };
      atHour(hour: number): {
        nearMinute(minute: number): { everyDays(days: number): { create(): unknown } };
      };
    };
  };
};

declare const LockService: {
  getScriptLock(): { tryLock(timeoutMs: number): boolean; releaseLock(): void };
};

declare const MailApp: {
  sendEmail(message: { to: string; subject: string; body: string; htmlBody?: string }): void;
};

declare const Session: { getEffectiveUser(): { getEmail(): string } };

declare const Logger: { log(message: string): void };

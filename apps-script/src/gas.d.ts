/**
 * The small part of Apps Script's runtime this project uses (so no `@types/google-apps-script`
 * dependency). The Advanced Gmail service is the global `Gmail`; see appsscript.json.
 */
interface GmailPayload {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string };
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
  getScriptProperties(): { getProperty(name: string): string | null };
};

declare const Utilities: {
  computeHmacSha256Signature(value: number[], key: number[]): number[];
  getUuid(): string;
  base64DecodeWebSafe(data: string): number[];
  newBlob(bytes: number[]): { getDataAsString(charset: string): string };
};

interface Trigger {
  getHandlerFunction(): string;
}

declare const ScriptApp: {
  getProjectTriggers(): Trigger[];
  deleteTrigger(trigger: Trigger): void;
  newTrigger(name: string): {
    timeBased(): { everyMinutes(minutes: number): { create(): unknown } };
  };
};

declare const Logger: { log(message: string): void };

const IAM_TOKEN_URL = "https://iam.cloud.ibm.com/identity/token";
const REFRESH_EARLY_MS = 5 * 60 * 1_000;

type Fetcher = typeof fetch;

type CachedToken = {
  accessToken: string;
  refreshAtMs: number;
};

export class IbmIamTokenProvider {
  private cachedToken: CachedToken | undefined;
  private refreshPromise: Promise<string> | undefined;

  constructor(
    private readonly fetcher: Fetcher = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  invalidate(accessToken?: string): void {
    if (accessToken === undefined || this.cachedToken?.accessToken === accessToken) {
      this.cachedToken = undefined;
    }
  }

  async getToken(): Promise<string> {
    if (this.cachedToken && this.now() < this.cachedToken.refreshAtMs) {
      return this.cachedToken.accessToken;
    }
    if (this.refreshPromise) return this.refreshPromise;

    const refresh = this.refresh();
    this.refreshPromise = refresh;
    try {
      return await refresh;
    } finally {
      if (this.refreshPromise === refresh) this.refreshPromise = undefined;
    }
  }

  private async refresh(): Promise<string> {
    const apiKey = process.env.WATSONX_ORCHESTRATE_API_KEY?.trim();
    if (!apiKey) throw new Error("WATSONX_ORCHESTRATE_API_KEY is required for REST extraction");

    const form = new URLSearchParams({
      grant_type: "urn:ibm:params:oauth:grant-type:apikey",
      apikey: apiKey,
    });
    const response = await this.fetcher(IAM_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    if (!response.ok) throw new Error(`IBM IAM authentication failed with status ${response.status}`);

    const payload = await response.json() as { access_token?: unknown; expires_in?: unknown };
    const accessToken = typeof payload.access_token === "string" ? payload.access_token.trim() : "";
    const expiresIn = Number(payload.expires_in);
    if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error("IBM IAM returned an invalid token response");
    }
    this.cachedToken = {
      accessToken,
      refreshAtMs: this.now() + Math.max(0, expiresIn * 1_000 - REFRESH_EARLY_MS),
    };
    return accessToken;
  }
}

export async function withOneIamRetry<T extends { status: number }>(
  tokenProvider: IbmIamTokenProvider,
  request: (accessToken: string) => Promise<T>,
): Promise<T> {
  const firstToken = await tokenProvider.getToken();
  const firstResponse = await request(firstToken);
  if (firstResponse.status !== 401) return firstResponse;

  tokenProvider.invalidate(firstToken);
  return request(await tokenProvider.getToken());
}

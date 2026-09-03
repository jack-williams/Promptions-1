import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { loadEnv } from "vite";

const DEFAULT_UPSTREAM = "https://api.openai.com";
const DEFAULT_PROXY_PATH = "/api/openai";

/**
 * Request headers forwarded upstream. Everything else (cookies, the client's
 * placeholder credential, hop-by-hop headers) is dropped.
 */
const FORWARDED_REQUEST_HEADERS = ["accept", "content-type", "openai-beta"];

/** Response headers forwarded back to the browser. */
const FORWARDED_RESPONSE_HEADERS = ["content-type", "cache-control"];

/**
 * @typedef {"azure" | "openai"} ApiStyle
 *
 * @typedef {object} OpenAIProxyOptions
 * @property {string} [path] Path the browser calls. Defaults to `/api/openai`.
 *
 * @typedef {object} ProxySettings
 * @property {string} [apiKey]
 * @property {string} upstream
 * @property {ApiStyle} mode
 */

/**
 * Proxies OpenAI / Azure OpenAI traffic through the Vite dev and preview
 * servers so the credential stays on the server.
 *
 * The key is read from `OPENAI_API_KEY` without the `VITE_` prefix, which means
 * Vite never inlines it into the client bundle. The browser sends its requests
 * to the proxy path with no credential; this plugin attaches the real one
 * before forwarding upstream.
 *
 * @param {OpenAIProxyOptions} [options]
 * @returns {import("vite").Plugin}
 */
export function openaiProxy(options = {}) {
    const proxyPath = options.path ?? DEFAULT_PROXY_PATH;

    /** @type {ProxySettings} */
    let settings = { upstream: DEFAULT_UPSTREAM, mode: "openai" };

    /**
     * Names of `VITE_`-prefixed variables that look like credentials. Vite
     * serves the whole `import.meta.env` object to the browser in dev, so any
     * such variable is exposed regardless of whether code references it.
     * @type {string[]}
     */
    let exposedSecretNames = [];

    /** @type {import("vite").Connect.NextHandleFunction} */
    const handler = (req, res) => {
        void forward(req, res, settings);
    };

    /** @param {(message: string) => void} warn */
    const warnAboutConfig = (warn) => {
        if (!settings.apiKey) {
            warn(
                `[openai-proxy] OPENAI_API_KEY is not set. Requests to ${proxyPath} will fail. ` +
                    `Copy .env.example to .env and set OPENAI_API_KEY (note: no VITE_ prefix).`,
            );
        }
        if (exposedSecretNames.length > 0) {
            warn(
                `[openai-proxy] SECURITY: ${exposedSecretNames.join(", ")} ${
                    exposedSecretNames.length === 1 ? "is" : "are"
                } exposed to the browser. ` +
                    `Vite serves every VITE_-prefixed variable to client code, so this value is readable by anyone ` +
                    `loading the app. It is left over from a version of this app that ran the API key in the browser. ` +
                    `Remove it from your .env — the proxy reads OPENAI_API_KEY instead — and rotate the credential.`,
            );
        }
    };

    return {
        name: "promptions:openai-proxy",

        config(config, { mode }) {
            const envDir = config.envDir ?? config.root ?? process.cwd();
            const env = loadEnv(mode, envDir, "");
            const upstream = env.OPENAI_BASE_URL?.trim();
            const style = env.OPENAI_API_STYLE?.trim().toLowerCase();

            exposedSecretNames = Object.keys(env).filter(
                (name) => name.startsWith("VITE_") && /KEY|SECRET|TOKEN|PASSWORD/i.test(name) && env[name],
            );

            // The variable this plugin exists to eliminate. Anything still set
            // here is a live credential being served to the browser, so refuse
            // to start rather than let it look fixed.
            if (env.VITE_OPENAI_API_KEY) {
                throw new Error(
                    `[openai-proxy] VITE_OPENAI_API_KEY is set in your environment. Vite serves every VITE_-prefixed ` +
                        `variable to client code, so this credential is readable by anyone loading the app. ` +
                        `Rename it to OPENAI_API_KEY (no VITE_ prefix) and rotate the key.`,
                );
            }

            settings = {
                apiKey: env.OPENAI_API_KEY?.trim() || undefined,
                upstream: (upstream || DEFAULT_UPSTREAM).replace(/\/+$/, ""),
                // A custom endpoint implies Azure unless told otherwise, which
                // lets other OpenAI-compatible backends opt into bearer auth.
                mode: style === "azure" || style === "openai" ? style : upstream ? "azure" : "openai",
            };

            return {
                define: {
                    "import.meta.env.VITE_OPENAI_PROXY_PATH": JSON.stringify(proxyPath),
                    "import.meta.env.VITE_OPENAI_PROXY_MODE": JSON.stringify(settings.mode),
                    "import.meta.env.VITE_OPENAI_API_VERSION": JSON.stringify(env.OPENAI_API_VERSION?.trim() ?? ""),
                    "import.meta.env.VITE_OPENAI_MODEL": JSON.stringify(env.OPENAI_MODEL?.trim() ?? ""),
                    "import.meta.env.VITE_OPENAI_IMAGE_MODEL": JSON.stringify(env.OPENAI_IMAGE_MODEL?.trim() ?? ""),
                },
            };
        },

        configureServer(server) {
            warnAboutConfig((message) => server.config.logger.warn(message));
            server.middlewares.use(proxyPath, handler);
        },

        configurePreviewServer(server) {
            warnAboutConfig((message) => server.config.logger.warn(message));
            server.middlewares.use(proxyPath, handler);
        },
    };
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {ProxySettings} settings
 */
async function forward(req, res, settings) {
    const apiKey = settings.apiKey;

    if (!apiKey) {
        // 500 is accurate (the server is misconfigured), but the OpenAI SDK
        // retries any 5xx unless told not to, which would turn a config typo
        // into three requests and several seconds of backoff.
        sendJson(
            res,
            500,
            {
                error: {
                    message:
                        "OpenAI proxy is not configured. Set OPENAI_API_KEY (without the VITE_ prefix) in your .env.",
                },
            },
            { "x-should-retry": "false" },
        );
        return;
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once("aborted", abort);
    res.once("close", abort);

    const method = req.method ?? "GET";
    const headers = new Headers();

    for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = req.headers[name];
        if (typeof value === "string") {
            headers.set(name, value);
        }
    }

    if (settings.mode === "azure") {
        headers.set("api-key", apiKey);
    } else {
        headers.set("authorization", `Bearer ${apiKey}`);
    }

    try {
        const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);

        const upstreamResponse = await fetch(`${settings.upstream}${req.url ?? "/"}`, {
            method,
            headers,
            body,
            redirect: "manual",
            signal: controller.signal,
        });

        res.statusCode = upstreamResponse.status;
        for (const name of FORWARDED_RESPONSE_HEADERS) {
            const value = upstreamResponse.headers.get(name);
            if (value) {
                res.setHeader(name, value);
            }
        }

        if (!upstreamResponse.body) {
            res.end();
            return;
        }

        await pipeline(Readable.fromWeb(/** @type {any} */ (upstreamResponse.body)), res);
    } catch (error) {
        if (controller.signal.aborted) {
            res.destroy();
            return;
        }
        sendJson(res, 502, {
            error: { message: `OpenAI proxy request failed: ${/** @type {Error} */ (error).message}` },
        });
    }
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<Buffer | undefined>}
 */
async function readBody(req) {
    /** @type {Buffer[]} */
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 * @param {Record<string, string>} [headers]
 */
function sendJson(res, status, payload, headers = {}) {
    if (res.headersSent) {
        res.destroy();
        return;
    }
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    for (const [name, value] of Object.entries(headers)) {
        res.setHeader(name, value);
    }
    res.end(JSON.stringify(payload));
}
